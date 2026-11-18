# 历史数据

[English](../../reference/HISTORY.md) | 简体中文

历史数据由目标 archive 节点及索引提供。`Info` 的方法负责查询，历史是否完整取决于该节点保存的数据范围。

## 索引状态：indexStatus

**用途**：确认能查到的最早高度，以及索引是否已经追上链。

```ts
const index = await info.indexStatus();
console.log(index.firstHeight, index.indexedHeight, index.executedHeight);
```

| 返回字段 | 含义 |
| --- | --- |
| `firstHeight` | 节点历史记录开始的高度 |
| `indexedHeight` | 历史索引处理到的高度 |
| `executedHeight` | 节点当前执行高度 |

如果索引落后，最近交易可能尚未出现在历史中；如果节点从快照启动，快照前的历史也可能不可查询。空列表不能单独证明交易没有发生。

## 成交：userFills

**用途**：读取账户或市场的实际成交，用于成交展示、仓位和交易对账。

```text
info.userFills(params, options?)
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `account` | `bigint`，可选 | 链上账户 ID |
| `market` | `number`，可选 | 市场 ID，0 是有效值 |
| `fromHeight` | `bigint`，可选 | 起始高度 |
| `after` | `{ height, index }`，可选 | 上一页返回的游标 |
| `limit` | `number`，可选 | 最多 1,000；0 或不传使用默认 100 |

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

**返回**：`fills` 成交列表、`index` 索引状态、可选 `next` 游标。下一页保留原过滤条件，仅更新 `after`。

成交价格和数量需按市场精度转换。订单执行成功与实际产生 fill 是不同判断；业务应核对所属账户、订单和成交数量。

## 账户手续费与成交返佣：userFees

**用途**：统计成交记录中的本账户交易手续费和成交返佣，包括 maker / taker 角色和分市场汇总。

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

参数与 `userFills()` 的过滤条件一致，但 `account` 是必填的 number。返回 `summary`、`index` 和可选 `next`；每次只查询、汇总一页成交。

| 汇总字段 | 含义 |
| --- | --- |
| `makerFees` / `takerFees` | 本账户在两种角色下的有符号费用，负数表示返佣 |
| `feesPaid` / `rebates` | 支付与返佣的正数金额 |
| `netFees` | 支付减返佣，负数表示净收到返佣 |
| `fillCount` | 涉及本账户的成交记录数 |
| `makerFillCount` / `takerFillCount` | 各角色的成交记录数 |
| `byMarket` | 按市场 ID 排序的各市场费用和计数 |

金额均为微 USD 的 bigint，运算不经过 JS number。同一笔成交两侧都是本账户时，费用会同时计入两侧，fillCount 只计一次。费用口径为每条成交中的 makerFee / takerFee，返佣按其中的负手续费统计。

跨页求净费用示例：

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

循环应保留相同过滤条件，避免重复累加同一页。扫描期间链和索引可能继续前进，各页返回当次查询的索引状态。结果覆盖节点可查询的历史范围；展示汇总时应同时记录 firstHeight、indexedHeight 和执行高度。

已取得成交记录时可直接汇总，不再请求节点：

```ts
import { summarizeFees } from '@svpchain/trading-sdk';

const page = await info.userFills({ account: BigInt(account), limit: 100 });
const summary = summarizeFees(account, page.fills);
console.log(summary.netFees, summary.byMarket);
```

## 订单动作与账户动作：historicalOrders / actionHistory

**用途**：核查下单、撤单、改单等操作，或账户的更广泛动作历史。

```ts
const orderActions = await info.historicalOrders({ account: BigInt(account), limit: 100 });
const allActions = await info.actionHistory({ account: BigInt(account), limit: 100 });
for (const action of orderActions.actions) console.log(action.kind, action.result);
console.log(allActions.next);
```

两个方法接收相同参数：`account: bigint`、可选 `fromHeight: bigint`、`after`、`limit`。业务调用必须提供账户 ID。

**返回**：`actions`、`index`、可选 `next`。每项含动作种类、执行结果和所在区块内位置。

`historicalOrders()` 返回订单相关的动作与执行记录。判断订单成交情况时，结合当前挂单、成交数量和动作执行结果核查。

## K 线：candlesSnapshot

**用途**：读取某市场在时间范围内的成交 K 线。

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

示例时间为参数演示，实际替换为目标链有数据的范围。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `market` | `number` | 市场 ID |
| `interval` | `history.CandleInterval` | 1m、5m、15m、1h、4h、1d |
| `fromUnixS` / `toUnixS` | `bigint` | Unix 秒；结束时间为 0 表示当前时间 |
| `limit` | `number` | 最多 1,000；默认 100 |

**返回**：`candles` 和 `index`。每根 K 线含起始秒、开高低收、基础币成交数量和成交笔数。

OHLC 价格使用 `priceUnitsToPrice()`，成交量使用 `quantumsToSize()`。无成交的区间可能不返回 K 线；不要假定返回数组与每分钟时间刻度一一对应。SDK 不自动补齐或缓存 K 线。

## 市场资金费指数：fundingHistory

**用途**：查询市场资金费累计指数的历史采样。

```ts
const market = await info.market('BTC-USD');
const funding = await info.fundingHistory({ market: market.id, fromHeight: 0n, limit: 100 });
for (const point of funding.points) console.log(point.height, point.fundingIndex);
```

参数为 `market: number`、可选 `fromHeight: bigint`、`limit: number`。返回 `points` 和 `index`，每项为高度及资金费指数。

fundingIndex 是市场累计结算指数。按市场和高度读取指数变化，用于分析资金费累计情况。

继续阅读 [结果处理](RESULTS.md)，了解提交超时、动作缓存无记录及历史索引延迟时的处理。
