// 同一客户端实例内按账户单调分配 nonce；默认使用毫秒时钟 × 1000。
// storage 仅用于恢复最近值，不提供跨标签页/进程的原子锁；多个签名进程必须共享原子 NonceManager。

export interface NonceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NonceAllocatorOptions {
  /** 当前时间（毫秒）；默认 `Date.now`，测试可注入。 */
  now?: () => number;
  /** 持久化最近值；不保证跨标签页并发互斥，缺省只在内存里记。 */
  storage?: NonceStorage;
  /** storage 键前缀；不同链 / 环境用不同前缀，避免 nonce 串链。 */
  namespace?: string;
}

const MICROS_PER_MILLI = 1000n;

export class NonceAllocator {
  private readonly now: () => number;
  private readonly storage?: NonceStorage;
  private readonly namespace: string;
  private readonly last = new Map<number, bigint>();

  constructor(options: NonceAllocatorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.storage = options.storage;
    this.namespace = options.namespace ?? 'apollo';
  }

  /**
   * 下一个 nonce：max(当前微秒时间, 最后发出 + 1)。
   * 微秒基数留出同一毫秒内 1000 个序号，连续调用仍严格递增。
   */
  next(account: number): bigint {
    const fromClock = BigInt(Math.max(0, Math.floor(this.now()))) * MICROS_PER_MILLI;
    const last = this.read(account);
    const nonce = fromClock > last ? fromClock : last + 1n;
    this.write(account, nonce);
    return nonce;
  }

  /**
   * 用链上 `GetNonce.last_nonce` 对齐：本地若落后（换设备、时钟偏慢），之后发出的 nonce 都从链上
   * 最高值之上开始，避免落进窗口被拒。链上值更小时不回退本地，保持本地单调。
   */
  syncFromChain(account: number, lastNonceOnChain: bigint): void {
    if (lastNonceOnChain > this.read(account)) {
      this.write(account, lastNonceOnChain);
    }
  }

  /** 最后发出（或同步到）的 nonce；从未发出过为 0。 */
  peek(account: number): bigint {
    return this.read(account);
  }

  private key(account: number): string {
    return `${this.namespace}:nonce:${account}`;
  }

  private read(account: number): bigint {
    const inMemory = this.last.get(account) ?? 0n;
    let stored: string | null | undefined;
    try {
      stored = this.storage?.getItem(this.key(account));
    } catch {
      /* private mode: use memory */
    }
    let fromStorage = 0n;
    if (stored && /^\d+$/.test(stored)) {
      fromStorage = BigInt(stored);
    }
    return inMemory > fromStorage ? inMemory : fromStorage;
  }

  private write(account: number, nonce: bigint): void {
    this.last.set(account, nonce);
    try {
      this.storage?.setItem(this.key(account), nonce.toString());
    } catch {
      // storage 满或不可用时退化为内存单调，不阻断下单。
    }
  }
}

/**
 * 判断一个 nonce 会不会被链拒绝（BadNonce）：用
 * `GetNonce` 返回的窗口（升序，未填满处为 0），nonce 必须大于窗口首元素且不在窗口中。
 * 因此 0 永远不合法；窗口未填满时首元素为 0，任何未用过的正数都可以。
 */
export function nonceAcceptedByWindow(nonce: bigint, window: readonly bigint[]): boolean {
  const lowest = window.length > 0 ? window[0] : 0n;
  return nonce > lowest && !window.includes(nonce);
}
