// 人类可读的价格 / 数量与 Apollo 链上整数单位之间的换算。
//
// 链上整数单位：
//   - size：base quantums，1 quantum = 10^atomic_resolution 个 base 资产；订单量是 step_base_quantums 的倍数。
//   - 订单价（action 里的 price、trigger.price）：subticks，1 subtick = 10^quantum_conversion_exponent
//     quote quantums / base quantum；订单价是 subticks_per_tick 的倍数。
//   - oracle / mark（盘口和普通成交是 subticks，不套用 priceExponent）：10^price_exponent USD 的整数（ListMarkets 给出）。
//   - 金额：micro-USD（10^-6 USD）。
// 取整规则：向下取整到步长 / tick 的整数倍，且不小于一个步长。
// 全程 decimal.js + bigint，不经 number 中转；number 入参只接受有限值。

import { Decimal } from 'decimal.js';

// i64 × 十进制幂的中间结果需要超过默认 20 位精度；不修改宿主 Decimal 的全局配置。
const ExactDecimal = Decimal.clone({ precision: 80 });

/** USDC（quote 资产）的 atomic resolution，链上固定为 -6。 */
export const QUOTE_ATOMIC_RESOLUTION = -6;

/** 一个市场解释价格与数量所需的参数（apollo.v1 `Market` 的子集）。 */
export interface MarketUnits {
  id: number;
  priceExponent: number;
  atomicResolution: number;
  stepBaseQuantums: bigint;
  subticksPerTick: bigint;
  quantumConversionExponent: number;
}

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitError';
  }
}

export type DecimalInput = string | number | Decimal;

function decimal(value: DecimalInput, field: string): Decimal {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  ) {
    throw new UnitError(`${field}: use a decimal string instead of an unsafe numeric value`);
  }
  let d: Decimal;
  try {
    d = new ExactDecimal(value);
  } catch {
    throw new UnitError(`${field} 不是合法数字：${String(value)}`);
  }
  if (!d.isFinite()) throw new UnitError(`${field} 必须是有限数字：${String(value)}`);
  return d;
}

function positiveBig(value: bigint, field: string): Decimal {
  if (value <= 0n) throw new UnitError(`${field} 必须为正，收到 ${value}`);
  return new ExactDecimal(value.toString());
}

function toBigInt(d: Decimal, field: string): bigint {
  if (!d.isInteger()) throw new UnitError(`${field} 取整后仍非整数：${d.toString()}`);
  return BigInt(d.toFixed(0));
}

/** 向下取整到 `step` 的整数倍，并保证至少一个 `step`。 */
function floorToStepAtLeastOne(raw: Decimal, step: Decimal): Decimal {
  const stepped = raw.div(step).floor().times(step);
  return ExactDecimal.max(stepped, step);
}

/** 人类数量（base 资产）→ base quantums。负数与零拒绝：数量方向由 side 表达。 */
export function sizeToQuantums(size: DecimalInput, market: MarketUnits): bigint {
  const d = decimal(size, 'size');
  if (d.lte(0)) throw new UnitError(`size 必须为正，收到 ${d.toString()}`);
  const raw = d.times(ExactDecimal.pow(10, -market.atomicResolution));
  const step = positiveBig(market.stepBaseQuantums, 'stepBaseQuantums');
  return toBigInt(floorToStepAtLeastOne(raw, step), 'quantums');
}

/** base quantums → 人类数量字符串（精确，不丢位）。 */
export function quantumsToSize(quantums: bigint, market: MarketUnits): string {
  return new ExactDecimal(quantums.toString()).times(ExactDecimal.pow(10, market.atomicResolution)).toFixed();
}

/** 把人类价格换到 subticks 所用的 10 的幂：atomic_resolution − qce − (−6)。 */
export function subtickExponent(market: MarketUnits): number {
  return market.atomicResolution - market.quantumConversionExponent - QUOTE_ATOMIC_RESOLUTION;
}

export type Rounding = 'floor' | 'ceil';

/**
 * 人类价格（USD / base）→ subticks，默认向下取整到 tick（限价单口径）。
 * 市价单的保护价要向「更能成交」的方向取整，由调用方传 `rounding`。
 */
export function priceToSubticks(
  price: DecimalInput,
  market: MarketUnits,
  rounding: Rounding = 'floor',
): bigint {
  const d = decimal(price, 'price');
  if (d.lte(0)) throw new UnitError(`price 必须为正，收到 ${d.toString()}`);
  const raw = d.times(ExactDecimal.pow(10, subtickExponent(market)));
  const tick = positiveBig(market.subticksPerTick, 'subticksPerTick');
  const ticks = raw.div(tick);
  const rounded = (rounding === 'ceil' ? ticks.ceil() : ticks.floor()).times(tick);
  return toBigInt(ExactDecimal.max(rounded, tick), 'subticks');
}

/** subticks → 人类价格字符串。 */
export function subticksToPrice(subticks: bigint, market: MarketUnits): string {
  return new ExactDecimal(subticks.toString()).div(ExactDecimal.pow(10, subtickExponent(market))).toFixed();
}

/** 人类价格是否恰好落在 tick 上（输入校验用；不落在 tick 上下单会被静默取整）。 */
export function isPriceOnTick(price: DecimalInput, market: MarketUnits): boolean {
  const d = decimal(price, 'price');
  const raw = d.times(ExactDecimal.pow(10, subtickExponent(market)));
  return raw.isInteger() && raw.mod(new ExactDecimal(market.subticksPerTick.toString())).isZero();
}

/** oracle / mark 价格（10^price_exponent USD）→ 人类价格字符串。 */
export function priceUnitsToPrice(price: bigint, market: Pick<MarketUnits, 'priceExponent'>): string {
  return new ExactDecimal(price.toString()).times(ExactDecimal.pow(10, market.priceExponent)).toFixed();
}

/** 人类价格 → 读接口的价格单位（向下取整）。 */
export function priceToPriceUnits(price: DecimalInput, market: Pick<MarketUnits, 'priceExponent'>): bigint {
  const d = decimal(price, 'price');
  return toBigInt(d.div(ExactDecimal.pow(10, market.priceExponent)).floor(), 'priceUnits');
}

/** 读接口价格单位 → 订单 subticks（限价单用 mark 价作默认价时需要）。 */
export function priceUnitsToSubticks(
  price: bigint,
  market: MarketUnits,
  rounding: Rounding = 'floor',
): bigint {
  return priceToSubticks(priceUnitsToPrice(price, market), market, rounding);
}

/** micro-USD → 人类 USD 字符串。 */
export function microUsdToUsd(micro: bigint): string {
  return new ExactDecimal(micro.toString()).div(1_000_000).toFixed();
}

/** 人类 USD → micro-USD（向下取整；提现 / 划转金额用）。 */
export function usdToMicroUsd(usd: DecimalInput): bigint {
  const d = decimal(usd, 'usd');
  return toBigInt(d.times(1_000_000).floor(), 'microUsd');
}

/**
 * 市价单的保护限价（subticks）：买单在参考价上浮 `slippage`、卖单下浮，并向更能成交的方向取整
 * （买 ceil、卖 floor），使 IOC 限价单在允许的滑点内尽量全部成交。`slippage` 是比例，如 0.01 = 1%。
 */
export function marketOrderPriceLimit(
  referencePrice: DecimalInput,
  side: 'buy' | 'sell',
  slippage: number,
  market: MarketUnits,
): bigint {
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) {
    throw new UnitError(`slippage 必须在 [0, 1)，收到 ${slippage}`);
  }
  const ref = decimal(referencePrice, 'referencePrice');
  const factor = side === 'buy' ? new ExactDecimal(1).plus(slippage) : new ExactDecimal(1).minus(slippage);
  return priceToSubticks(ref.times(factor), market, side === 'buy' ? 'ceil' : 'floor');
}

/** 杠杆倍数 → 初始保证金率 ppm（SetLeverage 的参数）；向上取整保证不低于目标杠杆对应的 IMF。 */
export function leverageToImfPpm(leverage: DecimalInput): number {
  const d = decimal(leverage, 'leverage');
  if (d.lte(0) || d.gt(1_000_000)) throw new UnitError(`leverage 必须为正，收到 ${d.toString()}`);
  const ppm = new ExactDecimal(1_000_000).div(d).ceil();
  return Math.min(1_000_000, Math.max(1, ppm.toNumber()));
}

/** 初始保证金率 ppm → 杠杆倍数字符串（展示用）。 */
export function imfPpmToLeverage(imfPpm: number): string {
  if (!Number.isInteger(imfPpm) || imfPpm <= 0) throw new UnitError(`imfPpm 必须为正整数，收到 ${imfPpm}`);
  return new ExactDecimal(1_000_000).div(imfPpm).toFixed();
}
