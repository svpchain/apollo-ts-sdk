import { describe, it, expect, vi } from 'vitest';
import { Info, summarizeFees, type FeeFill, type UserFeesParams } from '../src/index.js';

function fill(fields: Partial<FeeFill> = {}): FeeFill {
  return { market: 0, makerAccount: 7n, takerAccount: 8n, makerFee: -20n, takerFee: 100n, ...fields };
}
describe('fee summaries without chain changes', () => {
  it('counts only the account side, includes both self-trade sides and groups markets', () => {
    const fills = Object.freeze([
      Object.freeze(fill({ market: 2 })),
      Object.freeze(fill({ market: 0, makerAccount: 8n, takerAccount: 7n, takerFee: 100n })),
      Object.freeze(fill({ market: 2, makerAccount: 7n, takerAccount: 7n, makerFee: -10n, takerFee: 50n })),
      Object.freeze(fill({ makerAccount: 8n, takerAccount: 9n })),
    ]);
    const summary = summarizeFees(7, fills);
    expect(summary).toEqual({
      account: 7,
      makerFees: -30n,
      takerFees: 150n,
      feesPaid: 150n,
      rebates: 30n,
      netFees: 120n,
      fillCount: 3,
      makerFillCount: 2,
      takerFillCount: 2,
      byMarket: [
        {
          market: 0,
          makerFees: 0n,
          takerFees: 100n,
          feesPaid: 100n,
          rebates: 0n,
          netFees: 100n,
          fillCount: 1,
          makerFillCount: 0,
          takerFillCount: 1,
        },
        {
          market: 2,
          makerFees: -30n,
          takerFees: 50n,
          feesPaid: 50n,
          rebates: 30n,
          netFees: 20n,
          fillCount: 2,
          makerFillCount: 2,
          takerFillCount: 1,
        },
      ],
    });
  });
  it('preserves amounts above JS safe integers and allows a net rebate', () => {
    expect(summarizeFees(7, [fill({ makerFee: -9007199254740993n })])).toMatchObject({
      rebates: 9007199254740993n,
      netFees: -9007199254740993n,
    });
    expect(
      summarizeFees(7, [fill({ makerFee: 9007199254740993n }), fill({ makerFee: 9007199254740993n })]),
    ).toMatchObject({ feesPaid: 18014398509481986n, netFees: 18014398509481986n });
  });
  it('returns zero for empty/unrelated records and counts zero-fee fills', () => {
    expect(summarizeFees(7, [])).toMatchObject({ netFees: 0n, fillCount: 0, byMarket: [] });
    expect(summarizeFees(7, [fill({ makerAccount: 8n })])).toMatchObject({ netFees: 0n, fillCount: 0 });
    expect(summarizeFees(7, [fill({ makerFee: 0n })])).toMatchObject({
      netFees: 0n,
      fillCount: 1,
      makerFillCount: 1,
    });
    expect(summarizeFees(7, [fill({ makerAccount: 8n, takerAccount: 7n, takerFee: -5n })])).toMatchObject({
      takerFees: -5n,
      rebates: 5n,
      netFees: -5n,
    });
  });
  it('rejects invalid accounts and lossy numeric fee inputs', () => {
    for (const account of [0, -1, 1.5, 2 ** 32]) expect(() => summarizeFees(account, [])).toThrow();
    expect(() => summarizeFees(7, [fill({ makerFee: 10 as unknown as bigint })])).toThrow(/bigint/);
    expect(() => summarizeFees(7, [fill({ market: -1 })])).toThrow(/u32/);
  });
  it('queries one page with exact filters and preserves index and next for the caller', async () => {
    const calls: any[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body));
      calls.push(q);
      const first = q.params.after === undefined;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: q.id,
          result: {
            index: { firstHeight: '50', indexedHeight: '200', executedHeight: '205' },
            fills: [
              {
                height: first ? '100' : '101',
                market: 0,
                makerAccount: first ? '7' : '8',
                takerAccount: first ? '8' : '7',
                makerFee: '-20',
                takerFee: '100',
              },
            ],
            ...(first ? { next: { height: '100', index: 2 } } : {}),
          },
        }),
      );
    }) as typeof globalThis.fetch;
    const info = new Info({ baseUrl: 'https://node.example', fetch });
    const params: UserFeesParams = { account: 7, market: 0, fromHeight: 50n, limit: 100 };
    const page1 = await info.userFees(params);
    expect(calls[0]).toMatchObject({
      method: 'apollo.v1.HistoryService.GetFills',
      params: { account: '7', market: 0, fromHeight: '50', limit: 100 },
    });
    expect(page1.summary).toMatchObject({ makerFees: -20n, netFees: -20n, fillCount: 1 });
    expect(page1.index).toMatchObject({ firstHeight: 50n, indexedHeight: 200n, executedHeight: 205n });
    expect(page1.next).toMatchObject({ height: 100n, index: 2 });
    const page2 = await info.userFees({ ...params, after: page1.next });
    expect(calls[1].params.after).toEqual({ height: '100', index: 2 });
    expect(page2.summary).toMatchObject({ takerFees: 100n, netFees: 100n, fillCount: 1 });
    expect(page2.next).toBeUndefined();
    expect(params).toEqual({ account: 7, market: 0, fromHeight: 50n, limit: 100 });
    expect(calls).toHaveLength(2);
    await expect(info.userFees({ account: 0 })).rejects.toThrow(/u32/);
    expect(calls).toHaveLength(2);
  });
  it('propagates archive RPC failures instead of reporting zero fees', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32002, message: 'archive unavailable' } }),
      );
    }) as typeof globalThis.fetch;
    const info = new Info({ baseUrl: 'https://node.example', fetch });
    await expect(info.userFees({ account: 7 })).rejects.toThrow(/archive unavailable/);
  });
});
