import { describe, expect, it } from 'vitest';

import { ALL_MARKETS } from '../src/codec.js';
import {
  OrderIntentError,
  type PlaceIntent,
  buildCancelAllAction,
  buildCancelAction,
  buildClosePositionAction,
  buildModifyAction,
  buildPlaceAction,
  buildSetLeverageAction,
  isClosingOrder,
  marketReferencePrice,
  resolvePositionSide,
} from '../src/orders.js';
import type { MarketUnits } from '../src/units.js';

const btc: MarketUnits = {
  id: 0,
  priceExponent: -5,
  atomicResolution: -10,
  stepBaseQuantums: 1_000_000n,
  subticksPerTick: 100_000n,
  quantumConversionExponent: -9,
};

const base: PlaceIntent = {
  account: 7,
  market: btc,
  side: 'buy',
  type: 'limit',
  size: '0.01',
  price: '65000',
};

describe('槽位推导', () => {
  it('买开多、卖开空；reduce-only 翻到对侧槽位平仓', () => {
    expect(resolvePositionSide('buy', false)).toBe('Long');
    expect(resolvePositionSide('sell', false)).toBe('Short');
    expect(resolvePositionSide('buy', true)).toBe('Short');
    expect(resolvePositionSide('sell', true)).toBe('Long');
    expect(resolvePositionSide('buy', true, 'Long')).toBe('Long');
  });

  it('平仓方向判断与链一致', () => {
    expect(isClosingOrder('sell', 'Long')).toBe(true);
    expect(isClosingOrder('buy', 'Short')).toBe(true);
    expect(isClosingOrder('buy', 'Long')).toBe(false);
    expect(isClosingOrder('sell', 'Short')).toBe(false);
  });
});

describe('marketReferencePrice', () => {
  it('买看卖一、卖看买一；该侧无挂单退回标记价；都没有则 undefined', () => {
    const book = { bestBid: 2638.8, bestAsk: 2948.1 };
    expect(marketReferencePrice('buy', book, 2347.8)).toEqual({ price: 2948.1, source: 'book' });
    expect(marketReferencePrice('sell', book, 2347.8)).toEqual({ price: 2638.8, source: 'book' });
    expect(marketReferencePrice('buy', { bestBid: 2638.8, bestAsk: 0 }, 2347.8)).toEqual({
      price: 2347.8,
      source: 'mark',
    });
    expect(marketReferencePrice('sell', { bestBid: 0, bestAsk: 2948.1 }, 2347.8)).toEqual({
      price: 2347.8,
      source: 'mark',
    });
    expect(marketReferencePrice('buy', { bestBid: 0, bestAsk: 0 }, 0)).toBeUndefined();
    expect(marketReferencePrice('buy', { bestBid: 0, bestAsk: Number.NaN }, Number.NaN)).toBeUndefined();
  });

  it('11% 价差的盘口：以卖一为参考的 1% 滑点保护价能够到对手盘，中间价够不到', () => {
    const book = { bestBid: 63_000, bestAsk: 70_000 };
    const reference = marketReferencePrice('buy', book, 60_000)!;
    const intent: PlaceIntent = { account: 7, market: btc, side: 'buy', type: 'market', size: '0.5' };
    // 卖一 70000 × 1.01 = 70700（subticks 1e5 / USD），IOC 能吃到 70000 的卖单。
    expect(buildPlaceAction({ ...intent, referencePrice: reference.price })).toMatchObject({
      tif: 'Ioc',
      price: 7_070_000_000n,
    });
    // 中间价 66500 × 1.01 = 67165 < 70000：一笔不成交，IOC 直接被撤。
    expect(buildPlaceAction({ ...intent, referencePrice: (63_000 + 70_000) / 2 })).toMatchObject({
      price: 6_716_500_000n,
    });
  });
});

describe('buildPlaceAction', () => {
  it('普通限价单用 Place，默认 GTC 全仓', () => {
    expect(buildPlaceAction(base)).toEqual({
      type: 'Place',
      account: 7,
      market: 0,
      side: 'Bid',
      price: 6_500_000_000n,
      size: 100_000_000n,
      tif: 'Gtc',
      position: 'Long',
      isCross: true,
    });
    expect(buildPlaceAction({ ...base, tif: 'post_only', isCross: false, side: 'sell' })).toMatchObject({
      type: 'Place',
      side: 'Ask',
      tif: 'PostOnly',
      position: 'Short',
      isCross: false,
    });
  });

  it('市价单 = IOC + 带滑点的保护价', () => {
    const buy = buildPlaceAction({
      ...base,
      type: 'market',
      price: undefined,
      referencePrice: '65000',
      slippage: 0.01,
    });
    expect(buy).toMatchObject({ type: 'Place', tif: 'Ioc', price: 6_565_000_000n });
    const sell = buildPlaceAction({
      ...base,
      side: 'sell',
      type: 'market',
      price: undefined,
      referencePrice: '65000',
    });
    expect(sell).toMatchObject({ tif: 'Ioc', price: 6_435_000_000n, position: 'Short' });
    expect(() => buildPlaceAction({ ...base, type: 'market', price: undefined })).toThrow(OrderIntentError);
    expect(() =>
      buildPlaceAction({ ...base, type: 'market', price: undefined, referencePrice: '65000', tif: 'gtc' }),
    ).toThrow(OrderIntentError);
  });

  it('reduce-only 平对侧槽位，走 PlaceWith', () => {
    const action = buildPlaceAction({ ...base, side: 'buy', reduceOnly: true });
    expect(action).toMatchObject({
      type: 'PlaceWith',
      side: 'Bid',
      opts: { reduceOnly: true, position: 'Short', goodTilBlock: 0n, isCross: true },
    });
    // 显式指定成开仓方向的 reduce-only 且非 IOC：链会拒绝，这里提前拦。
    expect(() => buildPlaceAction({ ...base, side: 'buy', reduceOnly: true, position: 'Long' })).toThrow(
      OrderIntentError,
    );
    expect(
      buildPlaceAction({ ...base, side: 'buy', reduceOnly: true, position: 'Long', tif: 'ioc' }),
    ).toMatchObject({ type: 'PlaceWith', tif: 'Ioc' });
  });

  it('止损 / 止盈带触发价，market 变体用保护价 + IOC', () => {
    const stopLimit = buildPlaceAction({
      ...base,
      side: 'sell',
      type: 'stop_limit',
      price: '60000',
      triggerPrice: '61000',
      position: 'Long',
    });
    expect(stopLimit).toMatchObject({
      type: 'PlaceWith',
      side: 'Ask',
      tif: 'Gtc',
      price: 6_000_000_000n,
      opts: { trigger: { kind: 'StopLoss', price: 6_100_000_000n }, position: 'Long' },
    });
    const tpMarket = buildPlaceAction({
      ...base,
      side: 'sell',
      type: 'take_profit_market',
      price: undefined,
      triggerPrice: '70000',
      referencePrice: '70000',
      slippage: 0.02,
      position: 'Long',
    });
    expect(tpMarket).toMatchObject({
      type: 'PlaceWith',
      tif: 'Ioc',
      price: 6_860_000_000n,
      opts: { trigger: { kind: 'TakeProfit', price: 7_000_000_000n } },
    });
    expect(() => buildPlaceAction({ ...base, type: 'stop_limit' })).toThrow(OrderIntentError);
    expect(() => buildPlaceAction({ ...base, triggerPrice: '1' })).toThrow(OrderIntentError);
  });

  it('到期高度走 PlaceWith', () => {
    expect(buildPlaceAction({ ...base, goodTilBlock: 1_000n })).toMatchObject({
      type: 'PlaceWith',
      opts: { goodTilBlock: 1_000n, reduceOnly: false },
    });
    expect(() => buildPlaceAction({ ...base, goodTilBlock: -1n })).toThrow(OrderIntentError);
  });
});

describe('其他动作', () => {
  it('撤单、全撤、改单、调杠杆', () => {
    expect(buildCancelAction(7, 0, 42n)).toEqual({ type: 'Cancel', account: 7, market: 0, orderId: 42n });
    expect(buildCancelAllAction(7, 3)).toEqual({ type: 'CancelAll', account: 7, market: 3 });
    expect(buildCancelAllAction(7, 'all')).toEqual({ type: 'CancelAll', account: 7, market: ALL_MARKETS });
    expect(
      buildModifyAction({ account: 7, market: btc, orderId: 42n, price: '65001', size: '0.02' }),
    ).toEqual({
      type: 'Modify',
      account: 7,
      market: 0,
      orderId: 42n,
      price: 6_500_100_000n,
      size: 200_000_000n,
    });
    expect(buildSetLeverageAction(7, 0, 200_000)).toEqual({
      type: 'SetLeverage',
      account: 7,
      market: 0,
      imfPpm: 200_000,
    });
    expect(() => buildSetLeverageAction(7, 0, 0)).toThrow();
  });

  it('平仓按槽位选方向，市价需参考价', () => {
    expect(
      buildClosePositionAction({ account: 7, market: btc, position: 'Long', size: '0.01', price: '66000' }),
    ).toMatchObject({
      type: 'Place',
      side: 'Ask',
      position: 'Long',
      tif: 'Gtc',
    });
    expect(
      buildClosePositionAction({
        account: 7,
        market: btc,
        position: 'Short',
        size: '0.01',
        referencePrice: '65000',
      }),
    ).toMatchObject({ type: 'Place', side: 'Bid', position: 'Short', tif: 'Ioc', price: 6_565_000_000n });
    expect(() =>
      buildClosePositionAction({ account: 7, market: btc, position: 'Short', size: '0.01' }),
    ).toThrow(OrderIntentError);
  });
});

// ───────────────────────── TWAP / Scaled / TP-SL / 逐仓保证金 ─────────────────────────
import { encodeAction } from '../src/codec.js';
import {
  buildScaledAction,
  buildTpSlActions,
  buildTwapAction,
  buildUpdateIsolatedMarginAction,
} from '../src/orders.js';

describe('buildTwapAction', () => {
  it('把时长 / 间隔 / 容忍度换成链字段，无价则 0（按 oracle 价）', () => {
    const action = buildTwapAction({
      account: 7,
      market: btc,
      side: 'sell',
      size: '1',
      durationS: 3_600,
      intervalS: 60,
      tolerance: 0.005,
    });
    expect(action).toEqual({
      type: 'PlaceTwap',
      account: 7,
      market: 0,
      side: 'Ask',
      price: 0n,
      size: 10_000_000_000n,
      durationS: 3_600,
      intervalS: 60,
      tolerancePpm: 5_000,
      position: 'Short',
      isCross: true,
    });
    expect(encodeAction(action)).toHaveLength(48);
    const priced = buildTwapAction({
      account: 7,
      market: btc,
      side: 'buy',
      size: '1',
      price: '65000',
      durationS: 600,
      intervalS: 30,
      reduceOnly: true,
    });
    expect(priced).toMatchObject({ price: 6_500_000_000n, position: 'Short', tolerancePpm: 10_000 });
  });

  it('链的边界：间隔 / 时长范围、整数倍、每腿至少一步', () => {
    const ok = { account: 7, market: btc, side: 'buy' as const, size: '1', durationS: 600, intervalS: 60 };
    expect(() => buildTwapAction({ ...ok, intervalS: 29 })).toThrow(OrderIntentError);
    expect(() => buildTwapAction({ ...ok, intervalS: 3_601, durationS: 7_202 })).toThrow(OrderIntentError);
    expect(() => buildTwapAction({ ...ok, durationS: 299 })).toThrow(OrderIntentError);
    expect(() => buildTwapAction({ ...ok, durationS: 86_401 })).toThrow(OrderIntentError);
    expect(() => buildTwapAction({ ...ok, durationS: 601 })).toThrow(/整数倍/);
    expect(() => buildTwapAction({ ...ok, size: '0.0005' })).toThrow(/每腿/);
    expect(() => buildTwapAction({ ...ok, tolerance: 1 })).toThrow(/容忍度/);
  });
});

describe('buildScaledAction', () => {
  it('Equal 线性阶梯；比率 / 差值分布的幅度换成 ppm', () => {
    const action = buildScaledAction({
      account: 7,
      market: btc,
      side: 'buy',
      size: '1',
      lowestPrice: '60000',
      highestPrice: '65000',
      numOrders: 10,
    });
    expect(action).toEqual({
      type: 'PlaceScaled',
      account: 7,
      market: 0,
      side: 'Bid',
      size: 10_000_000_000n,
      tif: 'Gtc',
      opts: { reduceOnly: false, goodTilBlock: 0n, position: 'Long', isCross: true },
      params: {
        lowestPrice: 6_000_000_000n,
        highestPrice: 6_500_000_000n,
        numOrders: 10,
        profile: 'Equal',
        spacing: 'Linear',
        magnitudePpm: 0,
      },
    });
    expect(encodeAction(action)).toHaveLength(48);
    const ratio = buildScaledAction({
      account: 7,
      market: btc,
      side: 'sell',
      size: '1',
      lowestPrice: '60000',
      highestPrice: '65000',
      numOrders: 5,
      profile: 'DecRatio',
      spacing: 'Geometric',
      magnitude: 0.15,
      tif: 'ioc',
      isCross: false,
    });
    expect(ratio).toMatchObject({
      tif: 'Ioc',
      opts: { position: 'Short', isCross: false },
      params: { profile: 'DecRatio', spacing: 'Geometric', magnitudePpm: 150_000 },
    });
  });

  it('链的边界：子单数、价格区间、幅度范围', () => {
    const ok = {
      account: 7,
      market: btc,
      side: 'buy' as const,
      size: '1',
      lowestPrice: '60000',
      highestPrice: '65000',
      numOrders: 5,
    };
    expect(() => buildScaledAction({ ...ok, numOrders: 1 })).toThrow(OrderIntentError);
    expect(() => buildScaledAction({ ...ok, numOrders: 51 })).toThrow(OrderIntentError);
    expect(() => buildScaledAction({ ...ok, highestPrice: '60000' })).toThrow(/最高价/);
    expect(() => buildScaledAction({ ...ok, profile: 'IncRatio' })).toThrow(/幅度/);
    expect(() => buildScaledAction({ ...ok, profile: 'IncRatio', magnitude: 1 })).toThrow(/幅度/);
    // 差值型上限 2e6/(n-1)：n=5 → 0.5。
    expect(() => buildScaledAction({ ...ok, profile: 'IncDiff', magnitude: 0.5 })).toThrow(/幅度/);
    expect(buildScaledAction({ ...ok, profile: 'IncDiff', magnitude: 0.49 }).type).toBe('PlaceScaled');
  });
});

describe('buildTpSlActions', () => {
  it('Long 槽位：止盈 / 止损都是卖出、reduce-only；无限价用触发价加滑点作保护价（IOC）', () => {
    const actions = buildTpSlActions({
      account: 7,
      market: btc,
      position: 'Long',
      size: '0.5',
      takeProfit: { triggerPrice: '70000' },
      stopLoss: { triggerPrice: '60000', limitPrice: '59900' },
      slippage: 0.01,
    });
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      type: 'PlaceWith',
      side: 'Ask',
      tif: 'Ioc',
      // 70000 × (1 − 1%) = 69300
      price: 6_930_000_000n,
      opts: { reduceOnly: true, position: 'Long', trigger: { kind: 'TakeProfit', price: 7_000_000_000n } },
    });
    expect(actions[1]).toMatchObject({
      type: 'PlaceWith',
      side: 'Ask',
      tif: 'Gtc',
      price: 5_990_000_000n,
      opts: { reduceOnly: true, position: 'Long', trigger: { kind: 'StopLoss', price: 6_000_000_000n } },
    });
    const short = buildTpSlActions({
      account: 7,
      market: btc,
      position: 'Short',
      size: '0.5',
      stopLoss: { triggerPrice: '70000' },
    });
    expect(short[0]).toMatchObject({
      side: 'Bid',
      tif: 'Ioc',
      price: 7_070_000_000n,
      opts: { position: 'Short' },
    });
    expect(() => buildTpSlActions({ account: 7, market: btc, position: 'Long', size: '1' })).toThrow(/至少/);
  });
});

describe('buildUpdateIsolatedMarginAction', () => {
  it('正数划入、负数划出，0 拒绝', () => {
    expect(buildUpdateIsolatedMarginAction(7, 0, 'Long', '12.5')).toEqual({
      type: 'UpdateIsolatedMargin',
      account: 7,
      market: 0,
      position: 'Long',
      amount: 12_500_000n,
    });
    expect(buildUpdateIsolatedMarginAction(7, 0, 'Short', '-3')).toMatchObject({ amount: -3_000_000n });
    expect(() => buildUpdateIsolatedMarginAction(7, 0, 'Long', '0')).toThrow(/不能为 0/);
  });
});
