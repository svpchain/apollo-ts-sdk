// 把下单面板的意图变成 Apollo action：单位换算、订单类型映射、对冲槽位选择。
//
// 对冲槽位的决策（2026-10-26）：面板上的买 / 卖等于开仓——买开 Long 槽、卖开 Short 槽；
// 勾选 reduce-only 则意味着平对侧槽位（买 + reduce-only = 对 Short 槽下 Bid，即平空）。
// 平仓按钮、TP/SL 从持仓行发起，持仓行知道自己是哪个槽位，直接传 `position`。
// 链的规则：Long+Ask / Short+Bid 是平仓方向，隐式 reduce-only、可以挂单；
// 显式 reduce-only 的开仓方向订单必须 IOC——我们的映射下永远不会生成那种订单。
//
// 订单类型映射：
//   limit                  → Place（无特殊选项）/ PlaceWith（有 reduceOnly / goodTilBlock）
//   market                 → Place{tif: Ioc, price: 带滑点的保护价}
//   stop_limit / stop_market / take_profit_limit / take_profit_market
//                          → PlaceWith{trigger}（market 变体同样用 IOC + 保护价）
// FOK 与追踪止损在链上没有对应，不在这里出现。

import type {
  Action,
  OrderOpts,
  PositionSide,
  ScaledProfile,
  ScaledSpacing,
  Side,
  Tif,
  Trigger,
} from './codec.js';
import { ALL_MARKETS } from './codec.js';
import {
  type DecimalInput,
  type MarketUnits,
  UnitError,
  marketOrderPriceLimit,
  priceToSubticks,
  sizeToQuantums,
  usdToMicroUsd,
} from './units.js';

export type OrderAction = Exclude<Action, { type: 'Deposit' | 'Withdraw' | 'Stake' | 'Unstake' }>;

export type OrderSide = 'buy' | 'sell';
export type OrderType =
  | 'limit'
  | 'market'
  | 'stop_limit'
  | 'stop_market'
  | 'take_profit_limit'
  | 'take_profit_market';
export type TimeInForce = 'gtc' | 'ioc' | 'post_only';

export interface PlaceIntent {
  account: number;
  market: MarketUnits;
  side: OrderSide;
  type: OrderType;
  /** 人类数量（base 资产）。 */
  size: DecimalInput;
  /** 限价（limit / stop_limit / take_profit_limit）；市价类不填。 */
  price?: DecimalInput;
  /** 触发价（stop_* / take_profit_*）。 */
  triggerPrice?: DecimalInput;
  /** 市价类订单的参考价（通常是 mark 或对手一档），用于算保护限价。 */
  referencePrice?: DecimalInput;
  /** 市价类订单的滑点比例，如 0.01；缺省 0.01。 */
  slippage?: number;
  tif?: TimeInForce;
  reduceOnly?: boolean;
  /** 全仓 true / 逐仓 false；缺省全仓。 */
  isCross?: boolean;
  /** 显式指定槽位（平仓 / TP-SL 从持仓行发起时）；缺省按 side + reduceOnly 推导。 */
  position?: Exclude<PositionSide, 'Both'>;
  /** 最后可挂单高度；缺省 0 不过期。 */
  goodTilBlock?: bigint;
}

export class OrderIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderIntentError';
  }
}

export const DEFAULT_MARKET_SLIPPAGE = 0.01;

/** 市价单保护价的参考：吃单侧一档（`book`），或该侧没有挂单时的标记价（`mark`）。 */
export interface MarketReference {
  price: number;
  source: 'book' | 'mark';
}

/**
 * 市价类订单算保护限价用的参考价：买看卖一、卖看买一，也就是 IOC 真正要吃的那一档；该侧没有
 * 挂单时退回标记价。中间价不行：价差一旦超过两倍滑点，中间价加滑点仍够不到对手盘，IOC 会一笔
 * 不成交地被撤销。
 */
export function marketReferencePrice(
  side: OrderSide,
  book: { bestBid: number; bestAsk: number },
  markPrice: number,
): MarketReference | undefined {
  const touch = side === 'buy' ? book.bestAsk : book.bestBid;
  if (Number.isFinite(touch) && touch > 0) return { price: touch, source: 'book' };
  if (Number.isFinite(markPrice) && markPrice > 0) return { price: markPrice, source: 'mark' };
  return undefined;
}

const SIDE: Record<OrderSide, Side> = { buy: 'Bid', sell: 'Ask' };
const TIF: Record<TimeInForce, Tif> = { gtc: 'Gtc', ioc: 'Ioc', post_only: 'PostOnly' };

/**
 * 槽位推导：开仓看方向（买 → Long、卖 → Short），reduce-only 翻到对侧槽位做平仓。
 * 调用方显式给了 position 则以它为准（持仓表知道自己在哪个槽位）。
 */
export function resolvePositionSide(
  side: OrderSide,
  reduceOnly: boolean,
  explicit?: Exclude<PositionSide, 'Both'>,
): Exclude<PositionSide, 'Both'> {
  if (side !== 'buy' && side !== 'sell') throw new OrderIntentError('Unknown order side');
  if (explicit !== undefined && explicit !== 'Long' && explicit !== 'Short')
    throw new OrderIntentError('Unknown position side');
  if (explicit) return explicit;
  const opening: Exclude<PositionSide, 'Both'> = side === 'buy' ? 'Long' : 'Short';
  if (!reduceOnly) return opening;
  return opening === 'Long' ? 'Short' : 'Long';
}

/** 该方向对该槽位是否为平仓（Long+Ask / Short+Bid）。 */
export function isClosingOrder(side: OrderSide, position: PositionSide): boolean {
  return (position === 'Long' && side === 'sell') || (position === 'Short' && side === 'buy');
}

function isMarketLike(type: OrderType): boolean {
  return type === 'market' || type === 'stop_market' || type === 'take_profit_market';
}

function triggerKind(type: OrderType): Trigger['kind'] | undefined {
  switch (type) {
    case 'stop_limit':
    case 'stop_market':
      return 'StopLoss';
    case 'take_profit_limit':
    case 'take_profit_market':
      return 'TakeProfit';
    default:
      return undefined;
  }
}

/** 订单价（subticks）：限价直接换算；市价类用参考价加滑点的保护价。 */
export function resolveOrderPrice(intent: PlaceIntent): bigint {
  if (isMarketLike(intent.type)) {
    if (intent.referencePrice === undefined) {
      throw new OrderIntentError(`${intent.type} 需要 referencePrice 计算保护限价`);
    }
    return marketOrderPriceLimit(
      intent.referencePrice,
      intent.side,
      intent.slippage ?? DEFAULT_MARKET_SLIPPAGE,
      intent.market,
    );
  }
  if (intent.price === undefined) {
    throw new OrderIntentError(`${intent.type} 需要 price`);
  }
  return priceToSubticks(intent.price, intent.market);
}

/**
 * 面板意图 → Place / PlaceWith。
 * 只在需要 reduceOnly、goodTilBlock 或触发条件时用 PlaceWith，否则用更短的 Place，
 * 两者在链上语义相同。
 */
export function buildPlaceAction(intent: PlaceIntent): OrderAction {
  if (
    !['limit', 'market', 'stop_limit', 'stop_market', 'take_profit_limit', 'take_profit_market'].includes(
      intent.type,
    )
  )
    throw new OrderIntentError('Unknown order type');
  if (intent.tif !== undefined && !['gtc', 'ioc', 'post_only'].includes(intent.tif))
    throw new OrderIntentError('Unknown time in force');
  const reduceOnly = intent.reduceOnly ?? false;
  const isCross = intent.isCross ?? true;
  const position = resolvePositionSide(intent.side, reduceOnly, intent.position);
  const side = SIDE[intent.side];
  const size = sizeToQuantums(intent.size, intent.market);
  const price = resolveOrderPrice(intent);
  const tif: Tif = isMarketLike(intent.type) ? 'Ioc' : TIF[intent.tif ?? 'gtc'];
  if (isMarketLike(intent.type) && intent.tif && intent.tif !== 'ioc') {
    throw new OrderIntentError('市价类订单只能是 IOC');
  }
  const kind = triggerKind(intent.type);
  let trigger: Trigger | undefined;
  if (kind) {
    if (intent.triggerPrice === undefined) {
      throw new OrderIntentError(`${intent.type} 需要 triggerPrice`);
    }
    trigger = { kind, price: priceToSubticks(intent.triggerPrice, intent.market) };
  } else if (intent.triggerPrice !== undefined) {
    throw new OrderIntentError(`${intent.type} 不应带 triggerPrice`);
  }
  const goodTilBlock = intent.goodTilBlock ?? 0n;
  if (goodTilBlock < 0n) throw new OrderIntentError('goodTilBlock 不能为负');
  // 显式 reduce-only 的开仓方向在链上必须 IOC；我们的槽位推导保证 reduce-only 总在平仓方向，
  // 但调用方显式传了 position 时仍可能组合出开仓方向，这里按链规则拦下。
  if (reduceOnly && !isClosingOrder(intent.side, position) && tif !== 'Ioc') {
    throw new OrderIntentError('开仓方向的 reduce-only 订单必须是 IOC');
  }

  const plain = !reduceOnly && goodTilBlock === 0n && !trigger;
  if (plain) {
    return {
      type: 'Place',
      account: intent.account,
      market: intent.market.id,
      side,
      price,
      size,
      tif,
      position,
      isCross,
    };
  }
  const opts: OrderOpts = { reduceOnly, goodTilBlock, trigger, position, isCross };
  return {
    type: 'PlaceWith',
    account: intent.account,
    market: intent.market.id,
    side,
    price,
    size,
    tif,
    opts,
  };
}

export function buildCancelAction(account: number, market: number, orderId: bigint): OrderAction {
  return { type: 'Cancel', account, market, orderId };
}

/** 撤一个市场或（`'all'`）全部市场的所有挂单与条件单。 */
export function buildCancelAllAction(account: number, market: number | 'all'): OrderAction {
  return { type: 'CancelAll', account, market: market === 'all' ? ALL_MARKETS : market };
}

export interface ModifyIntent {
  account: number;
  market: MarketUnits;
  orderId: bigint;
  price: DecimalInput;
  size: DecimalInput;
}

/** 改价改量：链上撤旧挂新（GTC），新单 id 是本次 nonce。 */
export function buildModifyAction(intent: ModifyIntent): OrderAction {
  return {
    type: 'Modify',
    account: intent.account,
    market: intent.market.id,
    orderId: intent.orderId,
    price: priceToSubticks(intent.price, intent.market),
    size: sizeToQuantums(intent.size, intent.market),
  };
}

export interface ClosePositionIntent {
  account: number;
  market: MarketUnits;
  /** 要平的槽位。 */
  position: Exclude<PositionSide, 'Both'>;
  /** 人类数量；缺省时调用方应传入持仓全量。 */
  size: DecimalInput;
  /** 限价平仓给 price，市价平仓给 referencePrice（+ slippage）。 */
  price?: DecimalInput;
  referencePrice?: DecimalInput;
  slippage?: number;
  isCross?: boolean;
}

/** 平仓：Long 槽卖、Short 槽买，链上隐式 reduce-only，可挂单。 */
export function buildClosePositionAction(intent: ClosePositionIntent): OrderAction {
  const side: OrderSide = intent.position === 'Long' ? 'sell' : 'buy';
  const market = intent.price === undefined;
  if (market && intent.referencePrice === undefined) {
    throw new OrderIntentError('市价平仓需要 referencePrice');
  }
  return buildPlaceAction({
    account: intent.account,
    market: intent.market,
    side,
    type: market ? 'market' : 'limit',
    size: intent.size,
    price: intent.price,
    referencePrice: intent.referencePrice,
    slippage: intent.slippage,
    position: intent.position,
    isCross: intent.isCross,
  });
}

/** 调杠杆：杠杆倍数已由 `leverageToImfPpm` 换成 ppm。 */
export function buildSetLeverageAction(account: number, market: number, imfPpm: number): OrderAction {
  if (!Number.isInteger(imfPpm) || imfPpm < 1 || imfPpm > 1_000_000) {
    throw new UnitError(`imfPpm 必须在 1..1_000_000，收到 ${imfPpm}`);
  }
  return { type: 'SetLeverage', account, market, imfPpm };
}

// ───────────────────────── TWAP ─────────────────────────
// 链的约束：interval 30–3600 s，duration 300–86400 s，duration 是 interval 的整数倍，
// interval 毫秒数是块时间的整数倍（整秒即可），tolerance < 1e6 ppm，每腿至少一个 step。

export const TWAP_MIN_INTERVAL_S = 30;
export const TWAP_MAX_INTERVAL_S = 3_600;
export const TWAP_MIN_DURATION_S = 300;
export const TWAP_MAX_DURATION_S = 86_400;
export const TWAP_MAX_TOLERANCE_PPM = 1_000_000;

export interface TwapIntent {
  account: number;
  market: MarketUnits;
  side: OrderSide;
  /** 总数量（人类单位）。 */
  size: DecimalInput;
  /** 每腿限价；不填（或空串）则按 oracle 价加 tolerance 下单。 */
  price?: DecimalInput;
  durationS: number;
  intervalS: number;
  /** 价格容忍度，比例（0.01 = 1%）；只在没有 price 时起作用。 */
  tolerance?: number;
  reduceOnly?: boolean;
  isCross?: boolean;
  position?: Exclude<PositionSide, 'Both'>;
}

export function buildTwapAction(intent: TwapIntent): OrderAction {
  const { durationS, intervalS } = intent;
  if (!Number.isInteger(intervalS) || intervalS < TWAP_MIN_INTERVAL_S || intervalS > TWAP_MAX_INTERVAL_S) {
    throw new OrderIntentError(`TWAP 间隔须在 ${TWAP_MIN_INTERVAL_S}..${TWAP_MAX_INTERVAL_S} 秒`);
  }
  if (!Number.isInteger(durationS) || durationS < TWAP_MIN_DURATION_S || durationS > TWAP_MAX_DURATION_S) {
    throw new OrderIntentError(`TWAP 时长须在 ${TWAP_MIN_DURATION_S}..${TWAP_MAX_DURATION_S} 秒`);
  }
  if (durationS % intervalS !== 0) {
    throw new OrderIntentError('TWAP 时长必须是间隔的整数倍');
  }
  const tolerance = intent.tolerance ?? DEFAULT_MARKET_SLIPPAGE;
  const tolerancePpm = Math.round(tolerance * 1_000_000);
  if (!Number.isFinite(tolerancePpm) || tolerancePpm < 0 || tolerancePpm >= TWAP_MAX_TOLERANCE_PPM) {
    throw new OrderIntentError('TWAP 价格容忍度须在 0 与 100% 之间');
  }
  const size = sizeToQuantums(intent.size, intent.market);
  const legs = BigInt(durationS / intervalS);
  if (size / legs < intent.market.stepBaseQuantums) {
    throw new OrderIntentError('TWAP 每腿数量不足一个最小步长，请减少腿数或增加数量');
  }
  const hasPrice = intent.price !== undefined && String(intent.price).trim() !== '';
  const price = hasPrice ? priceToSubticks(intent.price!, intent.market) : 0n;
  return {
    type: 'PlaceTwap',
    account: intent.account,
    market: intent.market.id,
    side: SIDE[intent.side],
    price,
    size,
    durationS,
    intervalS,
    tolerancePpm,
    position: resolvePositionSide(intent.side, intent.reduceOnly ?? false, intent.position),
    isCross: intent.isCross ?? true,
  };
}

// ───────────────────────── Scaled ─────────────────────────
// 链的约束：2–50 个子单，最低价 > 0 且最高价 > 最低价，价差（subticks）
// 不少于子单数 − 1；Equal 的 magnitude 为 0，比率型 1..1e6 ppm，差值型 1..2e6/(n−1) ppm；
// 不能 PostOnly、不能带触发或 builder。

export const SCALED_MIN_ORDERS = 2;
export const SCALED_MAX_ORDERS = 50;

export interface ScaledIntent {
  account: number;
  market: MarketUnits;
  side: OrderSide;
  size: DecimalInput;
  lowestPrice: DecimalInput;
  highestPrice: DecimalInput;
  numOrders: number;
  profile?: ScaledProfile;
  spacing?: ScaledSpacing;
  /** 比率型：相邻子单数量比超出 1 的部分；差值型：相邻差额占平均数量的比例。Equal 忽略。 */
  magnitude?: number;
  tif?: Exclude<TimeInForce, 'post_only'>;
  reduceOnly?: boolean;
  isCross?: boolean;
  position?: Exclude<PositionSide, 'Both'>;
  goodTilBlock?: bigint;
}

export function buildScaledAction(intent: ScaledIntent): OrderAction {
  const n = intent.numOrders;
  if (!Number.isInteger(n) || n < SCALED_MIN_ORDERS || n > SCALED_MAX_ORDERS) {
    throw new OrderIntentError(`分批下单的子单数须在 ${SCALED_MIN_ORDERS}..${SCALED_MAX_ORDERS}`);
  }
  const lowestPrice = priceToSubticks(intent.lowestPrice, intent.market);
  const highestPrice = priceToSubticks(intent.highestPrice, intent.market);
  if (lowestPrice <= 0n || highestPrice <= lowestPrice) {
    throw new OrderIntentError('最高价必须高于最低价，且最低价为正');
  }
  if (highestPrice - lowestPrice < BigInt(n - 1)) {
    throw new OrderIntentError('价格区间太窄，容不下这么多子单');
  }
  const profile = intent.profile ?? 'Equal';
  let magnitudePpm = 0;
  if (profile !== 'Equal') {
    magnitudePpm = Math.round((intent.magnitude ?? 0) * 1_000_000);
    const max =
      profile === 'IncRatio' || profile === 'DecRatio' ? 1_000_000 : Math.floor(2_000_000 / (n - 1));
    if (magnitudePpm < 1 || magnitudePpm >= max) {
      throw new OrderIntentError(`该分布的幅度须在 (0, ${max / 1_000_000}) 之间`);
    }
  }
  const tif = intent.tif ?? 'gtc';
  const reduceOnly = intent.reduceOnly ?? false;
  const position = resolvePositionSide(intent.side, reduceOnly, intent.position);
  if (reduceOnly && !isClosingOrder(intent.side, position) && tif !== 'ioc') {
    throw new OrderIntentError('开仓方向的 reduce-only 订单必须是 IOC');
  }
  const opts: OrderOpts = {
    reduceOnly,
    goodTilBlock: intent.goodTilBlock ?? 0n,
    position,
    isCross: intent.isCross ?? true,
  };
  return {
    type: 'PlaceScaled',
    account: intent.account,
    market: intent.market.id,
    side: SIDE[intent.side],
    size: sizeToQuantums(intent.size, intent.market),
    tif: TIF[tif],
    opts,
    params: {
      lowestPrice,
      highestPrice,
      numOrders: n,
      profile,
      spacing: intent.spacing ?? 'Linear',
      magnitudePpm,
    },
  };
}

// ───────────────────────── TP / SL（从持仓行发起） ─────────────────────────

export interface TpSlIntent {
  account: number;
  market: MarketUnits;
  /** 持仓所在槽位；平仓方向由它决定（Long 卖、Short 买）。 */
  position: Exclude<PositionSide, 'Both'>;
  /** 要保护的数量；缺省应传持仓全量。 */
  size: DecimalInput;
  takeProfit?: { triggerPrice: DecimalInput; limitPrice?: DecimalInput };
  stopLoss?: { triggerPrice: DecimalInput; limitPrice?: DecimalInput };
  /** 市价变体（不填 limitPrice）的保护限价滑点。 */
  slippage?: number;
  isCross?: boolean;
}

/**
 * 止盈 / 止损各一条 PlaceWith{trigger, reduce_only}：平仓方向上 reduce-only 可以挂单，
 * 不填 limitPrice 时用触发价加滑点作保护限价（IOC）。
 */
export function buildTpSlActions(intent: TpSlIntent): OrderAction[] {
  const side: OrderSide = intent.position === 'Long' ? 'sell' : 'buy';
  const actions: OrderAction[] = [];
  const one = (
    kind: 'take_profit' | 'stop',
    leg: { triggerPrice: DecimalInput; limitPrice?: DecimalInput },
  ) => {
    const hasLimit = leg.limitPrice !== undefined && String(leg.limitPrice).trim() !== '';
    const type: OrderType =
      kind === 'take_profit'
        ? hasLimit
          ? 'take_profit_limit'
          : 'take_profit_market'
        : hasLimit
          ? 'stop_limit'
          : 'stop_market';
    actions.push(
      buildPlaceAction({
        account: intent.account,
        market: intent.market,
        side,
        type,
        size: intent.size,
        price: hasLimit ? leg.limitPrice : undefined,
        triggerPrice: leg.triggerPrice,
        referencePrice: hasLimit ? undefined : leg.triggerPrice,
        slippage: intent.slippage,
        tif: hasLimit ? 'gtc' : 'ioc',
        reduceOnly: true,
        position: intent.position,
        isCross: intent.isCross,
      }),
    );
  };
  if (intent.takeProfit) one('take_profit', intent.takeProfit);
  if (intent.stopLoss) one('stop', intent.stopLoss);
  if (actions.length === 0) throw new OrderIntentError('至少填写止盈或止损之一');
  return actions;
}

// ───────────────────────── 逐仓保证金 ─────────────────────────

/** 划转逐仓保证金：正数从全仓划入该槽位，负数划出。金额为人类 USD。 */
export function buildUpdateIsolatedMarginAction(
  account: number,
  market: number,
  position: Exclude<PositionSide, 'Both'>,
  amountUsd: DecimalInput,
): OrderAction {
  const amount = usdToMicroUsd(amountUsd);
  if (amount === 0n) throw new OrderIntentError('划转金额不能为 0');
  return { type: 'UpdateIsolatedMargin', account, market, position, amount };
}
