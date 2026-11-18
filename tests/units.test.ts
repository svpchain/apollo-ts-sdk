import { describe, expect, it } from 'vitest';

import {
  type MarketUnits,
  UnitError,
  imfPpmToLeverage,
  isPriceOnTick,
  leverageToImfPpm,
  marketOrderPriceLimit,
  microUsdToUsd,
  priceToPriceUnits,
  priceToSubticks,
  priceUnitsToPrice,
  priceUnitsToSubticks,
  quantumsToSize,
  sizeToQuantums,
  subtickExponent,
  subticksToPrice,
  usdToMicroUsd,
} from '../src/units.js';

// 典型 BTC-USD 市场参数。
const btc: MarketUnits = {
  id: 0,
  priceExponent: -5,
  atomicResolution: -10,
  stepBaseQuantums: 1_000_000n,
  subticksPerTick: 100_000n,
  quantumConversionExponent: -9,
};

// 低价币：价格有更多小数位。
const doge: MarketUnits = {
  id: 7,
  priceExponent: -9,
  atomicResolution: -4,
  stepBaseQuantums: 1_000_000n,
  subticksPerTick: 1_000_000n,
  quantumConversionExponent: -9,
};

describe('数量 ↔ quantums', () => {
  it('向下取整到 step 且至少一个 step', () => {
    expect(sizeToQuantums('0.0015', btc)).toBe(15_000_000n);
    expect(sizeToQuantums('0.00015', btc)).toBe(1_000_000n);
    expect(sizeToQuantums('0.0000001', btc)).toBe(1_000_000n);
    expect(sizeToQuantums(2, btc)).toBe(20_000_000_000n);
    expect(quantumsToSize(15_000_000n, btc)).toBe('0.0015');
    expect(quantumsToSize(1n, doge)).toBe('0.0001');
  });

  it('拒绝零、负数与非数字', () => {
    expect(() => sizeToQuantums('0', btc)).toThrow(UnitError);
    expect(() => sizeToQuantums('-1', btc)).toThrow(UnitError);
    expect(() => sizeToQuantums('abc', btc)).toThrow(UnitError);
    expect(() => sizeToQuantums(Number.NaN, btc)).toThrow(UnitError);
  });
});

describe('价格 ↔ subticks', () => {
  it('指数为 atomic_resolution − qce + 6', () => {
    expect(subtickExponent(btc)).toBe(5);
    expect(subtickExponent(doge)).toBe(11);
  });

  it('限价向下取整到 tick', () => {
    expect(priceToSubticks('65432.1', btc)).toBe(6_543_200_000n);
    expect(priceToSubticks('65432.12345', btc)).toBe(6_543_200_000n);
    expect(priceToSubticks('65433', btc)).toBe(6_543_300_000n);
    expect(priceToSubticks('0.000001', btc)).toBe(100_000n);
    expect(priceToSubticks('0.12345678', doge)).toBe(12_345_000_000n);
  });

  it('ceil 用于买单保护价', () => {
    expect(priceToSubticks('65432.1', btc, 'ceil')).toBe(6_543_300_000n);
    expect(priceToSubticks('65433', btc, 'ceil')).toBe(6_543_300_000n);
  });

  it('subticks 反解回人类价格', () => {
    expect(subticksToPrice(6_543_200_000n, btc)).toBe('65432');
    expect(subticksToPrice(6_543_210_000n, btc)).toBe('65432.1');
    expect(subticksToPrice(12_345_000_000n, doge)).toBe('0.12345');
  });

  it('tick 校验', () => {
    expect(isPriceOnTick('65432', btc)).toBe(true);
    expect(isPriceOnTick('65432.1', btc)).toBe(false);
    expect(isPriceOnTick('0.12345', doge)).toBe(true);
    expect(isPriceOnTick('0.123456', doge)).toBe(false);
  });
});

describe('oracle / mark 价格单位', () => {
  it('10^price_exponent USD 与人类价格互转', () => {
    expect(priceUnitsToPrice(6_543_210_000n, btc)).toBe('65432.1');
    expect(priceToPriceUnits('65432.1', btc)).toBe(6_543_210_000n);
    expect(priceUnitsToPrice(123_456_789n, doge)).toBe('0.123456789');
  });

  it('mark 价转订单 subticks', () => {
    expect(priceUnitsToSubticks(6_543_210_000n, btc)).toBe(6_543_200_000n);
    expect(priceUnitsToSubticks(6_543_210_000n, btc, 'ceil')).toBe(6_543_300_000n);
  });
});

describe('金额', () => {
  it('micro-USD 与 USD 互转', () => {
    expect(microUsdToUsd(2_500_000_000n)).toBe('2500');
    expect(microUsdToUsd(-1_234_567n)).toBe('-1.234567');
    expect(usdToMicroUsd('1.2345678')).toBe(1_234_567n);
    expect(usdToMicroUsd(100)).toBe(100_000_000n);
  });
});

describe('市价单保护价', () => {
  it('买上浮 ceil、卖下浮 floor', () => {
    // 65000 × 1.01 = 65650 → 买单 ceil 到 tick；65000 × 0.99 = 64350 → 卖单 floor。
    expect(marketOrderPriceLimit('65000', 'buy', 0.01, btc)).toBe(6_565_000_000n);
    expect(marketOrderPriceLimit('65000', 'sell', 0.01, btc)).toBe(6_435_000_000n);
    // 不在 tick 上的结果向有利成交方向取整。
    expect(marketOrderPriceLimit('65432.1', 'buy', 0, btc)).toBe(6_543_300_000n);
    expect(marketOrderPriceLimit('65432.1', 'sell', 0, btc)).toBe(6_543_200_000n);
  });

  it('滑点范围校验', () => {
    expect(() => marketOrderPriceLimit('1', 'buy', -0.1, btc)).toThrow(UnitError);
    expect(() => marketOrderPriceLimit('1', 'buy', 1, btc)).toThrow(UnitError);
  });
});

describe('杠杆 ↔ IMF ppm', () => {
  it('倍数换成 ppm 向上取整，不低于目标杠杆对应 IMF', () => {
    expect(leverageToImfPpm(5)).toBe(200_000);
    expect(leverageToImfPpm('20')).toBe(50_000);
    expect(leverageToImfPpm(3)).toBe(333_334);
    expect(leverageToImfPpm(1)).toBe(1_000_000);
    expect(leverageToImfPpm(0.5)).toBe(1_000_000);
    expect(imfPpmToLeverage(200_000)).toBe('5');
    expect(imfPpmToLeverage(333_334)).toMatch(/^2\.99999/);
    expect(() => leverageToImfPpm(0)).toThrow(UnitError);
    expect(() => imfPpmToLeverage(0)).toThrow(UnitError);
  });
});
