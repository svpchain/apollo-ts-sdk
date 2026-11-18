import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { Code } from '@connectrpc/connect';
import {
  createApolloClients,
  getActionOutcomes,
  interpretSubmitResponse,
  submitActions,
  waitForAction,
} from '../src/transport.js';
import { encodeAction, type Action } from '../src/codec.js';
import { encodeAuth, type Auth } from '../src/auth.js';
import { SubmitResponseSchema } from '../src/gen/apollo/v1/tx_pb.js';

const action: Action = {
  type: 'Place',
  account: 7,
  market: 0,
  price: 1n,
  size: 1n,
  side: 'Bid',
  tif: 'Gtc',
  position: 'Long',
  isCross: true,
};
const auth: Auth = { nonce: 1n, key: 0, seq: 0, sig: new Uint8Array(65) };
function clients(
  reply: (request: any) => unknown,
  limits: { maxRequestBytes?: number; maxResponseBytes?: number } = {},
) {
  let calls = 0;
  const rpc = createApolloClients({
    baseUrl: 'https://n',
    ...limits,
    fetch: async (_input, init) => {
      calls++;
      return new Response(JSON.stringify(reply(JSON.parse(String(init?.body)))));
    },
  });
  return { rpc, count: () => calls };
}
describe('protocol boundaries', () => {
  it.each([{ side: 'not-a-side' }, { tif: 'not-a-tif' }, { position: 'Bothh' }, { isCross: 1 }])(
    'does not silently encode unknown enum or flag %j',
    (change) => {
      expect(() => encodeAction({ ...action, ...change } as Action)).toThrow();
    },
  );
  it('validates the auth slot before narrowing to u8', () => {
    expect(() => encodeAuth({ ...auth, key: 257 as Auth['key'] })).toThrow();
  });
  it.each([
    (r: any) => ({ jsonrpc: '1.0', id: r.id, result: {} }),
    (r: any) => ({ jsonrpc: '2.0', id: r.id }),
    (r: any) => ({ jsonrpc: '2.0', id: r.id, result: {}, error: { code: -32003 } }),
  ])('rejects ambiguous or incomplete response envelopes', async (reply) => {
    await expect(clients(reply).rpc.chain.getChainInfo({})).rejects.toMatchObject({ code: Code.Internal });
  });
  it('bounds requests before sending and responses while reading', async () => {
    const req = clients((r) => ({ jsonrpc: '2.0', id: r.id, result: {} }), { maxRequestBytes: 4 });
    await expect(req.rpc.chain.getChainInfo({})).rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect(req.count()).toBe(0);
    const res = clients((r) => ({ jsonrpc: '2.0', id: r.id, result: { nodeName: 'x'.repeat(5000) } }), {
      maxResponseBytes: 64,
    });
    await expect(res.rpc.chain.getChainInfo({})).rejects.toMatchObject({ code: Code.ResourceExhausted });
  });
  it('does not send an already canceled request', async () => {
    const mock = clients((r) => ({ jsonrpc: '2.0', id: r.id, result: {} }));
    await expect(mock.rpc.chain.getChainInfo({}, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: Code.Canceled,
    });
    expect(mock.count()).toBe(0);
  });
  it('rejects mismatching submit item counts and hash counts', async () => {
    for (const result of [
      { statuses: [] },
      { statuses: ['SUBMIT_STATUS_ACCEPTED'], transactionHashes: ['0x', '0x'] },
    ]) {
      const mock = clients((r) => ({ jsonrpc: '2.0', id: r.id, result: { id: r.params.id, ...result } }));
      await expect(submitActions(mock.rpc, [{ action, auth }])).rejects.toMatchObject({
        code: Code.Internal,
      });
    }
  });
  it('rejects an unspecified status instead of reporting a definitive rejection', () => {
    expect(() => interpretSubmitResponse(create(SubmitResponseSchema, { id: 1n, statuses: [0] }))).toThrow();
  });
  it('requires requested account and nonce in status responses', async () => {
    const mock = clients((r) => ({
      jsonrpc: '2.0',
      id: r.id,
      result: { statuses: [{ key: { account: '8', nonce: '1' }, state: 'ACTION_STATE_EXECUTED', ok: true }] },
    }));
    await expect(getActionOutcomes(mock.rpc, [{ account: 7, nonce: 1n }])).rejects.toMatchObject({
      code: Code.Internal,
    });
  });
  it('caller cancellation is not reported as pending', async () => {
    const mock = clients((r) => ({
      jsonrpc: '2.0',
      id: r.id,
      result: { statuses: r.params.keys.map((key: unknown) => ({ key, state: 'ACTION_STATE_NOT_FOUND' })) },
    }));
    const controller = new AbortController();
    const pending = waitForAction(
      mock.rpc,
      { account: 7, nonce: 1n },
      { signal: controller.signal, intervalMs: 100, timeoutMs: 500 },
    );
    controller.abort(new Error('caller stopped'));
    await expect(pending).rejects.toThrow('caller stopped');
  });
});
