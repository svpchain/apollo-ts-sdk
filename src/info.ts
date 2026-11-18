import { ApolloClient, type ApolloClientOptions, type RequestOptions } from './client.js';
import type { ApolloClients } from './transport.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { strip0x } from './auth.js';
import { summarizeFees } from './fees.js';
import { ActionState } from './gen/apollo/v1/tx_pb.js';

type Input<T extends (...args: any[]) => any> = Parameters<T>[0];
export type InfoOptions = ApolloClientOptions;
export type UserFillsParams = Input<ApolloClients['history']['getFills']>;
export type UserFeesParams = Omit<UserFillsParams, 'account' | '$typeName'> & { account: number };
export type HistoryParams = Input<ApolloClients['history']['getActionHistory']>;
export type CandlesParams = Input<ApolloClients['history']['getCandles']>;
export type FundingHistoryParams = Input<ApolloClients['history']['getFundingHistory']>;
export type ActionStatusKey = { account: number; nonce: bigint };

/** Typed read-only queries; method names mirror Apollo's Go Info API. */
export class Info {
  /** Underlying client and generated unary services. */
  readonly client: ApolloClient;
  constructor(options: InfoOptions) {
    this.client = new ApolloClient(options);
  }
  get rpc(): ApolloClients {
    return this.client.rpc;
  }
  chainInfo(options: RequestOptions = {}) {
    return this.rpc.chain.getChainInfo({}, options);
  }
  meta(options: RequestOptions = {}) {
    return this.rpc.market.listMarkets({}, options);
  }
  market(coin: string, options: RequestOptions = {}) {
    return this.client.getMarket(coin, options);
  }
  l2Snapshot(market: number, depth = 20, options: RequestOptions = {}) {
    return this.rpc.market.getOrderBook({ market, depth }, options);
  }
  ticker(market: number, options: RequestOptions = {}) {
    return this.rpc.market.getTicker({ market }, options);
  }
  userState(owner: string | Uint8Array, options: RequestOptions = {}) {
    const bytes = typeof owner === 'string' ? hexToBytes(strip0x(owner)) : Uint8Array.from(owner);
    if (bytes.length !== 20) throw new RangeError('owner must be a 20-byte EVM address');
    return this.rpc.account.getAccount({ by: { case: 'owner', value: bytes } }, options);
  }
  userStateById(account: number, options: RequestOptions = {}) {
    return this.rpc.account.getAccount({ by: { case: 'account', value: accountNumber(account) } }, options);
  }
  positions(account: number, options: RequestOptions = {}) {
    return this.rpc.account.getPositions({ account: accountNumber(account) }, options);
  }
  openOrders(account: number, market?: number, options: RequestOptions = {}) {
    return this.rpc.account.getOpenOrders(
      { account: accountNumber(account), ...(market === undefined ? {} : { market }) },
      options,
    );
  }
  agents(account: number, options: RequestOptions = {}) {
    return this.rpc.account.getAgents({ account: accountNumber(account) }, options);
  }
  nonce(account: number, options: RequestOptions = {}) {
    return this.rpc.account.getNonce({ account: accountNumber(account) }, options);
  }
  userRateLimit(account: number, options: RequestOptions = {}) {
    return this.rpc.tx.getAllowance({ account: accountNumber(account) }, options);
  }
  async actionStatus(keys: readonly ActionStatusKey[], options: RequestOptions = {}) {
    if (!keys.length || keys.length > 10_000) throw new RangeError('actionStatus requires 1..10000 keys');
    const request = keys.map((k) => ({ account: accountNumber(k.account), nonce: k.nonce }));
    const response = await this.rpc.tx.getActionStatus({ keys: request }, options);
    if (
      response.statuses.length !== keys.length ||
      response.statuses.some(
        (s, i) =>
          s.key?.account !== request[i].account ||
          s.key.nonce !== request[i].nonce ||
          ![ActionState.NOT_FOUND, ActionState.EXECUTED, ActionState.NONCE_USED].includes(s.state),
      )
    )
      throw new TypeError('Action status keys, count or state mismatch');
    return response;
  }
  async transaction(hash: string | Uint8Array, options: RequestOptions = {}) {
    const bytes = typeof hash === 'string' ? hexToBytes(strip0x(hash)) : Uint8Array.from(hash);
    if (bytes.length !== 32) throw new RangeError('transaction hash must be 32 bytes');
    const response = await this.rpc.tx.getTransaction({ transactionHash: bytes }, options);
    if (
      response.transactionHash.length !== bytes.length ||
      !response.transactionHash.every((b, i) => b === bytes[i])
    )
      throw new TypeError('Transaction hash response mismatch');
    return response;
  }
  indexStatus(options: RequestOptions = {}) {
    return this.rpc.history.getIndexStatus({}, options);
  }
  userFills(params: UserFillsParams, options: RequestOptions = {}) {
    return this.rpc.history.getFills(params, options);
  }
  /** Summarize trading fees in one fills page; excludes builder fees and funding. Follow next for more. */
  async userFees(params: UserFeesParams, options: RequestOptions = {}) {
    const { account, ...filters } = structuredClone(params);
    const page = await this.userFills({ ...filters, account: accountNumber(account) }, options);
    return { summary: summarizeFees(account, page.fills), index: page.index, next: page.next };
  }
  historicalOrders(params: HistoryParams, options: RequestOptions = {}) {
    return this.rpc.history.getOrderHistory(params, options);
  }
  actionHistory(params: HistoryParams, options: RequestOptions = {}) {
    return this.rpc.history.getActionHistory(params, options);
  }
  candlesSnapshot(params: CandlesParams, options: RequestOptions = {}) {
    return this.rpc.history.getCandles(params, options);
  }
  fundingHistory(params: FundingHistoryParams, options: RequestOptions = {}) {
    return this.rpc.history.getFundingHistory(params, options);
  }
}
function accountNumber(account: number): bigint {
  if (!Number.isInteger(account) || account < 1 || account > 0xffff_ffff)
    throw new RangeError('account must be a non-vault u32');
  return BigInt(account);
}
