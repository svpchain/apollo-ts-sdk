# Historical Data

English | [简体中文](../zh-CN/reference/HISTORY.md)

Historical data is served by the target archive node and its index. `Info` methods handle the queries; whether history is complete depends on the data range the node retains.

## Index status: indexStatus

**Purpose**: confirm the earliest queryable height and whether the index has caught up with the chain.

```ts
const index = await info.indexStatus();
console.log(index.firstHeight, index.indexedHeight, index.executedHeight);
```

| Returned field | Meaning |
| --- | --- |
| `firstHeight` | Height at which the node's history records begin |
| `indexedHeight` | Height processed by the history index |
| `executedHeight` | Node's current executed height |

If the index lags, recent transactions may not yet appear in history; if the node started from a snapshot, history before the snapshot may also be unavailable. An empty list alone does not prove a transaction did not happen.

## Fills: userFills

**Purpose**: read actual fills for an account or market, for displaying fills and reconciling positions and trades.

```text
info.userFills(params, options?)
```

| Parameter | Type | Description |
| --- | --- | --- |
| `account` | `bigint`, optional | On-chain account ID |
| `market` | `number`, optional | Market ID; 0 is a valid value |
| `fromHeight` | `bigint`, optional | Starting height |
| `after` | `{ height, index }`, optional | Cursor returned by the previous page |
| `limit` | `number`, optional | Up to 1,000; 0 or omitted uses the default of 100 |

```ts
const page = await info.userFills({ account: BigInt(account), limit: 100 });
console.log(page.fills, page.index);
if (page.next) {
  const nextPage = await info.userFills({
    account: BigInt(account), limit: 100, after: page.next,
  });
  console.log(nextPage.fills);
}
```

**Returns**: the `fills` list, `index` status, and an optional `next` cursor. For the next page, keep the original filters and only update `after`.

Fill prices and sizes must be converted using market precision. Successful order execution and an actual fill are separate checks; your application should verify the account, order, and filled size.

## Account fees and fill rebates: userFees

**Purpose**: total this account's trading fees and fill rebates from fill records, including maker / taker roles and per-market summaries.

```ts
import { microUsdToUsd } from '@svpchain/trading-sdk';

const page = await info.userFees({ account, limit: 100 });
console.log({
  paid: microUsdToUsd(page.summary.feesPaid),
  rebates: microUsdToUsd(page.summary.rebates),
  net: microUsdToUsd(page.summary.netFees),
});
console.log(page.summary.byMarket, page.index, page.next);
```

Parameters match the filters of `userFills()`, but `account` is a required number. Returns `summary`, `index`, and an optional `next`; each call queries and summarizes only one page of fills.

| Summary field | Meaning |
| --- | --- |
| `makerFees` / `takerFees` | Signed fees of this account in each role; negative values are rebates |
| `feesPaid` / `rebates` | Positive amounts of fees paid and rebates |
| `netFees` | Fees paid minus rebates; negative means net rebates received |
| `fillCount` | Number of fill records involving this account |
| `makerFillCount` / `takerFillCount` | Number of fill records per role |
| `byMarket` | Per-market fees and counts, sorted by market ID |

All amounts are micro-USD `bigint`s, and arithmetic never goes through JS numbers. When both sides of a fill are this account, its fees count toward both sides while fillCount counts it once. Fees are taken from each fill's makerFee / takerFee, and rebates are counted from negative fees among them.

Example of computing net fees across pages:

```ts
import { type UserFeesParams, microUsdToUsd } from '@svpchain/trading-sdk';

let after: UserFeesParams['after'];
let netFees = 0n;
do {
  const page = await info.userFees({ account, fromHeight: 0n, after, limit: 1000 });
  netFees += page.summary.netFees;
  after = page.next;
} while (after);
console.log(microUsdToUsd(netFees));
```

The loop should keep the same filters to avoid adding the same page twice. The chain and index may keep advancing during the scan, and each page returns the index status at the time of that query. Results cover the history range queryable on the node; when displaying totals, also record firstHeight, indexedHeight, and the executed height.

If you already have fill records, you can summarize them directly without querying the node:

```ts
import { summarizeFees } from '@svpchain/trading-sdk';

const page = await info.userFills({ account: BigInt(account), limit: 100 });
const summary = summarizeFees(account, page.fills);
console.log(summary.netFees, summary.byMarket);
```

## Order actions and account actions: historicalOrders / actionHistory

**Purpose**: review operations such as placing, cancelling, and modifying orders, or the account's broader action history.

```ts
const orderActions = await info.historicalOrders({ account: BigInt(account), limit: 100 });
const allActions = await info.actionHistory({ account: BigInt(account), limit: 100 });
for (const action of orderActions.actions) console.log(action.kind, action.result);
console.log(allActions.next);
```

Both methods take the same parameters: `account: bigint`, optional `fromHeight: bigint`, `after`, and `limit`. Application calls must provide an account ID.

**Returns**: `actions`, `index`, and an optional `next`. Each item contains the action kind, execution result, and its position within the block.

`historicalOrders()` returns order-related actions and execution records. To determine whether an order was filled, check it together with current open orders, filled size, and action execution results.

## Candles: candlesSnapshot

**Purpose**: read trade candles for a market over a time range.

```ts
import { history } from '@svpchain/trading-sdk/protocol';

const market = await info.market('BTC-USD');
const candles = await info.candlesSnapshot({
  market: market.id,
  interval: history.CandleInterval.CANDLE_INTERVAL_1M,
  fromUnixS: 1700000000n,
  toUnixS: 1700003600n,
  limit: 100,
});
console.log(candles.candles);
```

The timestamps in the example are for illustration only; replace them with a range that has data on the target chain.

| Parameter | Type | Description |
| --- | --- | --- |
| `market` | `number` | Market ID |
| `interval` | `history.CandleInterval` | 1m, 5m, 15m, 1h, 4h, 1d |
| `fromUnixS` / `toUnixS` | `bigint` | Unix seconds; an end time of 0 means now |
| `limit` | `number` | Up to 1,000; default 100 |

**Returns**: `candles` and `index`. Each candle contains the start second, open/high/low/close, base-asset volume, and trade count.

Use `priceUnitsToPrice()` for OHLC prices and `quantumsToSize()` for volume. Intervals with no trades may return no candle; do not assume the returned array maps one-to-one to each minute. The SDK does not fill gaps in or cache candles.

## Market funding index: fundingHistory

**Purpose**: query historical samples of a market's cumulative funding index.

```ts
const market = await info.market('BTC-USD');
const funding = await info.fundingHistory({ market: market.id, fromHeight: 0n, limit: 100 });
for (const point of funding.points) console.log(point.height, point.fundingIndex);
```

Parameters are `market: number`, optional `fromHeight: bigint`, and `limit: number`. Returns `points` and `index`; each point is a height and its funding index.

fundingIndex is the market's cumulative settlement index. Read index changes by market and height to analyze cumulative funding.

Continue with [result handling](RESULTS.md) to learn how to handle submit timeouts, missing records in the action cache, and history index lag.
