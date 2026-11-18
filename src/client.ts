import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Decimal } from 'decimal.js';
import { type Action, type PositionSide, agentMay, decodeAction, encodeAction } from './codec.js';
import {
  type AgentSigner,
  type Auth,
  createAgentSigner,
  decodeAuth,
  encodeAuth,
  ownerAuthFromSignature,
  ownerTypedData,
  ownerDigest,
  recoverOwner,
  signWithAgent,
  strip0x,
} from './auth.js';
import { type ChainIdentity, fetchChainIdentity, type SignTypedData } from './account.js';
import { NonceAllocator } from './nonce.js';
import {
  type PlaceIntent,
  type ModifyIntent,
  type ClosePositionIntent,
  type TwapIntent,
  type ScaledIntent,
  buildPlaceAction,
  buildCancelAction,
  buildCancelAllAction,
  buildModifyAction,
  buildClosePositionAction,
  buildSetLeverageAction,
  buildUpdateIsolatedMarginAction,
  buildTwapAction,
  buildScaledAction,
} from './orders.js';
import {
  type MarketUnits,
  type DecimalInput,
  isPriceOnTick,
  quantumsToSize,
  sizeToQuantums,
  priceUnitsToPrice,
  subticksToPrice,
  leverageToImfPpm,
} from './units.js';
import {
  createApolloClients,
  type ApolloClients,
  type ActionOutcome,
  type SubmitResult,
  submitActions,
  waitForAction,
  type WaitForActionOptions,
} from './transport.js';
import type { ApolloTransportOptions } from './transport.js';
import { MarketStatus, type Market } from './gen/apollo/v1/market_pb.js';

export type Hex = `0x${string}`;
export interface NonceManager {
  /** 必须在该账户所有并发签名者之间原子分配；默认实现只协调本客户端实例。 */
  next(account: number): bigint | Promise<bigint>;
  syncFromChain(account: number, lastNonce: bigint): void | Promise<void>;
}
export interface ApolloClientOptions extends Omit<ApolloTransportOptions, 'protocol'> {
  expectedGenesisHash?: Hex | Uint8Array;
  nonceManager?: NonceManager;
}
export interface RequestOptions {
  signal?: AbortSignal;
}
export type TradingAction = Exclude<Action, { type: 'Deposit' | 'Withdraw' | 'Stake' | 'Unstake' }>;
export interface PreparedAction {
  readonly account: number;
  readonly nonce: bigint;
  readonly genesisHash: Hex;
  readonly action: Hex;
  readonly auth: Hex;
  readonly transactionHash: Hex;
}
export interface TradeReceipt {
  prepared: PreparedAction;
  submit: SubmitResult;
  outcome: ActionOutcome | { kind: 'not_submitted' };
}
export interface SubmitOptions extends WaitForActionOptions {
  waitForExecution?: boolean;
}

export class ChainIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainIdentityError';
  }
}
/** 响应丢失或不可信时保留原签名数据，调用方先查状态，SDK 绝不自动换 nonce 重发。 */
export class SubmissionUnknownError extends Error {
  constructor(
    public readonly prepared: PreparedAction,
    cause: unknown,
  ) {
    super('Submission result is unknown; reconcile the original account/nonce before retrying', { cause });
    this.name = 'SubmissionUnknownError';
  }
}
/** 已接收，但查询执行结果失败；可用 prepared.account/nonce 继续查询。 */
export class ExecutionTrackingError extends Error {
  constructor(
    public readonly prepared: PreparedAction,
    public readonly submit: SubmitResult,
    cause: unknown,
  ) {
    super('Action was accepted, but tracking failed; query the original account/nonce', { cause });
    this.name = 'ExecutionTrackingError';
  }
}
function validateSubmitOptions(options: SubmitOptions): void {
  for (const value of [options.timeoutMs, options.intervalMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647))
      throw new RangeError('Timeout and interval must be positive milliseconds <= 2147483647');
  }
}
function hex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}`;
}
function hash32(value: Hex | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? hexToBytes(strip0x(value)) : Uint8Array.from(value);
  if (bytes.length !== 32) throw new RangeError('genesis hash must be 32 bytes');
  return bytes;
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return hex(a) === hex(b);
}
function accountId(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff)
    throw new RangeError('account must be a non-vault u32');
  return value;
}
export function transactionHash(action: Action, auth: Auth): Hex {
  const prefix = new TextEncoder().encode('apollo-transaction-v1');
  const data = new Uint8Array(prefix.length + 48 + 78);
  data.set(prefix);
  data.set(encodeAction(action), prefix.length);
  data.set(encodeAuth(auth), prefix.length + 48);
  return hex(keccak_256(data));
}
export function marketUnits(market: Market): MarketUnits {
  return {
    id: market.id,
    priceExponent: market.priceExponent,
    atomicResolution: market.atomicResolution,
    quantumConversionExponent: market.quantumConversionExponent,
    stepBaseQuantums: market.stepBaseQuantums,
    subticksPerTick: market.subticksPerTick,
  };
}

/** typed unary queries + chain-bound signed trading; no app URL or browser storage is assumed. */
export class ApolloClient {
  readonly rpc: ApolloClients;
  readonly nonces: NonceManager;
  private pinned?: Hex;
  constructor(options: ApolloClientOptions) {
    this.rpc = createApolloClients(options);
    this.nonces = options.nonceManager ?? new NonceAllocator();
    if (options.expectedGenesisHash !== undefined) this.pinned = hex(hash32(options.expectedGenesisHash));
  }
  /** 首次连接锁定网络；每次写入前重查，发现重建/串链后拒绝签名与提交。 */
  async connect(options: RequestOptions = {}): Promise<ChainIdentity> {
    const identity = await fetchChainIdentity(this.rpc, options.signal);
    const actual = hex(identity.genesisHash);
    if (this.pinned !== undefined && actual !== this.pinned)
      throw new ChainIdentityError(`Genesis mismatch: expected ${this.pinned}, received ${actual}`);
    this.pinned = actual;
    return identity;
  }
  async getMarket(idOrTicker: number | string, options: RequestOptions = {}): Promise<Market> {
    const result = await this.rpc.market.listMarkets({}, options);
    const market = result.markets.find((m) =>
      typeof idOrTicker === 'number' ? m.id === idOrTicker : m.ticker === idOrTicker,
    );
    if (!market) throw new RangeError(`Market not found: ${idOrTicker}`);
    return market;
  }
  agent(options: { account: number; seed: Uint8Array; slot?: number }): TradingAccount {
    const key = createAgentSigner(options.seed, options.slot ?? 1, 0);
    return new TradingAccount(this, accountId(options.account), { kind: 'agent', signer: key });
  }
  owner(options: { account: number; signTypedData: SignTypedData }): TradingAccount {
    return new TradingAccount(this, accountId(options.account), {
      kind: 'owner',
      signTypedData: options.signTypedData,
    });
  }
  async submitPrepared(prepared: PreparedAction, options: SubmitOptions = {}): Promise<TradeReceipt> {
    validateSubmitOptions(options);
    // 从固定 hex 再解码，避免 prepare 后对象被调用方修改成另一笔交易。
    const actionBytes = hexToBytes(strip0x(prepared.action));
    const authBytes = hexToBytes(strip0x(prepared.auth));
    if (actionBytes.length !== 48 || authBytes.length !== 78)
      throw new RangeError('Invalid prepared action width');
    const action = decodeAction(actionBytes);
    const auth = decodeAuth(authBytes);
    if (
      !action ||
      !('account' in action) ||
      action.account !== prepared.account ||
      auth.nonce !== prepared.nonce ||
      hex(encodeAction(action)) !== prepared.action ||
      hex(encodeAuth(auth)) !== prepared.auth ||
      transactionHash(action, auth) !== prepared.transactionHash
    ) {
      throw new TypeError('Prepared action metadata or canonical bytes mismatch');
    }
    const identity = await this.connect(options);
    if (hex(identity.genesisHash) !== prepared.genesisHash)
      throw new ChainIdentityError('Prepared signature belongs to another genesis');
    let submit: SubmitResult;
    try {
      submit = await submitActions(this.rpc, [{ action, auth }], options);
      const hash = submit.transactionHashes[0];
      if (submit.ok && hash?.length && hex(hash) !== prepared.transactionHash)
        throw new Error('Node returned a different transaction hash');
    } catch (error) {
      throw new SubmissionUnknownError(prepared, error);
    }
    if (!submit.ok) return { prepared, submit, outcome: { kind: 'not_submitted' } };
    if (options.waitForExecution === false) return { prepared, submit, outcome: { kind: 'pending' } };
    try {
      const outcome = await waitForAction(
        this.rpc,
        { account: prepared.account, nonce: prepared.nonce },
        options,
      );
      return { prepared, submit, outcome };
    } catch (error) {
      throw new ExecutionTrackingError(prepared, submit, error);
    }
  }
}

type Signer = { kind: 'agent'; signer: AgentSigner } | { kind: 'owner'; signTypedData: SignTypedData };
export type PlaceOrderRequest = Omit<PlaceIntent, 'account' | 'market'> & { market: number | string };

export class TradingAccount {
  constructor(
    readonly client: ApolloClient,
    readonly account: number,
    private readonly signer: Signer,
  ) {}
  async prepare(action: TradingAction, options: RequestOptions = {}): Promise<PreparedAction> {
    if (['Deposit', 'Withdraw', 'Stake', 'Unstake'].includes(action.type))
      throw new TypeError('Use trading actions with this account');
    if (action.account !== this.account)
      throw new TypeError('Action account does not match this trading account');
    // 复制规范 action，钱包异步签名期间调用方不能改变原订单。
    const copy = decodeAction(encodeAction(action))!;
    const identity = await this.client.connect(options);
    const nonceState = await this.client.rpc.account.getNonce({ account: BigInt(this.account) }, options);
    await this.client.nonces.syncFromChain(this.account, nonceState.lastNonce);
    let currentAgent: AgentSigner | undefined;
    let owner: Uint8Array | undefined;
    if (this.signer.kind === 'agent') {
      if (!agentMay(copy)) throw new TypeError(`${copy.type} requires an owner signature`);
      const result = await this.client.rpc.account.getAgents({ account: BigInt(this.account) }, options);
      const slot = result.agents.find((s) => s.slot === this.signerSlot());
      if (
        !slot ||
        !same(slot.key, this.signer.signer.publicKey) ||
        (slot.expiry !== 0n && slot.expiry < (result.at?.executedHeight ?? identity.executedHeight))
      ) {
        throw new TypeError('Agent public key is not approved or has expired');
      }
      currentAgent = { ...this.signer.signer, seq: slot.seq };
    } else {
      owner = (
        await this.client.rpc.account.getAccount(
          { by: { case: 'account', value: BigInt(this.account) } },
          options,
        )
      ).owner;
    }
    const nonce = await this.client.nonces.next(this.account);
    if (nonce <= 0n || nonce > (1n << 64n) - 1n)
      throw new RangeError('Nonce manager returned an invalid u64');
    if (
      ['Place', 'PlaceWith', 'Modify', 'PlaceTwap', 'PlaceScaled'].includes(copy.type) &&
      nonce >= 1n << 56n
    ) {
      throw new RangeError('Order nonce uses protocol-reserved id bits');
    }
    let auth: Auth;
    if (currentAgent) auth = signWithAgent(currentAgent, identity.genesisHash, copy, nonce);
    else {
      if (this.signer.kind !== 'owner') throw new TypeError('Owner signer is missing');
      const signature = await this.signer.signTypedData(ownerTypedData(identity.genesisHash, copy, nonce));
      auth = ownerAuthFromSignature(nonce, signature);
      const recovered = recoverOwner(ownerDigest(identity.genesisHash, copy, nonce), auth.sig);
      if (!owner || !recovered || !same(owner, recovered))
        throw new TypeError('Wallet signature does not belong to the account owner');
    }
    return Object.freeze({
      account: this.account,
      nonce,
      genesisHash: hex(identity.genesisHash),
      action: hex(encodeAction(copy)),
      auth: hex(encodeAuth(auth)),
      transactionHash: transactionHash(copy, auth),
    });
  }
  private signerSlot(): number {
    return this.signer.kind === 'agent' ? this.signer.signer.slot : 0;
  }
  async execute(action: TradingAction, options: SubmitOptions = {}): Promise<TradeReceipt> {
    return this.client.submitPrepared(await this.prepare(action, options), options);
  }
  async prepareOrder(request: PlaceOrderRequest, options: RequestOptions = {}): Promise<PreparedAction> {
    const market = await this.client.getMarket(request.market, options);
    if (market.status !== MarketStatus.ACTIVE) throw new TypeError('Market is not active');
    const units = marketUnits(market);
    assertSize(request.size, units);
    if (request.price !== undefined && !isPriceOnTick(request.price, units))
      throw new RangeError('Limit price is off tick');
    if (request.triggerPrice !== undefined && !isPriceOnTick(request.triggerPrice, units))
      throw new RangeError('Trigger price is off tick');
    let referencePrice = request.referencePrice;
    if (
      referencePrice === undefined &&
      ['market', 'stop_market', 'take_profit_market'].includes(request.type)
    ) {
      const book = await this.client.rpc.market.getOrderBook({ market: market.id, depth: 1 }, options);
      const touch = request.side === 'buy' ? book.asks[0] : book.bids[0];
      referencePrice = touch ? subticksToPrice(touch.price, units) : priceUnitsToPrice(market.mark, units);
    }
    return this.prepare(
      buildPlaceAction({ ...request, market: units, account: this.account, referencePrice }),
      options,
    );
  }
  async placeOrder(request: PlaceOrderRequest, options: SubmitOptions = {}): Promise<TradeReceipt> {
    return this.client.submitPrepared(await this.prepareOrder(request, options), options);
  }
  cancelOrder(market: number, orderId: bigint, options: SubmitOptions = {}) {
    return this.execute(buildCancelAction(this.account, market, orderId), options);
  }
  cancelAll(market: number | 'all' = 'all', options: SubmitOptions = {}) {
    return this.execute(buildCancelAllAction(this.account, market), options);
  }
  async modifyOrder(
    request: Omit<ModifyIntent, 'account' | 'market'> & { market: number | string },
    options: SubmitOptions = {},
  ) {
    const units = marketUnits(await this.client.getMarket(request.market, options));
    assertSize(request.size, units);
    if (!isPriceOnTick(request.price, units)) throw new RangeError('Price is off tick');
    return this.execute(buildModifyAction({ ...request, account: this.account, market: units }), options);
  }
  async closePosition(
    request: Omit<ClosePositionIntent, 'account' | 'market'> & { market: number | string },
    options: SubmitOptions = {},
  ) {
    const units = marketUnits(await this.client.getMarket(request.market, options));
    assertSize(request.size, units);
    if (request.price !== undefined && !isPriceOnTick(request.price, units))
      throw new RangeError('Price is off tick');
    return this.execute(
      buildClosePositionAction({ ...request, account: this.account, market: units }),
      options,
    );
  }
  setLeverage(market: number, leverage: DecimalInput, options: SubmitOptions = {}) {
    return this.execute(buildSetLeverageAction(this.account, market, leverageToImfPpm(leverage)), options);
  }
  addIsolatedMargin(
    market: number,
    position: Exclude<PositionSide, 'Both'>,
    amount: DecimalInput,
    options: SubmitOptions = {},
  ) {
    return this.execute(buildUpdateIsolatedMarginAction(this.account, market, position, amount), options);
  }
  approveAgent(slot: number, publicKey: Uint8Array, expiry = 0n, options: SubmitOptions = {}) {
    return this.execute(
      { type: 'ApproveAgent', account: this.account, slot, key: publicKey, expiry },
      options,
    );
  }
  revokeAgent(slot: number, options: SubmitOptions = {}) {
    return this.execute({ type: 'RevokeAgent', account: this.account, slot }, options);
  }
  async placeTwap(
    request: Omit<TwapIntent, 'account' | 'market'> & { market: number | string },
    options: SubmitOptions = {},
  ) {
    const units = marketUnits(await this.client.getMarket(request.market, options));
    assertSize(request.size, units);
    if (request.price !== undefined && request.price !== '' && !isPriceOnTick(request.price, units))
      throw new RangeError('Price is off tick');
    return this.execute(buildTwapAction({ ...request, account: this.account, market: units }), options);
  }
  async placeScaled(
    request: Omit<ScaledIntent, 'account' | 'market'> & { market: number | string },
    options: SubmitOptions = {},
  ) {
    const units = marketUnits(await this.client.getMarket(request.market, options));
    assertSize(request.size, units);
    if (!isPriceOnTick(request.lowestPrice, units) || !isPriceOnTick(request.highestPrice, units))
      throw new RangeError('Scaled endpoint prices are off tick');
    return this.execute(buildScaledAction({ ...request, account: this.account, market: units }), options);
  }
}
function assertSize(size: DecimalInput, units: MarketUnits): void {
  if (!new Decimal(quantumsToSize(sizeToQuantums(size, units), units)).equals(new Decimal(size)))
    throw new RangeError('Order size is off step or below the minimum');
}
export function createApolloClient(options: ApolloClientOptions): ApolloClient {
  return new ApolloClient(options);
}
