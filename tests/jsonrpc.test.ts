import { type JsonObject, create, toJson } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import { AccountService } from '../src/gen/apollo/v1/account_pb.js';
import { ChainService } from '../src/gen/apollo/v1/chain_pb.js';
import { SubmitResponseSchema, TxService } from '../src/gen/apollo/v1/tx_pb.js';
import { connectCodeFromJsonRpc, createApolloJsonRpcTransport, rewriteBytes } from '../src/jsonrpc.js';
import { createApolloTransport, inferApolloRpcProtocol } from '../src/transport.js';

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** 假节点：记录请求，按 `respond` 回应（可以是 JSON 值、Response 或抛错）。 */
function fakeNode(respond: (captured: Captured) => unknown) {
  const calls: Captured[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const captured: Captured = {
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(captured);
    const out = respond(captured);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch };
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

describe('createApolloJsonRpcTransport', () => {
  it('一元调用 POST 到 baseUrl 本身，method 为 package.Service.Method，请求头只有 content-type', async () => {
    const node = fakeNode(({ body }) =>
      ok(body.id, {
        chainId: 'apollo-testnet-1',
        genesisHash: '0x9cab',
        executedHeight: '78618',
        role: 'NODE_ROLE_ARCHIVE',
      }),
    );
    const transport = createApolloJsonRpcTransport({
      baseUrl: 'https://node.example/',
      fetch: node.fetch,
    });
    const chain = createClient(ChainService, transport);

    const info = await chain.getChainInfo({});

    expect(node.calls).toHaveLength(1);
    const [call] = node.calls;
    expect(call.url).toBe('https://node.example/');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(call.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'apollo.v1.ChainService.GetChainInfo',
      params: {},
    });
    expect(typeof call.body.id).toBe('number');
    expect(info.chainId).toBe('apollo-testnet-1');
    expect(info.executedHeight).toBe(78618n);
    // 节点的 bytes 是 0x 十六进制，解析成真正的字节。
    expect(Array.from(info.genesisHash)).toEqual([0x9c, 0xab]);
  });

  it('请求里的 bytes 以 0x 十六进制发出（oneof 里的 owner、Submit 的 action/auth）', async () => {
    const node = fakeNode(({ body }) => ok(body.id, {}));
    const transport = createApolloJsonRpcTransport({ baseUrl: 'https://n', fetch: node.fetch });

    await createClient(AccountService, transport).getAccount({
      by: { case: 'owner', value: new Uint8Array([0x7f, 0xc1, 0x81]) },
    });
    await createClient(TxService, transport).submit({
      id: 5n,
      actions: [{ action: new Uint8Array([1, 2, 255]), auth: new Uint8Array([0]) }],
    });

    expect(node.calls[0].body.method).toBe('apollo.v1.AccountService.GetAccount');
    expect(node.calls[0].body.params).toEqual({ owner: '0x7fc181' });
    expect(node.calls[1].body.params).toEqual({ id: '5', actions: [{ action: '0x0102ff', auth: '0x00' }] });
  });

  it('响应里嵌套 / 列表位置的 bytes 也按描述符转换；未知字段忽略', async () => {
    const node = fakeNode(({ body }) =>
      ok(body.id, {
        at: { executedHeight: '5' },
        agents: [
          { slot: 1, key: '0x01', seq: 9, expiry: '0' },
          { slot: 2, key: '0x0203', seq: 1, expiry: '7' },
        ],
        somethingNew: 1,
      }),
    );
    const transport = createApolloJsonRpcTransport({ baseUrl: 'https://n', fetch: node.fetch });

    const res = await createClient(AccountService, transport).getAgents({ account: 1n });

    expect(res.at?.executedHeight).toBe(5n);
    expect(res.agents.map((a) => Array.from(a.key))).toEqual([[1], [2, 3]]);
    expect(res.agents[0].seq).toBe(9);
    expect(res.agents[1].expiry).toBe(7n);
  });

  it('JSON-RPC error 映射为 ConnectError：-32004 → NotFound、-32601 → Unimplemented、-32602 → InvalidArgument', async () => {
    const codes = [-32004, -32601, -32602, -32002, -32003, -32005, -32603, -32000, -32700];
    let index = 0;
    const node = fakeNode(({ body }) => fail(body.id, codes[index++], `boom ${index}`));
    const transport = createApolloJsonRpcTransport({ baseUrl: 'https://n', fetch: node.fetch });
    const chain = createClient(ChainService, transport);

    const seen: Code[] = [];
    for (let i = 0; i < codes.length; i++) {
      try {
        await chain.getChainInfo({});
        throw new Error('应当失败');
      } catch (error) {
        expect(error).toBeInstanceOf(ConnectError);
        seen.push((error as ConnectError).code);
        expect((error as ConnectError).rawMessage).toBe(`boom ${i + 1}`);
      }
    }
    expect(seen).toEqual([
      Code.NotFound,
      Code.Unimplemented,
      Code.InvalidArgument,
      Code.FailedPrecondition,
      Code.Unavailable,
      Code.ResourceExhausted,
      Code.Internal,
      Code.Unknown,
      Code.Internal,
    ]);
    expect(connectCodeFromJsonRpc(12345)).toBe(Code.Unknown);
    expect(connectCodeFromJsonRpc('x')).toBe(Code.Unknown);
  });

  it('fetch 抛错 → Unavailable；HTTP 429 → ResourceExhausted；HTTP 502 → Unavailable；非 JSON → Internal', async () => {
    const expectCode = async (fetch: typeof globalThis.fetch, code: Code) => {
      const transport = createApolloJsonRpcTransport({ baseUrl: 'https://n', fetch });
      await expect(createClient(ChainService, transport).getChainInfo({})).rejects.toMatchObject({ code });
    };
    await expectCode(async () => {
      throw new TypeError('Failed to fetch');
    }, Code.Unavailable);
    await expectCode(async () => new Response('slow down', { status: 429 }), Code.ResourceExhausted);
    await expectCode(async () => new Response('bad gateway', { status: 502 }), Code.Unavailable);
    await expectCode(async () => new Response('<html>', { status: 200 }), Code.Internal);
  });

  it('响应 id 与请求不一致时报 Internal，而不是把别人的结果当自己的', async () => {
    const node = fakeNode(() => ok(-1, {}));
    const transport = createApolloJsonRpcTransport({ baseUrl: 'https://n', fetch: node.fetch });
    await expect(createClient(ChainService, transport).getChainInfo({})).rejects.toMatchObject({
      code: Code.Internal,
    });
  });

  it('超时：timeoutMs 内没响应 → DeadlineExceeded，并取消 fetch；外部 signal 取消 → Canceled', async () => {
    let aborted: AbortSignal | undefined;
    const hang: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        aborted = init?.signal ?? undefined;
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const transport = createApolloJsonRpcTransport({
      baseUrl: 'https://n',
      fetch: hang,
      defaultTimeoutMs: 20,
    });
    const chain = createClient(ChainService, transport);

    await expect(chain.getChainInfo({})).rejects.toMatchObject({ code: Code.DeadlineExceeded });
    expect(aborted?.aborted).toBe(true);

    const controller = new AbortController();
    const pending = chain.getChainInfo({}, { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: Code.Canceled });
  });

  it('流式方法直接 Unimplemented，不发请求', async () => {
    const node = fakeNode(() => {
      throw new Error('不应被调用');
    });
    const transport = createApolloJsonRpcTransport({ baseUrl: 'https://n', fetch: node.fetch });
    const method = { name: 'Watch', parent: { typeName: 'apollo.v1.Example' }, methodKind: 'server_streaming' };
    await expect(
      transport.stream(method as never, undefined, undefined, undefined, (async function* () {})(), undefined),
    ).rejects.toMatchObject({ code: Code.Unimplemented });
    expect(node.calls).toHaveLength(0);
  });
});

describe('rewriteBytes', () => {
  it('只改 bytes 字段，string 字段里形似十六进制的值不动；不合法的十六进制原样保留', () => {
    const value = toJson(
      SubmitResponseSchema,
      create(SubmitResponseSchema, { transactionHashes: [new Uint8Array([1])], id: 2n, detail: '0x0a' }),
    ) as JsonObject;
    // base64 → 0x
    rewriteBytes(SubmitResponseSchema, value, (text) => `hex:${text}`);
    expect(value.transactionHashes).toEqual(['hex:AQ==']);
    expect(value.id).toBe('2');
    expect(value.detail).toBe('0x0a');

    const fromNode: JsonObject = { transactionHashes: ['0xzz', '0x0a'], id: '1' };
    rewriteBytes(SubmitResponseSchema, fromNode, (text) => (text === '0x0a' ? 'Cg==' : text));
    expect(fromNode.transactionHashes).toEqual(['0xzz', 'Cg==']);
  });
});

describe('JSON-RPC only transport', () => {
  it('rejects app-relative gateways and non-HTTP URLs', () => {
    expect(inferApolloRpcProtocol('https://node.example')).toBe('jsonrpc');
    expect(() => createApolloTransport({ baseUrl: '/rpc' })).toThrow();
    expect(() => createApolloTransport({ baseUrl: 'file:///tmp/socket' })).toThrow();
    expect(typeof createApolloTransport({ baseUrl: 'https://node.example' }).unary).toBe('function');
  });
});
