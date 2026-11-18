import type { Fill } from './gen/apollo/v1/common_pb.js';

/** Trading fees recorded in fills, in micro-USD. Excludes builder fees, funding and separate rewards.
 * Rebates and feesPaid are positive magnitudes. */
export interface FeeTotals {
  makerFees: bigint;
  takerFees: bigint;
  feesPaid: bigint;
  rebates: bigint;
  netFees: bigint;
  /** Fill records involving this account; a self-trade counts once. */
  fillCount: number;
  makerFillCount: number;
  takerFillCount: number;
}
export interface MarketFeeSummary extends FeeTotals {
  market: number;
}
export interface UserFeeSummary extends FeeTotals {
  account: number;
  byMarket: MarketFeeSummary[];
}
export type FeeFill = Pick<Fill, 'market' | 'makerAccount' | 'takerAccount' | 'makerFee' | 'takerFee'>;

/** Summarize the supplied records only. Pass distinct pages to avoid counting fills twice. */
export function summarizeFees(account: number, fills: readonly FeeFill[]): UserFeeSummary {
  if (!Number.isInteger(account) || account < 1 || account > 0xffff_ffff)
    throw new RangeError('account must be a non-vault u32');
  const id = BigInt(account);
  const summary: UserFeeSummary = { account, ...emptyTotals(), byMarket: [] };
  const markets = new Map<number, MarketFeeSummary>();
  for (const fill of fills) {
    if (!Number.isInteger(fill.market) || fill.market < 0 || fill.market > 0xffff_ffff)
      throw new RangeError('fill market must be a u32');
    if (
      [fill.makerAccount, fill.takerAccount, fill.makerFee, fill.takerFee].some((v) => typeof v !== 'bigint')
    )
      throw new TypeError('fill accounts and fees must be bigint');
    const maker = fill.makerAccount === id,
      taker = fill.takerAccount === id;
    if (!maker && !taker) continue;
    let market = markets.get(fill.market);
    if (!market) {
      market = { market: fill.market, ...emptyTotals() };
      markets.set(fill.market, market);
    }
    for (const totals of [summary, market]) {
      totals.fillCount++;
      if (maker) {
        totals.makerFillCount++;
        totals.makerFees += fill.makerFee;
        addFee(totals, fill.makerFee);
      }
      if (taker) {
        totals.takerFillCount++;
        totals.takerFees += fill.takerFee;
        addFee(totals, fill.takerFee);
      }
    }
  }
  summary.byMarket = [...markets.values()].sort((a, b) => a.market - b.market);
  return summary;
}
function emptyTotals(): FeeTotals {
  return {
    makerFees: 0n,
    takerFees: 0n,
    feesPaid: 0n,
    rebates: 0n,
    netFees: 0n,
    fillCount: 0,
    makerFillCount: 0,
    takerFillCount: 0,
  };
}
function addFee(totals: FeeTotals, fee: bigint) {
  if (fee >= 0n) totals.feesPaid += fee;
  else totals.rebates -= fee;
  totals.netFees += fee;
}
