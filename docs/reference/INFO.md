# 市场和账户查询

`Info` 提供只读查询，不需要钱包签名。下面的例子使用已初始化的 `info`；每个方法最后都可传 `{ signal }` 取消请求。

```ts
import { Info } from '@svpchain/trading-sdk';

const info = new Info({ baseUrl });
```

返回值中的 64 位整数使用 `bigint`，字节使用 `Uint8Array`。文中的“返回字段”列出业务常用字段；完整类型由 SDK 的 TypeScript 声明提供。

## 市场列表：meta / market

**用途**：查找可交易市场、读取市场状态和交易精度。

```text
info.meta(options?)
info.market(coin, options?)
```

`coin` 是市场完整 ticker，例如 `BTC-USD`。`meta()` 返回列表，`market()` 返回单个市场对象。

```ts
const meta = await info.meta();
const market = await info.market('BTC-USD');
console.log(market.id, market.ticker, market.status);
console.log(market.stepBaseQuantums, market.subticksPerTick);
console.log(meta.feeTiers, meta.funding);
```

| 返回 | 含义 |
| --- | --- |
| `meta.markets` | 市场列表，含状态、精度和 mark 等 |
| `meta.liquidityTiers` / `meta.feeTiers` | 公共流动性与费率档位 |
| `meta.funding` | 公共资金费配置 |
| `market.id` | 供盘口、行情等查询使用的市场 ID |

市场不存在时 `market()` 报错。市场已创建不表示已经启用；交易前需确认状态。费率档位也不是账户历史费用账单。

## 盘口：l2Snapshot

**用途**：查询聚合价格档位，展示订单簿或计算下单参考价。

```text
info.l2Snapshot(market, depth = 20, options?)
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `market` | `number` | 市场 ID，0 是有效值 |
| `depth` | `number` | 每侧档位数；SDK 默认 20，节点最多 1,000；显式 0 使用节点默认 50 |

```ts
import { marketUnits, subticksToPrice, quantumsToSize } from '@svpchain/trading-sdk';

const market = await info.market('BTC-USD');
const units = marketUnits(market);
const book = await info.l2Snapshot(market.id, 20);
const bids = book.bids.map(level => ({
  price: subticksToPrice(level.price, units),
  size: quantumsToSize(level.size, units),
}));
console.log(bids);
```

返回 `market`、`bids`、`asks`、`at`。每档为 `{ price: bigint, size: bigint }`；买盘价格从高到低，卖盘从低到高。价格和数量是链上整数单位，示例将它们转换为用户可读字符串。

这是某次 HTTP 查询的快照。空盘口是有效结果；持续展示可由应用按需轮询更新。

## 行情：ticker

**用途**：查询标记价格、买卖一、最近价格、成交统计及资金费指数。

```ts
const market = await info.market('BTC-USD');
const ticker = await info.ticker(market.id);
console.log(ticker.mark, ticker.bestBid, ticker.bestAsk, ticker.fundingIndex);
```

返回 `mark`、可选 `bestBid` / `bestAsk` / `lastPrice`、`volume24h`、`high24h` / `low24h`、`trades24h`、`openInterest`、`fundingIndex` 等。

某些价格字段可能不存在。最近成交与 24 小时统计受该节点实际运行和观察范围影响；字段存在不代表节点保存了完整 24 小时历史。fundingIndex 是市场资金费累计指数。价格单位转换见 [API](../API.md#显示工具与扩展查询)。

## 账户状态：userState / userStateById

**用途**：通过 owner 地址或数字 ID 查询账户资产、风险和持仓。

```text
info.userState(owner, options?)
info.userStateById(account, options?)
```

`owner` 为 20 字节 `Uint8Array` 或 `0x` 地址字符串；`account` 是非 vault 的账户数字 ID。

```ts
import { microUsdToUsd } from '@svpchain/trading-sdk';

const state = await info.userState(ownerAddress);
const account = Number(state.account);
console.log({
  account,
  collateral: microUsdToUsd(state.collateral),
  equity: microUsdToUsd(state.equity),
  marginHeadroom: microUsdToUsd(state.marginHeadroom),
  belowMaintenance: state.belowMaintenance,
});
```

| 返回字段 | 含义 |
| --- | --- |
| `account` / `owner` | 链上账户 ID / owner 地址 |
| `collateral` / `equity` | 保证金 / 账户权益，微 USD |
| `marginHeadroom` | 超出当前初始保证金需求的权益，微 USD |
| `belowMaintenance` | 是否低于维持保证金要求 |
| `positions` / `settings` | 持仓及市场设置 |
| `actionsUsed` / `lastNonce` / `openOrders` | 已用动作额度、最高已用 nonce、挂单数 |

账户不存在时按节点规则返回 RPC 错误。`marginHeadroom` 不是“可以无条件提现的余额”，也不能保证下一笔订单通过风控。

## 持仓：positions

**用途**：单独读取持仓，展示多空和逐仓信息。

```ts
const result = await info.positions(account);
for (const position of result.positions) {
  console.log(position.market, position.side, position.size, position.isolatedMargin);
}
```

返回 `positions` 和读取高度 `at`。持仓含市场、方向、带符号数量、成本、挂单敞口、资金费指数和逐仓保证金。数量使用市场基础币精度；成本和保证金字段使用各自声明的金额单位。

## 当前挂单：openOrders

**用途**：查询仍在订单簿上的委托，供展示、撤单和对账使用。

```text
info.openOrders(account, market?, options?)
```

```ts
const market = await info.market('BTC-USD');
const result = await info.openOrders(account, market.id);
for (const order of result.orders) {
  console.log(order.orderId, order.market, order.remaining, order.expiry);
}
```

返回 `orders`，每项包含 `orderId`、`market`、`side`、`price`、`remaining`、`expiry`、`position`。`remaining` 为剩余基础币数量的整数单位，`expiry` 为截止高度，0 表示不设置。

不传 market 表示所有市场，显式传 0 只查询市场 0。列表不包含已经完全成交或撤销的订单；“不在挂单里”不能单独证明已经成交，应结合 [成交及动作历史](HISTORY.md) 核实。

## 授权、nonce 和额度

| 方法 | 业务用途 | 返回字段 |
| --- | --- | --- |
| `agents(account)` | 确认当前 agent 授权 | `agents`，每项含 slot、key、seq、expiry |
| `nonce(account)` | 协调签名和恢复交易 | `lastNonce`、`window` |
| `userRateLimit(account)` | 查询累计动作额度 | `used`、`limit`、`remaining` |
| `chainInfo()` | 确认目标链和当前高度 | `chainId`、`genesisHash`、`executedHeight` 等 |

```ts
const agents = await info.agents(account);
const allowance = await info.userRateLimit(account);
console.log(agents.agents, allowance.remaining);
```

agent 到期时间按区块高度，expiry 为 0 表示无到期高度。累计动作额度由 owner 和 agent 共享，和 HTTP 请求速率或钱包 SVP 余额分别计算。

动作执行与交易哈希查询见 [结果处理](RESULTS.md)。历史与分页见 [历史数据](HISTORY.md)。
