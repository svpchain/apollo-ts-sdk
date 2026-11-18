// Action 编解码按协议向量（tests/vectors/actions.json）逐字节比对。
// 向量变了说明链的编码变了：先确认是有意为之，再同步更新 codec.ts。
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import {
  ACTION_BYTES,
  ALL_MARKETS,
  type Action,
  ActionDecodeError,
  ActionEncodeError,
  actionFromHex,
  agentMay,
  decodeAction,
  encodeAction,
} from '../src/codec.js';
import vectors from './vectors/actions.json' with { type: 'json' };
import { actionFromVector, type VectorFile } from './vectors/read.js';

const file = vectors as VectorFile;

describe('Action 编码向量', () => {
  it('向量文件来自当前契约版本', () => {
    expect(file.version).toBe(1);
    expect(file.sizes.action).toBe(ACTION_BYTES);
    expect(file.actions.length).toBeGreaterThanOrEqual(20);
  });

  for (const vector of file.actions) {
    it(`${vector.name} 编码一致`, () => {
      const action = actionFromVector(vector.action);
      expect(bytesToHex(encodeAction(action))).toBe(vector.encoded);
    });

    it(`${vector.name} 解码回同一 action`, () => {
      const decoded = decodeAction(hexToBytes(vector.encoded));
      expect(decoded).toEqual(actionFromVector(vector.action));
    });

    it(`${vector.name} 的 agent 权限与链一致`, () => {
      // 向量里只有 agent 可签的 action 才带 agent 签名。
      expect(agentMay(actionFromVector(vector.action))).toBe(vector.agent !== undefined);
    });
  }
});

describe('encodeAction 的边界校验', () => {
  const base: Action = {
    type: 'Place',
    account: 1,
    market: 0,
    side: 'Bid',
    price: 1n,
    size: 1n,
    tif: 'Gtc',
    position: 'Long',
    isCross: true,
  };

  it('越界字段抛错而不是截断', () => {
    expect(() => encodeAction({ ...base, account: 2 ** 32 })).toThrow(ActionEncodeError);
    expect(() => encodeAction({ ...base, market: 70_000 })).toThrow(ActionEncodeError);
    expect(() => encodeAction({ ...base, price: 1n << 63n })).toThrow(ActionEncodeError);
    expect(() => encodeAction({ ...base, size: -(1n << 63n) - 1n })).toThrow(ActionEncodeError);
    expect(() => encodeAction({ type: 'Cancel', account: 1, market: 0, orderId: -1n })).toThrow(
      ActionEncodeError,
    );
    expect(() =>
      encodeAction({ type: 'ApproveAgent', account: 1, slot: 1, key: new Uint8Array(31), expiry: 0n }),
    ).toThrow(ActionEncodeError);
  });

  it('builder 费率为 0 或超上限时拒绝（链上会解码失败）', () => {
    const withBuilder = (feePpm: number): Action => ({
      type: 'PlaceWith',
      account: 1,
      market: 0,
      side: 'Bid',
      price: 1n,
      size: 1n,
      tif: 'Gtc',
      opts: {
        reduceOnly: false,
        goodTilBlock: 0n,
        builder: { account: 9, feePpm },
        position: 'Long',
        isCross: true,
      },
    });
    expect(() => encodeAction(withBuilder(0))).toThrow(ActionEncodeError);
    expect(() => encodeAction(withBuilder(10_001))).toThrow(ActionEncodeError);
    expect(encodeAction(withBuilder(10_000))).toHaveLength(ACTION_BYTES);
  });

  it('CancelAll 的全市场常量与链一致', () => {
    const bytes = encodeAction({ type: 'CancelAll', account: 1, market: ALL_MARKETS });
    expect(bytes[8]).toBe(0xff);
    expect(bytes[9]).toBe(0xff);
  });
});

describe('decodeAction 严格校验', () => {
  function encodedWith(name: string, patch: (b: Uint8Array) => void): Uint8Array {
    const vector = file.actions.find((v) => v.name === name);
    if (!vector) throw new Error(`没有向量 ${name}`);
    const bytes = hexToBytes(vector.encoded);
    patch(bytes);
    return bytes;
  }

  it('Deposit 解出地址与金额，其余非用户 action 返回 undefined', () => {
    const deposit = file.operator.actions.find((v) => v.name === 'deposit_opens_account');
    if (!deposit) throw new Error('没有 operator 向量 deposit_opens_account');
    const decoded = decodeAction(hexToBytes(deposit.encoded));
    expect(decoded?.type).toBe('Deposit');
    if (decoded?.type === 'Deposit') {
      expect(bytesToHex(decoded.address)).toBe(deposit.action.address);
      expect(decoded.amount).toBe(BigInt(deposit.action.amount as string));
      expect(encodeAction(decoded)).toEqual(hexToBytes(deposit.encoded));
    }
    const oracle = new Uint8Array(ACTION_BYTES);
    oracle[0] = 6;
    expect(decodeAction(oracle)).toBeUndefined();
  });

  it('保留位被置位、无触发却带触发价、builder 无费率都报错', () => {
    expect(() => decodeAction(encodedWith('place_bid_gtc_long_cross', (b) => (b[3] |= 0x8)))).toThrow(
      ActionDecodeError,
    );
    expect(() => decodeAction(encodedWith('place_with_good_til_block', (b) => (b[24] = 1)))).toThrow(
      ActionDecodeError,
    );
    expect(() => decodeAction(encodedWith('place_with_good_til_block', (b) => (b[10] = 5)))).toThrow(
      ActionDecodeError,
    );
    expect(() => decodeAction(encodedWith('set_leverage', (b) => (b[20] = 1)))).toThrow(ActionDecodeError);
    expect(() => decodeAction(encodedWith('place_scaled', (b) => (b[11] = 1)))).toThrow(ActionDecodeError);
  });

  it('太短的输入报错，hex 入口接受 0x 前缀', () => {
    expect(() => decodeAction(new Uint8Array(47))).toThrow(ActionDecodeError);
    const vector = file.actions[0];
    expect(actionFromHex(`0x${vector.encoded}`)).toEqual(actionFromVector(vector.action));
  });
});
