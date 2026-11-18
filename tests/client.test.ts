import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  ChainIdentityError,
  ExecutionTrackingError,
  SubmissionUnknownError,
  createApolloClient,
  transactionHash,
  type PlaceOrderRequest,
} from '../src/client.js';
import { createAgentSigner, decodeAuth, verifyAgentSignature } from '../src/auth.js';
import { decodeAction, type Action } from '../src/codec.js';
import { NonceAllocator } from '../src/nonce.js';

const seed = new Uint8Array(32).fill(7); // deterministic offline fixture only
const genesis = new Uint8Array(32).fill(3);
const genesisHex = `0x${bytesToHex(genesis)}` as const;
const publicKey = createAgentSigner(seed, 1, 0).publicKey;
const wallet = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const limit: PlaceOrderRequest = {
  market: 'BTC-USD',
  type: 'limit',
  side: 'buy',
  price: '65000',
  size: '0.001',
};
const cancel: Action = { type: 'CancelAll', account: 7, market: 0xffff };
interface Call {
  id: number;
  method: string;
  params: any;
}
function node() {
  const state = {
    genesis: genesisHex as string,
    seq: 6,
    expiry: '0',
    height: '100',
    approved: true,
    lastNonce: '10',
    submit: 'SUBMIT_STATUS_ACCEPTED',
    execution: 'ACTION_STATE_EXECUTED',
    ok: true,
    submitFailure: false,
    trackingFailure: false,
    tamperHash: false,
    key: publicKey,
    calls: [] as Call[],
    statusCalls: 0,
  };
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const call = JSON.parse(String(init?.body)) as Call;
    state.calls.push(call);
    const method = call.method.split('.').at(-1);
    let result: unknown;
    switch (method) {
      case 'GetChainInfo':
        result = {
          chainId: 'sdk-fixture',
          genesisHash: state.genesis,
          executedHeight: state.height,
          blockTimeMs: '100',
        };
        break;
      case 'ListMarkets':
        result = {
          markets: [
            {
              id: 0,
              ticker: 'BTC-USD',
              status: 'MARKET_STATUS_ACTIVE',
              priceExponent: -5,
              atomicResolution: -10,
              quantumConversionExponent: -9,
              stepBaseQuantums: '1000000',
              subticksPerTick: '100000',
              mark: '6500000000',
            },
          ],
        };
        break;
      case 'GetOrderBook':
        result = {
          asks: [{ price: '6500100000', size: '100000000' }],
          bids: [{ price: '6499900000', size: '100000000' }],
        };
        break;
      case 'GetNonce':
        result = { lastNonce: state.lastNonce };
        break;
      case 'GetAgents':
        result = {
          at: { executedHeight: state.height },
          agents: state.approved
            ? [{ slot: 1, seq: state.seq, key: `0x${bytesToHex(state.key)}`, expiry: state.expiry }]
            : [],
        };
        break;
      case 'GetAccount':
        result = { account: '7', owner: wallet.address };
        break;
      case 'Submit': {
        if (state.submitFailure) throw new TypeError('socket closed after send');
        const a = call.params.actions[0];
        const action = decodeAction(hexToBytes(a.action.slice(2)))!;
        const auth = decodeAuth(hexToBytes(a.auth.slice(2)));
        if (action.type === 'ApproveAgent') {
          state.key = action.key;
          state.seq++;
          state.approved = true;
        }
        if (action.type === 'RevokeAgent') state.approved = false;
        result = {
          id: call.params.id,
          statuses: [state.submit],
          transactionHashes: [
            state.submit === 'SUBMIT_STATUS_ACCEPTED'
              ? state.tamperHash
                ? `0x${'00'.repeat(32)}`
                : transactionHash(action, auth)
              : '0x',
          ],
          detail: 'fixture',
        };
        break;
      }
      case 'GetActionStatus': {
        if (state.trackingFailure) throw new TypeError('query unavailable');
        state.statusCalls++;
        result = {
          at: { executedHeight: state.height },
          statuses: call.params.keys.map((key: unknown) => ({
            key,
            state: state.execution,
            height: state.height,
            ok: state.ok,
            reject: state.ok ? '' : 'InsufficientMargin',
            orderId: (key as any).nonce,
            fills: 0,
          })),
        };
        break;
      }
      default:
        throw new Error(`Unexpected method ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  }) as typeof globalThis.fetch;
  const client = createApolloClient({
    baseUrl: 'https://node.example',
    fetch,
    expectedGenesisHash: genesisHex,
    nonceManager: new NonceAllocator({ now: () => 1 }),
  });
  return { state, client, agent: client.agent({ account: 7, seed }), fetch };
}
const submits = (state: ReturnType<typeof node>['state']) =>
  state.calls.filter((c) => c.method.endsWith('.Submit'));

describe('public trading client over HTTP JSON-RPC', () => {
  it('signs 48/78 bytes using the on-chain sequence and tracks execution', async () => {
    const { state, agent } = node();
    const receipt = await agent.placeOrder(limit);
    const wire = submits(state)[0].params.actions[0];
    const action = decodeAction(hexToBytes(wire.action.slice(2)))!;
    const auth = decodeAuth(hexToBytes(wire.auth.slice(2)));
    expect(wire.action).toHaveLength(98);
    expect(wire.auth).toHaveLength(158);
    expect(auth.seq).toBe(6);
    expect(auth.nonce).toBe(1000n);
    expect(verifyAgentSignature(publicKey, genesis, action, auth)).toBe(true);
    expect(action).toMatchObject({ type: 'Place', price: 6_500_000_000n, size: 10_000_000n });
    expect(receipt.prepared.transactionHash).toBe(transactionHash(action, auth));
    expect(receipt.submit.transactionHashes[0]).toHaveLength(32);
    expect(receipt.outcome).toMatchObject({ kind: 'executed', ok: true, orderId: 1000n });
    expect(Object.isFrozen(receipt.prepared)).toBe(true);
  });
  it('prepares without submitting and ignores mutations of the caller seed', async () => {
    const { state, client } = node();
    const input = Uint8Array.from(seed);
    const agent = client.agent({ account: 7, seed: input });
    input.fill(0);
    const prepared = await agent.prepareOrder(limit);
    expect(submits(state)).toHaveLength(0);
    expect(
      verifyAgentSignature(
        publicKey,
        genesis,
        decodeAction(hexToBytes(prepared.action.slice(2)))!,
        decodeAuth(hexToBytes(prepared.auth.slice(2))),
      ),
    ).toBe(true);
  });
  it('derives a market protection price from subticks in the opposite best quote', async () => {
    const { agent } = node();
    const prepared = await agent.prepareOrder({ market: 0, type: 'market', side: 'buy', size: '0.001' });
    expect(decodeAction(hexToBytes(prepared.action.slice(2)))).toMatchObject({
      tif: 'Ioc',
      price: 6_565_200_000n,
    });
  });
  it.each([
    { size: '0.0000001' },
    { size: '0.00101' },
    { price: '65000.1' },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { side: 'BUY' },
    { type: 'typo' },
    { isCross: 'false' },
  ])('rejects invalid intent before sending: %j', async (change) => {
    const { agent, state } = node();
    await expect(agent.prepareOrder({ ...limit, ...change } as PlaceOrderRequest)).rejects.toThrow();
    expect(submits(state)).toHaveLength(0);
  });
  it.each(['missing', 'expired', 'wrong-key'] as const)('refuses %s agent', async (reason) => {
    const { agent, state } = node();
    if (reason === 'missing') state.approved = false;
    if (reason === 'expired') state.expiry = '99';
    if (reason === 'wrong-key') state.key = new Uint8Array(32);
    await expect(agent.prepare(cancel)).rejects.toThrow(/approved|expired/);
    expect(submits(state)).toHaveLength(0);
  });
  it('owner can approve an agent; next order reads its updated sequence', async () => {
    const { client, state, agent } = node();
    state.approved = false;
    const owner = client.owner({ account: 7, signTypedData: (data) => wallet.signTypedData(data) });
    expect((await owner.approveAgent(1, publicKey)).outcome).toMatchObject({ kind: 'executed', ok: true });
    const prepared = await agent.prepare(cancel);
    expect(decodeAuth(hexToBytes(prepared.auth.slice(2))).seq).toBe(7);
    await owner.revokeAgent(1);
    await expect(agent.prepare(cancel)).rejects.toThrow(/approved/);
  });
  it('refuses a wallet belonging to another owner', async () => {
    const { client, state } = node();
    const other = privateKeyToAccount(`0x${'02'.repeat(32)}`);
    await expect(
      client.owner({ account: 7, signTypedData: (data) => other.signTypedData(data) }).prepare(cancel),
    ).rejects.toThrow(/account owner/);
    expect(submits(state)).toHaveLength(0);
  });
  it('shares a nonce allocator across concurrent owner and agent preparations', async () => {
    const { client, agent } = node();
    const owner = client.owner({ account: 7, signTypedData: (data) => wallet.signTypedData(data) });
    const prepared = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? owner.prepare(cancel) : agent.prepare(cancel))),
    );
    expect(new Set(prepared.map((p) => p.nonce)).size).toBe(8);
  });
  it('syncs from a higher chain nonce and refuses reserved order bits', async () => {
    const { state, agent } = node();
    state.lastNonce = (1n << 56n).toString();
    await expect(agent.prepareOrder(limit)).rejects.toThrow(/reserved/);
    expect((await agent.prepare(cancel)).nonce).toBeGreaterThan(1n << 56n);
  });
  it('rejects a different network before signing and a redeploy before submission', async () => {
    const { client, agent, state } = node();
    const prepared = await agent.prepare(cancel);
    state.genesis = `0x${'ff'.repeat(32)}`;
    await expect(client.submitPrepared(prepared)).rejects.toBeInstanceOf(ChainIdentityError);
    await expect(agent.prepare(cancel)).rejects.toBeInstanceOf(ChainIdentityError);
    expect(submits(state)).toHaveLength(0);
  });
  it('pins genesis even without expectedGenesisHash', async () => {
    const { fetch, state } = node();
    const client = createApolloClient({ baseUrl: 'https://n', fetch });
    await client.connect();
    state.genesis = `0x${'ff'.repeat(32)}`;
    await expect(client.connect()).rejects.toBeInstanceOf(ChainIdentityError);
  });
  it('validates prepared metadata and wait options before submitting', async () => {
    const { client, agent, state } = node();
    const prepared = await agent.prepare(cancel);
    await expect(client.submitPrepared({ ...prepared, nonce: 5n })).rejects.toThrow(/metadata/);
    await expect(client.submitPrepared(prepared, { timeoutMs: 0 })).rejects.toThrow(RangeError);
    expect(submits(state)).toHaveLength(0);
  });
  it('distinguishes acceptance, execution rejection, nonce-used and pending', async () => {
    const { state, agent } = node();
    expect((await agent.execute(cancel, { waitForExecution: false })).outcome.kind).toBe('pending');
    state.ok = false;
    expect((await agent.execute(cancel)).outcome).toMatchObject({
      kind: 'executed',
      ok: false,
      reject: 'InsufficientMargin',
    });
    state.execution = 'ACTION_STATE_NONCE_USED';
    expect((await agent.execute(cancel)).outcome.kind).toBe('nonce_used');
    state.execution = 'ACTION_STATE_NOT_FOUND';
    expect((await agent.execute(cancel, { timeoutMs: 25, intervalMs: 2 })).outcome.kind).toBe('pending');
    state.submit = 'SUBMIT_STATUS_BAD_SIGNATURE';
    expect((await agent.execute(cancel)).outcome.kind).toBe('not_submitted');
  });
  it.each(['network', 'hash'] as const)(
    'preserves original signed data on unknown %s result without retry',
    async (reason) => {
      const { agent, state, client } = node();
      const prepared = await agent.prepare(cancel);
      state.submitFailure = reason === 'network';
      state.tamperHash = reason === 'hash';
      const error = await client.submitPrepared(prepared).catch((e) => e);
      expect(error).toBeInstanceOf(SubmissionUnknownError);
      expect(error.prepared).toBe(prepared);
      expect(submits(state)).toHaveLength(1);
    },
  );
  it('keeps acceptance evidence when execution tracking fails', async () => {
    const { agent, state } = node();
    state.trackingFailure = true;
    const error = await agent.execute(cancel).catch((e) => e);
    expect(error).toBeInstanceOf(ExecutionTrackingError);
    expect(error.submit.ok).toBe(true);
    expect(error.prepared.nonce).toBe(1000n);
    expect(submits(state)).toHaveLength(1);
  });
  it('matches the canonical transaction hash vector independently', () => {
    expect(
      transactionHash(
        { type: 'Deposit', address: new Uint8Array(20), amount: 0n },
        { nonce: 0n, key: 0, seq: 0, sig: new Uint8Array(65) },
      ),
    ).toBe('0xfd74664e66f91117552e2b7760281b16a856867321c2d12ee312d887be522a3f');
  });
});
