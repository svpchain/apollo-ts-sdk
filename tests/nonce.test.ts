import { describe, expect, it } from 'vitest';

import { NonceAllocator, type NonceStorage, nonceAcceptedByWindow } from '../src/nonce.js';

function memoryStorage(): NonceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('NonceAllocator', () => {
  it('以微秒时间戳为基数且严格递增', () => {
    let now = 1_700_000_000_000;
    const alloc = new NonceAllocator({ now: () => now });
    const first = alloc.next(7);
    expect(first).toBe(1_700_000_000_000_000n);
    // 同一毫秒内连续调用 +1。
    expect(alloc.next(7)).toBe(first + 1n);
    expect(alloc.next(7)).toBe(first + 2n);
    // 时钟前进后回到时间基数。
    now += 5;
    expect(alloc.next(7)).toBe(1_700_000_000_005_000n);
    // 时钟回拨不回退。
    now -= 100;
    expect(alloc.next(7)).toBe(1_700_000_000_005_001n);
    // 不同账户互不影响。
    expect(alloc.next(8)).toBe(1_699_999_999_905_000n);
  });

  it('跨标签页通过 storage 共享最后发出的 nonce', () => {
    const storage = memoryStorage();
    const now = () => 1_700_000_000_000;
    const tabA = new NonceAllocator({ now, storage, namespace: 'devnet' });
    const tabB = new NonceAllocator({ now, storage, namespace: 'devnet' });
    const a = tabA.next(1);
    const b = tabB.next(1);
    expect(b).toBe(a + 1n);
    expect(tabA.next(1)).toBe(b + 1n);
    expect(storage.data.get('devnet:nonce:1')).toBe((b + 1n).toString());
    // 不同命名空间（链 / 环境）的 nonce 互不干扰。
    const other = new NonceAllocator({ now, storage, namespace: 'testnet' });
    expect(other.next(1)).toBe(1_700_000_000_000_000n);
  });

  it('与链上 last_nonce 同步只会抬高、不会回退', () => {
    const alloc = new NonceAllocator({ now: () => 1_000 });
    alloc.syncFromChain(3, 5_000_000n);
    expect(alloc.next(3)).toBe(5_000_001n);
    alloc.syncFromChain(3, 10n);
    expect(alloc.next(3)).toBe(5_000_002n);
    expect(alloc.peek(3)).toBe(5_000_002n);
    expect(alloc.peek(4)).toBe(0n);
  });

  it('storage 写入失败时退化为内存单调', () => {
    const broken: NonceStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    const alloc = new NonceAllocator({ now: () => 1, storage: broken });
    expect(alloc.next(1)).toBe(1_000n);
    expect(alloc.next(1)).toBe(1_001n);
  });
});

describe('nonceAcceptedByWindow', () => {
  it('符合链的规则：大于窗口首元素且不在窗口中', () => {
    const empty = Array<bigint>(16).fill(0n);
    expect(nonceAcceptedByWindow(0n, empty)).toBe(false);
    expect(nonceAcceptedByWindow(1n, empty)).toBe(true);
    const partial = [0n, 0n, 0n, 5n, 9n];
    expect(nonceAcceptedByWindow(3n, partial)).toBe(true);
    expect(nonceAcceptedByWindow(5n, partial)).toBe(false);
    const full = Array.from({ length: 16 }, (_, i) => BigInt(100 + i));
    expect(nonceAcceptedByWindow(100n, full)).toBe(false);
    expect(nonceAcceptedByWindow(101n, full)).toBe(false);
    expect(nonceAcceptedByWindow(99n, full)).toBe(false);
    expect(nonceAcceptedByWindow(116n, full)).toBe(true);
  });
});
