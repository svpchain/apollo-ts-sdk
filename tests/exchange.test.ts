import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
  Exchange,
  Info,
  ActionAllowanceError,
  ExchangeSubmissionUnknownError,
  ExchangeTrackingError,
  createOwnerKeySigner,
  createWalletSigner,
  createAgentSigner,
  decodeAction,
  decodeAuth,
  verifyAgentSignature,
  transactionHash,
  ChainIdentityError,
  NonceAllocator,
  type CreateOrderRequest,
  type PreparedAction,
  type ExchangeOptions,
  OrderResponse,
} from '../src/index.js';

const seed = new Uint8Array(32).fill(7);
const pubkey = createAgentSigner(seed, 1, 0).publicKey;
const wallet = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const genesis = `0x${'03'.repeat(32)}` as const;
const order: CreateOrderRequest = {
  coin: 'BTC-USD',
  isBuy: true,
  price: '65000',
  size: '0.001',
  orderType: { limit: { tif: 'Gtc' } },
};
const cancel = { type: 'CancelAll', account: 7, market: 0xffff } as const;
function fixture() {
  const state = {
    genesis: genesis as string,
    seq: 6,
    height: '100',
    expiry: '0',
    approved: true,
    key: pubkey,
    owner: wallet.address,
    lastNonce: '10',
    used: '0',
    limit: '10000',
    marketStatus: 'MARKET_STATUS_ACTIVE',
    submits: [] as any[],
    calls: [] as any[],
    statuses: ['SUBMIT_STATUS_ACCEPTED'],
    executions: ['ACTION_STATE_EXECUTED'],
    rejected: [] as number[],
    failSubmit: false,
    failTracking: false,
    wrongHash: false,
    noBook: false,
    onStatus: undefined as (() => void) | undefined,
  };
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const q = JSON.parse(String(init?.body));
    state.calls.push(q);
    let result: any = {};
    switch (q.method.split('.').at(-1)) {
      case 'GetChainInfo':
        result = { genesisHash: state.genesis, executedHeight: state.height, chainId: 'exchange-fixture' };
        break;
      case 'ListMarkets':
        result = {
          markets: [
            {
              id: 0,
              ticker: 'BTC-USD',
              status: state.marketStatus,
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
      case 'GetAccount':
        result = { account: '7', owner: state.owner };
        break;
      case 'GetNonce':
        result = { lastNonce: state.lastNonce };
        break;
      case 'GetAllowance':
        result = { used: state.used, limit: state.limit };
        break;
      case 'GetAgents':
        result = {
          at: { executedHeight: state.height },
          agents: state.approved
            ? [{ slot: 1, seq: state.seq, key: `0x${bytesToHex(state.key)}`, expiry: state.expiry }]
            : [],
        };
        break;
      case 'GetTransaction':
        result = { transactionHash: q.params.transactionHash };
        break;
      case 'GetOrderBook':
        result = state.noBook
          ? {}
          : {
              bids: [{ price: '6499900000', size: '100000000' }],
              asks: [{ price: '6500100000', size: '100000000' }],
            };
        break;
      case 'Submit': {
        state.submits.push(q);
        if (state.failSubmit) throw new TypeError('socket closed after send');
        const statuses = q.params.actions.map(
          (_: unknown, i: number) => state.statuses[i] ?? state.statuses[0],
        );
        const hashes = q.params.actions.map((wire: any, i: number) => {
          const a = decodeAction(hexToBytes(wire.action.slice(2)))!;
          const auth = decodeAuth(hexToBytes(wire.auth.slice(2)));
          if (a.type === 'ApproveAgent') {
            state.approved = true;
            state.seq++;
            state.key = a.key;
          }
          if (a.type === 'RevokeAgent') state.approved = false;
          return statuses[i] === 'SUBMIT_STATUS_ACCEPTED'
            ? state.wrongHash
              ? `0x${'00'.repeat(32)}`
              : transactionHash(a, auth)
            : '0x';
        });
        result = { id: q.params.id, statuses, transactionHashes: hashes };
        break;
      }
      case 'GetActionStatus':
        if (state.failTracking) throw new TypeError('query failed');
        state.onStatus?.();
        result = {
          statuses: q.params.keys.map((key: any, i: number) => ({
            key,
            state: state.executions[i] ?? state.executions[0],
            height: state.height,
            ok: !state.rejected.includes(i),
            reject: state.rejected.includes(i) ? 'InsufficientMargin' : '',
            orderId: key.nonce,
          })),
        };
        break;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
  }) as typeof globalThis.fetch;
  const options: ExchangeOptions = {
    baseUrl: 'https://node.example/rpc?test=1/',
    account: 7,
    signer: { type: 'agent', seed },
    expectedGenesisHash: genesis,
    fetch,
    nonceManager: new NonceAllocator({ now: () => 1 }),
  };
  return { state, options, exchange: new Exchange(options), info: new Info(options), fetch };
}
function decoded(p: PreparedAction) {
  return decodeAction(hexToBytes(p.action.slice(2)));
}

describe('Info / Exchange API aligned with Go', () => {
  it('queries without signing and preserves optional market zero', async () => {
    const { info, state } = fixture();
    await info.meta();
    await info.userState(wallet.address);
    await info.userStateById(7);
    await info.openOrders(7);
    await info.openOrders(7, 0);
    const requests = state.calls.filter((c) => c.method.endsWith('.GetOpenOrders'));
    expect(requests[0].params).toEqual({ account: '7' });
    // Default non-optional numeric serialization may omit 0; optional market must stay present.
    expect(requests[1].params).toEqual({ account: '7', market: 0 });
    expect(state.submits).toHaveLength(0);
    expect(() => info.userState('0x1234')).toThrow();
    expect(() => info.userStateById(1.1)).toThrow();
    await expect(info.transaction('0x1234')).rejects.toThrow();
  });
  it('maps the remaining typed queries to exact methods and fields', async () => {
    const { info, state } = fixture();
    await info.chainInfo();
    await info.market('BTC-USD');
    await info.l2Snapshot(0, 5);
    await info.ticker(0);
    await info.positions(7);
    await info.agents(7);
    await info.nonce(7);
    await info.userRateLimit(7);
    await info.actionStatus([{ account: 7, nonce: 9007199254740993n }]);
    await info.transaction(genesis);
    await info.indexStatus();
    await info.userFills({ account: 7n, market: 0, after: { height: 10n, index: 1 }, limit: 5 });
    await info.historicalOrders({ account: 7n });
    await info.actionHistory({ account: 7n });
    await info.candlesSnapshot({ market: 0, interval: 1, limit: 5 });
    await info.fundingHistory({ market: 0, fromHeight: 10n });
    expect(state.calls.map((q) => q.method.split('.').at(-1))).toEqual([
      'GetChainInfo',
      'ListMarkets',
      'GetOrderBook',
      'GetTicker',
      'GetPositions',
      'GetAgents',
      'GetNonce',
      'GetAllowance',
      'GetActionStatus',
      'GetTransaction',
      'GetIndexStatus',
      'GetFills',
      'GetOrderHistory',
      'GetActionHistory',
      'GetCandles',
      'GetFundingHistory',
    ]);
    expect(state.calls[8].params.keys[0].nonce).toBe('9007199254740993');
    expect(state.calls[11].params.after).toEqual({ height: '10', index: 1 });
  });
  it('places exact units and checks live agent sequence and transaction hash', async () => {
    const { exchange, state } = fixture();
    const result = await exchange.order(order);
    expect(result.successful()).toBe(true);
    expect(result.statuses).toHaveLength(1);
    const p = result.statuses[0].prepared;
    const auth = decodeAuth(hexToBytes(p.auth.slice(2)));
    expect(decoded(p)).toMatchObject({
      type: 'Place',
      price: 6500000000n,
      size: 10000000n,
      tif: 'Gtc',
      position: 'Long',
      isCross: true,
    });
    expect(auth.seq).toBe(6);
    expect(verifyAgentSignature(pubkey, hexToBytes(genesis.slice(2)), decoded(p)!, auth)).toBe(true);
    expect(p.transactionHash).toBe(transactionHash(decoded(p)!, auth));
    expect(state.submits).toHaveLength(1);
  });
  it('makes one bulk Submit with unique nonces and independent statuses', async () => {
    const { exchange, state } = fixture();
    state.statuses = ['SUBMIT_STATUS_ACCEPTED', 'SUBMIT_STATUS_BAD_SIGNATURE', 'SUBMIT_STATUS_ACCEPTED'];
    const result = await exchange.bulkOrders([order, order, order]);
    expect(state.submits).toHaveLength(1);
    expect(state.submits[0].params.actions).toHaveLength(3);
    expect(new Set(result.statuses.map((s) => s.prepared.nonce)).size).toBe(3);
    expect(result.statuses.map((s) => s.outcome.kind)).toEqual(['executed', 'not_submitted', 'executed']);
    expect(result.successful()).toBe(false);
    const keys = state.calls.find((q) => q.method.endsWith('.GetActionStatus')).params.keys;
    expect(keys).toHaveLength(2);
    expect(keys[1].nonce).toBe(result.statuses[2].prepared.nonce.toString());
  });
  it('validates the entire order batch before the first signature or broadcast', async () => {
    const { exchange, state } = fixture();
    await expect(exchange.bulkOrders([order, { ...order, price: '65000.1' }])).rejects.toThrow();
    expect(state.submits).toHaveLength(0);
    expect(state.calls.some((q) => q.method.endsWith('.GetNonce'))).toBe(false);
  });
  it('preflights the full allowance requirement and lets Cancel/CancelAll through', async () => {
    const { exchange, state } = fixture();
    state.used = '9999';
    await expect(exchange.bulkOrders([order, order])).rejects.toBeInstanceOf(ActionAllowanceError);
    state.used = '10000';
    await expect(exchange.order(order)).rejects.toBeInstanceOf(ActionAllowanceError);
    expect((await exchange.cancelAll()).successful()).toBe(true);
    expect(
      (
        await exchange.bulkCancel([
          { coin: 'BTC-USD', orderId: 10n },
          { coin: 'BTC-USD', orderId: 11n },
        ])
      ).successful(),
    ).toBe(true);
    expect(state.submits).toHaveLength(2);
  });
  it.each([
    { size: '0.00101' },
    { size: '0.0000001' },
    { price: '65000.1' },
    { size: 1 as any },
    { isolated: 'false' as any },
    { isBuy: 'true' as any },
    { price: '1e4' },
    { orderType: { limit: { tif: 'invalid' as any } } },
    { orderType: { trigger: { tpsl: 'invalid' as any, isMarket: true, triggerPrice: '60000' } } },
    { orderType: { limit: {}, trigger: { tpsl: 'sl' as const, isMarket: true, triggerPrice: '60000' } } },
  ])('rejects unsafe order input: %j', async (change) => {
    const { exchange, state } = fixture();
    await expect(exchange.order({ ...order, ...change })).rejects.toThrow();
    expect(state.submits).toHaveLength(0);
  });
  it('rejects inactive market before signing', async () => {
    const { exchange, state } = fixture();
    state.marketStatus = 'MARKET_STATUS_CANCEL_ONLY';
    await expect(exchange.order(order)).rejects.toThrow(/active/);
    expect(state.submits).toHaveLength(0);
  });
  it('prepares without broadcasting and refuses a changed genesis before submission', async () => {
    const { exchange, state } = fixture();
    const prepared = await exchange.prepareOrder(order);
    expect(state.submits).toHaveLength(0);
    state.genesis = `0x${'04'.repeat(32)}`;
    await expect(exchange.submitPrepared([prepared])).rejects.toBeInstanceOf(ChainIdentityError);
    expect(state.submits).toHaveLength(0);
  });
  it('detects revoked, changed-sequence and invalid prepared signatures', async () => {
    for (const reason of ['revoked', 'seq', 'hash', 'nonce']) {
      const { exchange, state } = fixture();
      let p = await exchange.prepareOrder(order);
      if (reason === 'revoked') state.approved = false;
      if (reason === 'seq') state.seq++;
      if (reason === 'hash') p = { ...p, transactionHash: `0x${'00'.repeat(32)}` };
      if (reason === 'nonce') p = { ...p, nonce: 0n };
      await expect(exchange.submitPrepared([p])).rejects.toThrow();
      expect(state.submits).toHaveLength(0);
    }
  });
  it('refuses duplicate batch nonces from a broken custom manager', async () => {
    const { options, state } = fixture();
    options.nonceManager = { next: () => 100n, syncFromChain() {} };
    await expect(new Exchange(options).bulkOrders([order, order])).rejects.toThrow(/duplicate|increasing/);
    expect(state.submits).toHaveLength(0);
  });
  it('refuses stale chain nonce from a broken manager', async () => {
    const { options } = fixture();
    options.nonceManager = { next: () => 1n, syncFromChain() {} };
    await expect(new Exchange(options).prepareOrder(order)).rejects.toThrow(/nonce/i);
  });
  it('creates IOC market protection from opposite quote; empty book falls back to mark', async () => {
    const { exchange, state } = fixture();
    const result = await exchange.marketOpen({
      coin: 'BTC-USD',
      isBuy: true,
      size: '0.001',
      slippage: '0.01',
    });
    expect(decoded(result.statuses[0].prepared)).toMatchObject({ tif: 'Ioc', price: 6565200000n });
    state.noBook = true;
    const close = await exchange.marketClose({ coin: 'BTC-USD', position: 'Long', size: '0.001' });
    expect(decoded(close.statuses[0].prepared)).toMatchObject({
      type: 'PlaceWith',
      tif: 'Ioc',
      side: 'Ask',
      price: 6435000000n,
      opts: { reduceOnly: true, position: 'Long' },
    });
  });
  it('constructs stop/take-profit and builder options', async () => {
    const { exchange } = fixture();
    const stop = await exchange.order({
      ...order,
      price: undefined,
      orderType: { trigger: { tpsl: 'sl', isMarket: true, triggerPrice: '60000' } },
      reduceOnly: true,
    });
    expect(decoded(stop.statuses[0].prepared)).toMatchObject({
      type: 'PlaceWith',
      opts: { trigger: { kind: 'StopLoss', price: 6000000000n } },
    });
    const builder = await exchange.order({ ...order, builder: { account: 20, feePpm: 100 } });
    expect(decoded(builder.statuses[0].prepared)).toMatchObject({
      type: 'PlaceWith',
      opts: { builder: { account: 20, feePpm: 100 } },
    });
  });
  it('supports owner local key, wallet callback, authorization and revocation', async () => {
    const { options, state } = fixture();
    const owner = new Exchange({ ...options, signer: createOwnerKeySigner(`0x${'01'.repeat(32)}`) });
    expect((await owner.approveAgent(1, pubkey)).successful()).toBe(true);
    const e = new Exchange({ ...options, signer: createWalletSigner((data) => wallet.signTypedData(data)) });
    expect((await e.cancelAll()).successful()).toBe(true);
    await owner.revokeAgent(1);
    expect(state.approved).toBe(false);
    await expect(new Exchange(options).order(order)).rejects.toThrow(/approved/);
  });
  it('copies local private keys; refuses wrong owner and owner-only action by agent', async () => {
    const { options } = fixture();
    const key = new Uint8Array(32).fill(1);
    const signer = createOwnerKeySigner(key);
    key.fill(2);
    expect((await new Exchange({ ...options, signer }).cancelAll()).successful()).toBe(true);
    await expect(
      new Exchange({ ...options, signer: createOwnerKeySigner(`0x${'02'.repeat(32)}`) }).cancelAll(),
    ).rejects.toThrow(/owner/);
    await expect(new Exchange(options).approveAgent(1, pubkey)).rejects.toThrow(/owner/);
    expect(() => createOwnerKeySigner(new Uint8Array(32))).toThrow();
  });
  it('executes all advanced methods and strictly rejects micro-USD rounding', async () => {
    const { exchange, state } = fixture();
    await exchange.modifyOrder({ coin: 'BTC-USD', orderId: 3n, price: '65000', size: '0.001' });
    await exchange.updateLeverage('BTC-USD', '5');
    await exchange.updateIsolatedMargin('BTC-USD', 'Long', '10');
    await exchange.twapOrder({ coin: 'BTC-USD', isBuy: true, size: '0.01', durationS: 600, intervalS: 60 });
    await exchange.scaledOrder({
      coin: 'BTC-USD',
      isBuy: true,
      size: '0.01',
      lowestPrice: '64000',
      highestPrice: '65000',
      numOrders: 10,
    });
    const kinds = state.submits.map(
      (q) => decodeAction(hexToBytes(q.params.actions[0].action.slice(2)))?.type,
    );
    expect(kinds).toEqual(['Modify', 'SetLeverage', 'UpdateIsolatedMargin', 'PlaceTwap', 'PlaceScaled']);
    await expect(exchange.updateIsolatedMargin('BTC-USD', 'Long', '0.0000001')).rejects.toThrow(/micro/);
    await expect(exchange.updateLeverage('BTC-USD', '0.5')).rejects.toThrow(/leverage/);
  });
  it('returns accepted-pending, execution rejection and nonce-used distinctly', async () => {
    const { exchange, state } = fixture();
    expect((await exchange.order(order, { waitForExecution: false })).statuses[0].outcome.kind).toBe(
      'pending',
    );
    state.rejected = [0];
    let result = await exchange.order(order);
    expect(result.statuses[0].error).toBe('InsufficientMargin');
    expect(result.successful()).toBe(false);
    state.rejected = [];
    state.executions = ['ACTION_STATE_NONCE_USED'];
    result = await exchange.order(order);
    expect(result.statuses[0].outcome.kind).toBe('nonce_used');
    expect(result.successful()).toBe(false);
    state.executions = ['ACTION_STATE_NOT_FOUND'];
    result = await exchange.order(order, { timeoutMs: 25, intervalMs: 2 });
    expect(result.statuses[0].outcome.kind).toBe('pending');
  });
  it.each(['network', 'hash', 'status'])(
    'retains complete batch on unknown %s result and never retries',
    async (reason) => {
      const { exchange, state } = fixture();
      const p = await exchange.prepareOrder(order);
      state.failSubmit = reason === 'network';
      state.wrongHash = reason === 'hash';
      if (reason === 'status') state.statuses = ['SUBMIT_STATUS_UNSPECIFIED'];
      const err = await exchange.submitPrepared([p]).catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeSubmissionUnknownError);
      expect(err.prepared[0]).toEqual(p);
      expect(state.submits).toHaveLength(1);
    },
  );
  it('retains acceptance evidence if tracking fails or caller cancels', async () => {
    for (const reason of ['query', 'abort']) {
      const { exchange, state } = fixture();
      const controller = new AbortController();
      state.failTracking = reason === 'query';
      if (reason === 'abort') state.onStatus = () => controller.abort(new Error('caller stopped'));
      state.executions = ['ACTION_STATE_NOT_FOUND'];
      const err = await exchange.bulkOrders([order, order], { signal: controller.signal }).catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeTrackingError);
      expect(err.response.statuses.every((s: any) => s.submitStatus === 'accepted')).toBe(true);
      expect(state.submits).toHaveLength(1);
    }
  });
  it('shares owner/agent nonces within Info.client and when explicitly injecting a manager', async () => {
    const { options } = fixture();
    const shared = new NonceAllocator({ now: () => 1 });
    const a = new Exchange({ ...options, nonceManager: shared });
    const o = new Exchange({
      ...options,
      nonceManager: shared,
      signer: createOwnerKeySigner(`0x${'01'.repeat(32)}`),
    });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : o).prepare(cancel)));
    expect(new Set(results.map((p) => p.nonce)).size).toBe(8);
  });
  it('validates wait options and already-cancelled requests without broadcast', async () => {
    const { exchange, state } = fixture();
    await expect(exchange.order(order, { timeoutMs: 0 })).rejects.toThrow();
    await expect(exchange.cancelAll('', { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(state.submits).toHaveLength(0);
  });
  it('splits tracking requests at the 10000-key protocol limit', async () => {
    const { exchange, state } = fixture();
    const statuses = Array.from({ length: 10001 }, (_, i) => ({
      prepared: { account: 7, nonce: BigInt(i + 1) } as PreparedAction,
      submitStatus: 'accepted' as const,
      outcome: { kind: 'pending' as const },
    }));
    const submit = { id: 1n, ok: true, outcomes: [], transactionHashes: [] };
    const response = new OrderResponse(1n, statuses, submit);
    const result = await (
      exchange as unknown as { track(r: OrderResponse, o: object): Promise<OrderResponse> }
    ).track(response, { timeoutMs: 5000 });
    expect(result.successful()).toBe(true);
    expect(
      state.calls.filter((q) => q.method.endsWith('.GetActionStatus')).map((q) => q.params.keys.length),
    ).toEqual([10000, 1]);
  });
  it('detects an invalid signature even if caller recomputes its canonical hash', async () => {
    const { exchange, state } = fixture();
    const p = await exchange.prepareOrder(order);
    const auth = decodeAuth(hexToBytes(p.auth.slice(2)));
    auth.sig[0] ^= 255;
    const { encodeAuth } = await import('../src/auth.js');
    const bad = {
      ...p,
      auth: `0x${bytesToHex(encodeAuth(auth))}` as const,
      transactionHash: transactionHash(decoded(p)!, auth),
    };
    await expect(exchange.submitPrepared([bad])).rejects.toThrow(/signature/);
    expect(state.submits).toHaveLength(0);
  });

  it('rejects agent signatures on owner-only actions before broadcast', async () => {
    const { exchange, state } = fixture();
    const prepared = await exchange.prepareOrder(order);
    const { encodeAuth, agentMessage } = await import('../src/auth.js');
    const { encodeAction } = await import('../src/codec.js');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const action = { type: 'RevokeAgent', account: 7, slot: 2 } as const;
    const auth = decodeAuth(hexToBytes(prepared.auth.slice(2)));
    auth.sig.set(
      ed25519.sign(agentMessage(hexToBytes(genesis.slice(2)), action, auth.nonce, auth.key, auth.seq), seed),
    );
    const forged = {
      ...prepared,
      action: `0x${bytesToHex(encodeAction(action))}` as const,
      auth: `0x${bytesToHex(encodeAuth(auth))}` as const,
      transactionHash: transactionHash(action, auth),
    };
    await expect(exchange.submitPrepared([forged])).rejects.toThrow(/owner/);
    expect(state.submits).toHaveLength(0);
  });
  it('submits bulk modifications once with exact IDs and per-item results', async () => {
    const { exchange, state } = fixture();
    state.statuses = ['SUBMIT_STATUS_ACCEPTED', 'SUBMIT_STATUS_BAD_SIGNATURE'];
    const response = await exchange.bulkModify([
      { coin: 'BTC-USD', orderId: 9007199254740993n, price: '65100', size: '0.001' },
      { coin: 'BTC-USD', orderId: 9007199254740994n, price: '65200', size: '0.002' },
    ]);
    expect(state.submits).toHaveLength(1);
    expect(response.statuses.map((s) => decoded(s.prepared))).toMatchObject([
      { type: 'Modify', market: 0, orderId: 9007199254740993n, price: 6510000000n, size: 10000000n },
      { type: 'Modify', market: 0, orderId: 9007199254740994n, price: 6520000000n, size: 20000000n },
    ]);
    expect(response.statuses.map((s) => s.outcome.kind)).toEqual(['executed', 'not_submitted']);
    expect(response.successful()).toBe(false);
    expect(new Set(response.statuses.map((s) => s.prepared.nonce)).size).toBe(2);
  });
  it('rejects an invalid modification batch before signing any item', async () => {
    const { exchange, state } = fixture();
    await expect(
      exchange.bulkModify([
        { coin: 'BTC-USD', orderId: 1n, price: '65100', size: '0.001' },
        { coin: 'BTC-USD', orderId: 2n, price: '65100.1', size: '0.001' },
      ]),
    ).rejects.toThrow(/tick/);
    expect(state.submits).toHaveLength(0);
    expect(state.calls.some((q) => q.method.endsWith('.GetNonce'))).toBe(false);
    await expect(exchange.bulkModify([])).rejects.toThrow(/items/);
    state.marketStatus = 'MARKET_STATUS_PAUSED';
    await expect(
      exchange.modifyOrder({ coin: 'BTC-USD', orderId: 1n, price: '65100', size: '0.001' }),
    ).rejects.toThrow(/active/);
  });
  it('checks the whole modification batch against action allowance', async () => {
    const { exchange, state } = fixture();
    state.used = '9999';
    await expect(
      exchange.bulkModify([
        { coin: 'BTC-USD', orderId: 1n, price: '65100', size: '0.001' },
        { coin: 'BTC-USD', orderId: 2n, price: '65200', size: '0.001' },
      ]),
    ).rejects.toBeInstanceOf(ActionAllowanceError);
    expect(state.submits).toHaveLength(0);
  });
  it('cancels a TWAP parent with the existing exempt Cancel action', async () => {
    const { exchange, state } = fixture();
    state.used = '10000';
    const response = await exchange.cancelTwap({ coin: 'BTC-USD', orderId: 9007199254740993n });
    expect(decoded(response.statuses[0].prepared)).toEqual({
      type: 'Cancel',
      account: 7,
      market: 0,
      orderId: 9007199254740993n,
    });
    expect(response.successful()).toBe(true);
    expect(state.submits).toHaveLength(1);
    expect(state.calls.some((q) => q.method.endsWith('.GetAllowance'))).toBe(false);
  });
});
