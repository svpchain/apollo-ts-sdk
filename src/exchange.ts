import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Info } from './info.js';
import { createWalletSigner, type ExchangeSigner } from './signers.js';
import {
  type ApolloClientOptions,
  type PreparedAction,
  type SubmitOptions,
  type RequestOptions,
  type TradingAccount,
  type TradingAction,
  type Hex,
  ChainIdentityError,
  marketUnits,
  transactionHash,
} from './client.js';
import { agentMay, decodeAction, encodeAction, type BuilderCode, type Tif } from './codec.js';
import { decodeAuth, encodeAuth, ownerDigest, recoverOwner, strip0x, verifyAgentSignature } from './auth.js';
import {
  getActionOutcomes,
  submitActions,
  type ActionOutcome,
  type SubmitOutcome,
  type SubmitResult,
} from './transport.js';
import {
  type PlaceIntent,
  buildPlaceAction,
  buildCancelAction,
  buildModifyAction,
  buildSetLeverageAction,
  buildUpdateIsolatedMarginAction,
  buildTwapAction,
  buildScaledAction,
} from './orders.js';
import {
  isPriceOnTick,
  sizeToQuantums,
  quantumsToSize,
  subticksToPrice,
  priceUnitsToPrice,
  leverageToImfPpm,
} from './units.js';
import { Decimal } from 'decimal.js';
import { MarketStatus, type Market } from './gen/apollo/v1/market_pb.js';

export interface ExchangeOptions extends ApolloClientOptions {
  account: number;
  signer: ExchangeSigner;
}
export interface ExchangeOrderType {
  limit?: { tif?: Tif };
  trigger?: { triggerPrice: string; isMarket: boolean; tpsl: 'tp' | 'sl' };
}
export interface CreateOrderRequest {
  coin: string;
  isBuy: boolean;
  price?: string;
  size: string;
  orderType?: ExchangeOrderType;
  reduceOnly?: boolean;
  position?: 'Long' | 'Short';
  isolated?: boolean;
  goodTilBlock?: bigint;
  builder?: BuilderCode;
  referencePrice?: string;
  slippage?: string;
}
export interface CancelOrderRequest {
  coin: string;
  orderId: bigint;
}
export interface ModifyOrderRequest extends CancelOrderRequest {
  price: string;
  size: string;
}
export interface MarketOrderRequest
  extends Omit<CreateOrderRequest, 'price' | 'orderType' | 'builder' | 'goodTilBlock'> {}
export interface ClosePositionRequest extends Omit<MarketOrderRequest, 'isBuy' | 'reduceOnly'> {
  position: 'Long' | 'Short';
}
export interface CreateTwapOrderRequest {
  coin: string;
  isBuy: boolean;
  size: string;
  price?: string;
  durationS: number;
  intervalS: number;
  tolerancePpm?: number;
  position?: 'Long' | 'Short';
  reduceOnly?: boolean;
  isolated?: boolean;
}
export interface CreateScaledOrderRequest {
  coin: string;
  isBuy: boolean;
  size: string;
  lowestPrice: string;
  highestPrice: string;
  numOrders: number;
  profile?: 'Equal' | 'IncRatio' | 'IncDiff' | 'DecRatio' | 'DecDiff';
  spacing?: 'Linear' | 'Geometric';
  magnitudePpm?: number;
  tif?: 'Gtc' | 'Ioc';
  position?: 'Long' | 'Short';
  reduceOnly?: boolean;
  isolated?: boolean;
  goodTilBlock?: bigint;
}
export interface OrderStatus {
  prepared: PreparedAction;
  submitStatus: SubmitOutcome['kind'];
  outcome: ActionOutcome | { kind: 'not_submitted' };
  error?: string;
}
export class OrderResponse {
  constructor(
    readonly id: bigint,
    readonly statuses: OrderStatus[],
    readonly submit: SubmitResult,
  ) {}
  successful(): boolean {
    return (
      this.statuses.length > 0 && this.statuses.every((s) => s.outcome.kind === 'executed' && s.outcome.ok)
    );
  }
}
export class ActionAllowanceError extends Error {
  constructor(
    readonly used: bigint,
    readonly limit: bigint,
    readonly required: number,
  ) {
    super(`Account action allowance is insufficient: used=${used}, limit=${limit}, required=${required}`);
    this.name = 'ActionAllowanceError';
  }
}
export class ExchangeSubmissionUnknownError extends Error {
  constructor(
    readonly prepared: readonly PreparedAction[],
    cause: unknown,
  ) {
    super('Submission result is unknown; reconcile original account/nonce before retrying', { cause });
    this.name = 'ExchangeSubmissionUnknownError';
  }
}
export class ExchangeTrackingError extends Error {
  constructor(
    readonly response: OrderResponse,
    cause: unknown,
  ) {
    super('Actions were accepted, but execution tracking failed; reconcile original account/nonce', {
      cause,
    });
    this.name = 'ExchangeTrackingError';
  }
}
const ExactDecimal = Decimal.clone({ precision: 80 });
const tifMap = { Gtc: 'gtc', Ioc: 'ioc', PostOnly: 'post_only' } as const;
const hex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}`;

/** Field-based trading API aligned with Apollo Go's Exchange. No automatic Submit retries. */
export class Exchange {
  readonly info: Info;
  readonly account: number;
  private readonly trader: TradingAccount;
  private readonly slot: number;
  constructor(options: ExchangeOptions) {
    if (!Number.isInteger(options.account) || options.account < 1 || options.account > 0xffff_ffff)
      throw new RangeError('account must be a non-vault u32');
    if (!options.signer || !['owner', 'agent'].includes(options.signer.type))
      throw new TypeError('owner or agent signer is required');
    this.info = new Info(options);
    this.account = options.account;
    this.slot = options.signer.type === 'agent' ? (options.signer.slot ?? 1) : 0;
    if (options.signer.type === 'owner') createWalletSigner(options.signer.signTypedData);
    this.trader =
      options.signer.type === 'agent'
        ? this.info.client.agent({
            account: options.account,
            seed: options.signer.seed,
            slot: options.signer.slot,
          })
        : this.info.client.owner({ account: options.account, signTypedData: options.signer.signTypedData });
  }
  connect(options: RequestOptions = {}) {
    return this.info.client.connect(options);
  }
  async prepare(action: TradingAction, options: RequestOptions = {}): Promise<PreparedAction> {
    return (await this.prepareActions([action], options))[0];
  }
  async prepareActions(
    actions: readonly TradingAction[],
    options: RequestOptions = {},
  ): Promise<PreparedAction[]> {
    checkCount(actions.length);
    // Copy/canonicalize all actions before asynchronous wallet prompts.
    const copy = actions.map((a) => {
      if (a.account !== this.account) throw new TypeError('Action account mismatch');
      const decoded = decodeAction(encodeAction(a));
      if (!decoded || ['Deposit', 'Withdraw', 'Stake', 'Unstake'].includes(decoded.type))
        throw new TypeError('Unsupported trading action');
      return decoded as TradingAction;
    });
    const required = copy.filter((a) => a.type !== 'Cancel' && a.type !== 'CancelAll').length;
    if (required) {
      const allowance = await this.info.userRateLimit(this.account, options);
      if (allowance.used > allowance.limit || allowance.limit - allowance.used < BigInt(required))
        throw new ActionAllowanceError(allowance.used, allowance.limit, required);
    }
    await this.connect(options);
    const nonceState = await this.info.nonce(this.account, options);
    let lastNonce = nonceState.lastNonce;
    const prepared: PreparedAction[] = [];
    for (const action of copy) {
      const p = await this.trader.prepare(action, options);
      if (p.nonce <= lastNonce)
        throw new TypeError('Nonce manager returned duplicate or non-increasing batch nonces');
      prepared.push(p);
      lastNonce = p.nonce;
    }
    return prepared;
  }
  async execute(action: TradingAction, options: SubmitOptions = {}) {
    return this.executeActions([action], options);
  }
  async executeActions(actions: readonly TradingAction[], options: SubmitOptions = {}) {
    validateOptions(options);
    return this.submitPrepared(await this.prepareActions(actions, options), options);
  }
  async prepareOrder(request: CreateOrderRequest, options: RequestOptions = {}) {
    const actions = await this.orderActions([request], options);
    return this.prepare(actions[0], options);
  }
  order(request: CreateOrderRequest, options: SubmitOptions = {}) {
    return this.bulkOrders([request], options);
  }
  async bulkOrders(requests: readonly CreateOrderRequest[], options: SubmitOptions = {}) {
    validateOptions(options);
    return this.executeActions(await this.orderActions(requests, options), options);
  }
  private async orderActions(
    requests: readonly CreateOrderRequest[],
    options: RequestOptions,
  ): Promise<TradingAction[]> {
    checkCount(requests.length);
    // Do not retain mutable caller-owned nested orderType or builder references across IO.
    requests = structuredClone(requests);
    const meta = await this.info.meta(options);
    const actions: TradingAction[] = [];
    for (const request of requests) {
      assertRequest(request);
      const market = findMarket(meta.markets, request.coin);
      if (market.status !== MarketStatus.ACTIVE) throw new TypeError('Market is not active');
      const trigger = request.orderType?.trigger;
      let referencePrice = request.referencePrice;
      if (trigger?.isMarket && referencePrice === undefined)
        referencePrice = await this.reference(market, request.isBuy, options);
      const units = marketUnits(market);
      assertSize(request.size, market);
      if (request.price !== undefined && !isPriceOnTick(request.price, units))
        throw new RangeError('Price is off tick');
      if (trigger && !isPriceOnTick(trigger.triggerPrice, units))
        throw new RangeError('Trigger price is off tick');
      const type: PlaceIntent['type'] = trigger
        ? trigger.tpsl === 'tp'
          ? trigger.isMarket
            ? 'take_profit_market'
            : 'take_profit_limit'
          : trigger.isMarket
            ? 'stop_market'
            : 'stop_limit'
        : 'limit';
      const action = buildPlaceAction({
        account: this.account,
        market: units,
        side: request.isBuy ? 'buy' : 'sell',
        type,
        size: request.size,
        price: request.price,
        triggerPrice: trigger?.triggerPrice,
        referencePrice,
        slippage: slippage(request.slippage),
        tif: trigger?.isMarket ? 'ioc' : tifMap[request.orderType?.limit?.tif ?? 'Gtc'],
        reduceOnly: request.reduceOnly,
        isCross: !(request.isolated ?? false),
        position: request.position,
        goodTilBlock: request.goodTilBlock,
      });
      if (request.builder) {
        if (action.type === 'Place')
          actions.push({
            ...action,
            type: 'PlaceWith',
            opts: {
              reduceOnly: false,
              goodTilBlock: 0n,
              position: action.position,
              isCross: action.isCross,
              builder: request.builder,
            },
          });
        else if (action.type === 'PlaceWith')
          actions.push({ ...action, opts: { ...action.opts, builder: request.builder } });
        else throw new TypeError('Unsupported builder order');
      } else actions.push(action);
    }
    return actions;
  }
  private async reference(market: Market, isBuy: boolean, options: RequestOptions): Promise<string> {
    const book = await this.info.l2Snapshot(market.id, 1, options);
    const touch = (isBuy ? book.asks : book.bids)[0];
    return touch
      ? subticksToPrice(touch.price, marketUnits(market))
      : priceUnitsToPrice(market.mark, marketUnits(market));
  }
  cancel(request: CancelOrderRequest, options: SubmitOptions = {}) {
    return this.bulkCancel([request], options);
  }
  async bulkCancel(requests: readonly CancelOrderRequest[], options: SubmitOptions = {}) {
    checkCount(requests.length);
    validateOptions(options);
    requests = structuredClone(requests);
    const meta = await this.info.meta(options);
    return this.executeActions(
      requests.map((r) => buildCancelAction(this.account, findMarket(meta.markets, r.coin).id, r.orderId)),
      options,
    );
  }
  async cancelAll(coin = '', options: SubmitOptions = {}) {
    const market = coin === '' ? 0xffff : (await this.info.market(coin, options)).id;
    return this.execute({ type: 'CancelAll', account: this.account, market }, options);
  }
  modifyOrder(request: ModifyOrderRequest, options: SubmitOptions = {}) {
    return this.bulkModify([request], options);
  }
  async bulkModify(requests: readonly ModifyOrderRequest[], options: SubmitOptions = {}) {
    checkCount(requests.length);
    validateOptions(options);
    requests = structuredClone(requests);
    const meta = await this.info.meta(options);
    const actions = requests.map((request) => {
      assertDecimal(request.price, 'price');
      const market = findMarket(meta.markets, request.coin);
      active(market);
      assertSize(request.size, market);
      if (!isPriceOnTick(request.price, marketUnits(market))) throw new RangeError('Price is off tick');
      return buildModifyAction({
        account: this.account,
        market: marketUnits(market),
        orderId: request.orderId,
        price: request.price,
        size: request.size,
      });
    });
    return this.executeActions(actions, options);
  }
  /** Cancel a TWAP parent and its current child using the existing chain Cancel action. */
  cancelTwap(request: CancelOrderRequest, options: SubmitOptions = {}) {
    return this.cancel(request, options);
  }
  async marketOpen(request: MarketOrderRequest, options: SubmitOptions = {}) {
    request = { ...request };
    assertDecimal(request.size, 'size');
    assertBool(request.isBuy, 'isBuy');
    const market = await this.info.market(request.coin, options);
    active(market);
    if (request.referencePrice !== undefined) assertDecimal(request.referencePrice, 'referencePrice');
    const ref = request.referencePrice ?? (await this.reference(market, request.isBuy, options));
    const action = buildPlaceAction({
      account: this.account,
      market: marketUnits(market),
      type: 'market',
      side: request.isBuy ? 'buy' : 'sell',
      size: request.size,
      referencePrice: ref,
      slippage: slippage(request.slippage),
      reduceOnly: request.reduceOnly,
      position: request.position,
      isCross: !(request.isolated ?? false),
    });
    assertSize(request.size, market);
    if (request.isolated !== undefined) assertBool(request.isolated, 'isolated');
    if (request.reduceOnly !== undefined) assertBool(request.reduceOnly, 'reduceOnly');
    return this.execute(action, options);
  }
  marketClose(request: ClosePositionRequest, options: SubmitOptions = {}) {
    if (!['Long', 'Short'].includes(request.position)) throw new TypeError('close requires Long or Short');
    return this.marketOpen({ ...request, isBuy: request.position === 'Short', reduceOnly: true }, options);
  }
  async updateLeverage(coin: string, leverage: string, options: SubmitOptions = {}) {
    assertDecimal(leverage, 'leverage');
    if (new ExactDecimal(leverage).lt(1) || new ExactDecimal(leverage).gt(1_000_000))
      throw new RangeError('leverage must be in 1..1000000');
    const market = await this.info.market(coin, options);
    return this.execute(buildSetLeverageAction(this.account, market.id, leverageToImfPpm(leverage)), options);
  }
  async updateIsolatedMargin(
    coin: string,
    position: 'Long' | 'Short',
    amount: string,
    options: SubmitOptions = {},
  ) {
    assertDecimal(amount, 'amount');
    if (!new ExactDecimal(amount).times(1_000_000).isInteger())
      throw new RangeError('amount is off micro-USD');
    const market = await this.info.market(coin, options);
    return this.execute(buildUpdateIsolatedMarginAction(this.account, market.id, position, amount), options);
  }
  approveAgent(slot: number, publicKey: Uint8Array, expiry = 0n, options: SubmitOptions = {}) {
    return this.execute(
      { type: 'ApproveAgent', account: this.account, slot, key: Uint8Array.from(publicKey), expiry },
      options,
    );
  }
  revokeAgent(slot: number, options: SubmitOptions = {}) {
    return this.execute({ type: 'RevokeAgent', account: this.account, slot }, options);
  }
  async twapOrder(request: CreateTwapOrderRequest, options: SubmitOptions = {}) {
    request = { ...request };
    assertBool(request.isBuy, 'isBuy');
    assertDecimal(request.size, 'size');
    if (request.isolated !== undefined) assertBool(request.isolated, 'isolated');
    if (request.reduceOnly !== undefined) assertBool(request.reduceOnly, 'reduceOnly');
    const market = await this.info.market(request.coin, options);
    active(market);
    assertSize(request.size, market);
    if (request.price !== undefined) {
      assertDecimal(request.price, 'price');
      if (!isPriceOnTick(request.price, marketUnits(market))) throw new RangeError('Price is off tick');
    }
    const ppm = request.tolerancePpm ?? 10_000;
    if (!Number.isInteger(ppm) || ppm < 0 || ppm >= 1_000_000)
      throw new RangeError('Invalid TWAP tolerancePpm');
    return this.execute(
      buildTwapAction({
        account: this.account,
        market: marketUnits(market),
        side: request.isBuy ? 'buy' : 'sell',
        size: request.size,
        price: request.price,
        durationS: request.durationS,
        intervalS: request.intervalS,
        tolerance: ppm / 1_000_000,
        position: request.position,
        reduceOnly: request.reduceOnly,
        isCross: !(request.isolated ?? false),
      }),
      options,
    );
  }
  async scaledOrder(request: CreateScaledOrderRequest, options: SubmitOptions = {}) {
    request = { ...request };
    assertBool(request.isBuy, 'isBuy');
    assertDecimal(request.size, 'size');
    assertDecimal(request.lowestPrice, 'lowestPrice');
    assertDecimal(request.highestPrice, 'highestPrice');
    if (request.isolated !== undefined) assertBool(request.isolated, 'isolated');
    if (request.reduceOnly !== undefined) assertBool(request.reduceOnly, 'reduceOnly');
    const market = await this.info.market(request.coin, options);
    active(market);
    assertSize(request.size, market);
    if (
      !isPriceOnTick(request.lowestPrice, marketUnits(market)) ||
      !isPriceOnTick(request.highestPrice, marketUnits(market))
    )
      throw new RangeError('Scaled prices are off tick');
    const ppm = request.magnitudePpm ?? 0;
    if (!Number.isInteger(ppm) || ppm < 0 || ppm >= 2_000_000)
      throw new RangeError('Invalid scaled magnitudePpm');
    if ((request.profile === undefined || request.profile === 'Equal') && ppm !== 0)
      throw new RangeError('Equal magnitudePpm must be zero');
    if (request.tif !== undefined && request.tif !== 'Gtc' && request.tif !== 'Ioc')
      throw new TypeError('Scaled TIF must be Gtc or Ioc');
    return this.execute(
      buildScaledAction({
        account: this.account,
        market: marketUnits(market),
        side: request.isBuy ? 'buy' : 'sell',
        size: request.size,
        lowestPrice: request.lowestPrice,
        highestPrice: request.highestPrice,
        numOrders: request.numOrders,
        profile: request.profile,
        spacing: request.spacing,
        magnitude: ppm / 1_000_000,
        tif: request.tif === 'Ioc' ? 'ioc' : 'gtc',
        position: request.position,
        reduceOnly: request.reduceOnly,
        isCross: !(request.isolated ?? false),
        goodTilBlock: request.goodTilBlock,
      }),
      options,
    );
  }
  async submitPrepared(
    input: readonly PreparedAction[],
    options: SubmitOptions = {},
  ): Promise<OrderResponse> {
    validateOptions(options);
    checkCount(input.length);
    // Keep immutable originals even if caller mutates its array while signing/querying.
    const prepared = input.map((p) => Object.freeze({ ...p }));
    const seen = new Set<bigint>();
    const signed = prepared.map((p) => {
      const actionBytes = hexToBytes(strip0x(p.action));
      const authBytes = hexToBytes(strip0x(p.auth));
      if (actionBytes.length !== 48 || authBytes.length !== 78)
        throw new RangeError('Invalid prepared widths');
      const action = decodeAction(actionBytes);
      const auth = decodeAuth(authBytes);
      if (auth.key !== this.slot) throw new TypeError('Prepared signer slot does not match this Exchange');
      if (
        !action ||
        !('account' in action) ||
        ['Deposit', 'Withdraw', 'Stake', 'Unstake'].includes(action.type) ||
        action.account !== this.account ||
        p.account !== this.account ||
        auth.nonce !== p.nonce ||
        p.nonce <= 0n ||
        seen.has(p.nonce) ||
        hex(encodeAction(action)) !== p.action ||
        hex(encodeAuth(auth)) !== p.auth ||
        transactionHash(action, auth) !== p.transactionHash
      )
        throw new TypeError('Prepared action metadata or canonical bytes mismatch');
      if (auth.key !== 0 && !agentMay(action))
        throw new TypeError(`${action.type} requires an owner signature`);
      seen.add(p.nonce);
      if (
        ['Place', 'PlaceWith', 'Modify', 'PlaceTwap', 'PlaceScaled'].includes(action.type) &&
        p.nonce >= 1n << 56n
      )
        throw new RangeError('Order nonce occupies reserved bits');
      return { action, auth };
    });
    const chain = await this.connect(options);
    const genesis = hex(chain.genesisHash);
    const owner = signed.some((s) => s.auth.key === 0)
      ? await this.info.userStateById(this.account, options)
      : undefined;
    const agents = signed.some((s) => s.auth.key !== 0)
      ? await this.info.agents(this.account, options)
      : undefined;
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const { action, auth } = signed[i];
      if (p.genesisHash !== genesis)
        throw new ChainIdentityError('Prepared signature belongs to another genesis');
      if (auth.key === 0) {
        const recovered = recoverOwner(ownerDigest(chain.genesisHash, action, auth.nonce), auth.sig);
        if (auth.seq !== 0 || !recovered || !owner || hex(recovered) !== hex(owner.owner))
          throw new TypeError('Prepared owner signature mismatch');
      } else {
        const slot = agents?.agents.find((a) => a.slot === auth.key);
        const observedHeight = agents?.at?.executedHeight ?? 0n;
        const height = observedHeight > chain.executedHeight ? observedHeight : chain.executedHeight;
        if (
          !slot ||
          slot.seq !== auth.seq ||
          (slot.expiry !== 0n && slot.expiry < height) ||
          !verifyAgentSignature(slot.key, chain.genesisHash, action, auth)
        )
          throw new TypeError('Prepared agent signature is stale, invalid or revoked');
      }
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
    let submit: SubmitResult;
    try {
      submit = await submitActions(this.info.rpc, signed, options);
      submit.transactionHashes.forEach((hash, i) => {
        if (
          submit.outcomes[i].kind === 'accepted'
            ? hash.length !== 32 || hex(hash) !== prepared[i].transactionHash
            : hash.length !== 0
        )
          throw new TypeError('Submit returned a mismatching transaction hash');
      });
    } catch (cause) {
      throw new ExchangeSubmissionUnknownError(prepared, cause);
    }
    const response = new OrderResponse(
      submit.id,
      prepared.map((p, i) => ({
        prepared: p,
        submitStatus: submit.outcomes[i].kind,
        outcome: { kind: submit.outcomes[i].kind === 'accepted' ? 'pending' : 'not_submitted' },
        ...('detail' in submit.outcomes[i] ? { error: submit.outcomes[i].detail } : {}),
      })),
      submit,
    );
    if (options.waitForExecution === false || !response.statuses.some((s) => s.submitStatus === 'accepted'))
      return response;
    return this.track(response, options);
  }
  private async track(response: OrderResponse, options: SubmitOptions): Promise<OrderResponse> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort(new Error('Execution wait deadline exceeded'));
    }, options.timeoutMs ?? 15_000);
    try {
      for (;;) {
        const pending = response.statuses.filter(
          (s) => s.submitStatus === 'accepted' && s.outcome.kind === 'pending',
        );
        if (!pending.length) return response;
        for (let start = 0; start < pending.length; start += 10_000) {
          const slice = pending.slice(start, start + 10_000);
          const result = await getActionOutcomes(
            this.info.rpc,
            slice.map((s) => ({ account: s.prepared.account, nonce: s.prepared.nonce })),
            { signal: controller.signal },
          );
          result.outcomes.forEach((outcome, i) => {
            slice[i].outcome = outcome;
            if (outcome.kind === 'executed' && !outcome.ok) slice[i].error = outcome.reject;
          });
        }
        if (!response.statuses.some((s) => s.submitStatus === 'accepted' && s.outcome.kind === 'pending'))
          return response;
        await delay(options.intervalMs ?? 250, controller.signal);
      }
    } catch (cause) {
      if (expired && !options.signal?.aborted) return response;
      throw new ExchangeTrackingError(response, cause);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
function findMarket(markets: Market[], coin: string): Market {
  const m = markets.find((m) => m.ticker === coin);
  if (!m) throw new RangeError(`Market not found: ${coin}`);
  if (m.id >= 0xffff) throw new RangeError('Market id cannot be encoded');
  return m;
}
function checkCount(n: number) {
  if (n < 1 || n > 20_000) throw new RangeError('requires 1..20000 items');
}
function validateOptions(o: SubmitOptions) {
  for (const n of [o.timeoutMs, o.intervalMs])
    if (n !== undefined && (!Number.isFinite(n) || n <= 0 || n > 2_147_483_647))
      throw new RangeError('Timeout and interval must be positive milliseconds <= 2147483647');
}
function assertDecimal(value: string, field: string) {
  if (typeof value !== 'string' || value.length > 128 || !/^[+-]?\d+(?:\.\d+)?$/.test(value))
    throw new TypeError(`${field} must be an exact decimal string`);
}
function assertBool(value: boolean, field: string) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
}
function assertRequest(r: CreateOrderRequest) {
  assertBool(r.isBuy, 'isBuy');
  assertDecimal(r.size, 'size');
  for (const [key, value] of [
    ['price', r.price],
    ['referencePrice', r.referencePrice],
  ] as const)
    if (value !== undefined) assertDecimal(value, key);
  for (const [key, value] of [
    ['isolated', r.isolated],
    ['reduceOnly', r.reduceOnly],
  ] as const)
    if (value !== undefined) assertBool(value, key);
  if (r.orderType?.limit && r.orderType.trigger) throw new TypeError('Choose limit or trigger order type');
  if (r.orderType?.limit?.tif !== undefined && !Object.hasOwn(tifMap, r.orderType.limit.tif))
    throw new TypeError('Unknown TIF');
  if (r.orderType?.trigger) {
    assertBool(r.orderType.trigger.isMarket, 'isMarket');
    assertDecimal(r.orderType.trigger.triggerPrice, 'triggerPrice');
    if (!['tp', 'sl'].includes(r.orderType.trigger.tpsl)) throw new TypeError('tpsl must be tp or sl');
  }
}
function active(m: Market) {
  if (m.status !== MarketStatus.ACTIVE) throw new TypeError('Market is not active');
}
function assertSize(value: string, market: Market) {
  assertDecimal(value, 'size');
  const units = marketUnits(market);
  if (!new ExactDecimal(quantumsToSize(sizeToQuantums(value, units), units)).equals(value))
    throw new RangeError('Size is off step or below minimum');
}
function slippage(value = '0.01'): number {
  assertDecimal(value, 'slippage');
  const d = new ExactDecimal(value);
  if (d.lt(0) || d.gte(1)) throw new RangeError('slippage must be >=0 and <1');
  const n = d.toNumber();
  if (!new ExactDecimal(String(n)).eq(d))
    throw new RangeError('slippage is too precise for the order builder');
  return n;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
