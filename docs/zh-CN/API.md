# API

[English](../API.md) | 简体中文

入口分为 `Info`（只读查询）和 `Exchange`（签名交易），通过 Apollo HTTP JSON-RPC 提供交易接入。

本页为选项与类型总览。按业务查阅：

| 页面 | 内容 |
| --- | --- |
| [功能总览](FEATURES.md) | 交易、查询、授权及结果处理接口 |
| [市场和账户查询](reference/INFO.md) | 市场、盘口、行情、资产、仓位及挂单 |
| [交易接口](reference/EXCHANGE.md) | 下单、撤单、改单、风险设置及授权 |
| [历史数据](reference/HISTORY.md) | 成交、订单动作、K 线、资金费指数及分页 |
| [结果与异常](reference/RESULTS.md) | 接收、执行、成交及恢复处理 |

## 初始化

```ts
import { Info, Exchange } from '@svpchain/trading-sdk';

const info = new Info({ baseUrl });
const exchange = new Exchange({
  baseUrl, account, expectedGenesisHash,
  signer: { type: 'agent', seed, slot: 1 },
});
```

| 公共选项 | 类型 | 说明 |
| --- | --- | --- |
| `baseUrl` | `string` | 节点 HTTP(S) JSON-RPC 地址，必填 |
| `expectedGenesisHash` | `0x` 字符串或 `Uint8Array` | 可选的目标链创世哈希，32 字节；交易接入建议显式设置 |
| `defaultTimeoutMs` | `number` | 单次请求超时，默认 10,000 毫秒 |
| `maxRequestBytes` | `number` | 单次请求字节上限，默认 8 MiB；还需遵守服务端限制 |
| `maxResponseBytes` | `number` | 单次响应字节上限，默认 16 MiB |
| `fetch` | `typeof fetch` | 自定义请求函数 |
| `nonceManager` | `NonceManager` | 同一账户在多个交易实例间共享 nonce 时传入 |

`Exchange` 另需 `account: number` 和 `signer: ExchangeSigner`。`account` 是已存在的非 vault 账户 ID，范围为 1–4,294,967,295。

每个查询方法的最后一个参数均可传 `{ signal?: AbortSignal }`。交易方法还可传 `SubmitOptions`：

| 交易选项 | 默认值 | 说明 |
| --- | --- | --- |
| `waitForExecution` | `true` | 是否在节点接收后继续查询执行结果 |
| `timeoutMs` | `15000` | 执行轮询总等待时间，毫秒；显式设置时也用于提交请求 |
| `intervalMs` | `250` | 执行轮询间隔，毫秒 |
| `signal` | 无 | 取消本次请求和等待；已接收交易仍可能执行 |

`exchange.connect()` 可提前验证链身份，返回链信息。Exchange 首次连接后会固定该链的创世哈希，后续签名或提交会重新核对。

## Info

返回值保留 RPC 的带类型响应结构，64 位整数为 `bigint`，字节为 `Uint8Array`，枚举为对应数值。历史请求的 `account` 是 `bigint`；便捷账户方法使用 `number`。

| 方法 | 参数 | 返回内容 |
| --- | --- | --- |
| `chainInfo()` | — | chainId、genesisHash、executedHeight 等 |
| `meta()` | — | `markets` 市场列表及状态、精度、mark 等 |
| `market(coin)` | 完整 ticker | 单个市场对象，找不到会报错 |
| `l2Snapshot(market, depth = 20)` | 市场 ID、深度 | `bids` / `asks` 盘口 |
| `ticker(market)` | 市场 ID | 最新行情 |
| `userState(owner)` | 20 字节 owner 地址或 `0x` 字符串 | 账户信息；不存在时按 RPC 规则报错 |
| `userStateById(account)` | 账户 ID | 账户信息 |
| `positions(account)` | 账户 ID | 多空仓位 |
| `openOrders(account, market?)` | 可选市场 ID | 挂单；不传市场表示全部，`0` 是有效市场 ID |
| `agents(account)` | 账户 ID | 已授权 agent、槽位、序号、到期高度 |
| `nonce(account)` | 账户 ID | 已使用的 nonce 状态 |
| `userRateLimit(account)` | 账户 ID | 累计动作额度 `used` / `limit` / `remaining` |
| `actionStatus(keys)` | `[{ account, nonce }]`，1–10,000 项 | 每项执行状态，核对返回键、数量与状态 |
| `transaction(hash)` | 32 字节哈希或 `0x` 字符串 | 交易查询结果，核对返回哈希 |
| `indexStatus()` | — | 历史索引状态 |
| `userFills(params)` | `UserFillsParams` | 成交列表与 `next` 游标 |
| `userFees(params)` | `UserFeesParams` | 当前页成交的手续费汇总、`index` 和 `next` |
| `historicalOrders(params)` | `HistoryParams` | 历史订单与游标 |
| `actionHistory(params)` | `HistoryParams` | 账户动作历史与游标 |
| `candlesSnapshot(params)` | `CandlesParams` | K 线 |
| `fundingHistory(params)` | `FundingHistoryParams` | 资金费指数历史 |

历史查询依赖 archive 节点及其索引状态。`next` 存在时，将它作为下次请求的 `after`，并保留其他过滤条件。

```ts
const first = await info.userFills({ account: BigInt(account), limit: 100 });
if (first.next) {
  const second = await info.userFills({
    account: BigInt(account), limit: 100, after: first.next,
  });
  console.log(second.fills);
}
```

| 历史参数 | 字段 |
| --- | --- |
| `UserFillsParams` | `account?: bigint`、`market?: number`、`fromHeight?: bigint`、`after?: { height?: bigint; index?: number }`、`limit?: number` |
| `UserFeesParams` | `account: number` 必填，其余市场、高度、游标和 limit 与 `UserFillsParams` 一致 |
| `HistoryParams` | `account?: bigint`、`fromHeight?: bigint`、`after?`、`limit?: number`；业务上须传 account |
| `CandlesParams` | `market?: number`、`interval?: CandleInterval`、`fromUnixS?: bigint`、`toUnixS?: bigint`、`limit?: number` |
| `FundingHistoryParams` | `market?: number`、`fromHeight?: bigint`、`limit?: number` |

这些参数从 RPC 的类型生成，使用 TypeScript 自动补全即可；K 线枚举为 `@svpchain/trading-sdk/protocol` 中的 `history.CandleInterval`。历史 limit 服务端最多 1,000，0 表示默认 100。

## 下单：order / bulkOrders

```ts
const request = {
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  orderType: { limit: { tif: 'Gtc' as const } },
};
const response = await exchange.order(request);
const batch = await exchange.bulkOrders([request, request]);
```

`CreateOrderRequest`：

| 字段 | 类型 / 默认值 | 说明 |
| --- | --- | --- |
| `coin` | `string`，必填 | 市场完整 ticker |
| `isBuy` | `boolean`，必填 | true 买入，false 卖出 |
| `size` | 十进制 `string`，必填 | 基础币数量，必须符合市场 step |
| `price` | 十进制 `string` | 限价单及触发限价单必填，必须符合 tick |
| `orderType` | 默认普通限价 | `limit` 与 `trigger` 二选一 |
| `orderType.limit.tif` | `Gtc` / `Ioc` / `PostOnly`，默认 `Gtc` | 委托有效方式 |
| `orderType.trigger.triggerPrice` | 十进制 `string` | 触发价，须符合 tick |
| `orderType.trigger.isMarket` | `boolean` | 触发后是否按市价意图执行 |
| `orderType.trigger.tpsl` | `tp` / `sl` | 止盈 / 止损 |
| `reduceOnly` | `false` | 只减仓 |
| `position` | `Long` / `Short` | 默认买入对应 Long、卖出对应 Short；减仓应明确指定 |
| `isolated` | `false` | true 逐仓，false 全仓 |
| `goodTilBlock` | `bigint` | 有效截止区块高度，0 表示不设置 |
| `builder` | `{ account: number; feePpm: number }` | 可选 builder 信息 |
| `referencePrice` | 十进制 `string` | 触发市价单保护价格的参考价；不传则查询盘口，再回退 mark |
| `slippage` | 十进制 `string`，默认 `'0.01'` | 市价保护比例，范围 0–1，不含 1 |

价格、数量均为正数十进制字符串，不能传 JS number 或科学计数法。超出市场可表示精度、偏离 tick / step、市场未启用等情况会在广播前报错。

止损市价示例：

```ts
const stopped = await exchange.order({
  coin: 'BTC-USD', isBuy: false, size: '0.001',
  position: 'Long', reduceOnly: true,
  orderType: { trigger: { triggerPrice: '60000', isMarket: true, tpsl: 'sl' } },
  slippage: '0.01',
});
```

## 撤单与改单

| 方法 | 请求 |
| --- | --- |
| `cancel(request)` | `{ coin: string; orderId: bigint }` |
| `bulkCancel(requests)` | 上述请求数组 |
| `cancelAll(coin = '')` | 完整 ticker；空字符串表示所有市场 |
| `modifyOrder(request)` | `{ coin; orderId; price: string; size: string }` |
| `bulkModify(requests)` | 上述改单请求数组，1–20,000 项，单次提交并逐项返回 |
| `cancelTwap(request)` | `{ coin: string; orderId: bigint }`，orderId 是 TWAP 父订单 ID |

`orderId` 必须使用 `bigint`，避免超出 JS 安全整数范围。改单属于撤旧单后重新挂单，新单被拒不代表旧单仍存在。

`cancelTwap()` 复用现有撤单动作，取消父计划和当前子单。批量改单先验证整批字段后签名，链上各项独立执行。

## 市价开仓与平仓

```ts
await exchange.marketOpen({
  coin: 'BTC-USD', isBuy: true, size: '0.001', slippage: '0.01',
});
await exchange.marketClose({
  coin: 'BTC-USD', position: 'Long', size: '0.001', slippage: '0.01',
});
```

`MarketOrderRequest` 接收 `coin`、`isBuy`、`size`、`position?`、`reduceOnly?`、`isolated?`、`referencePrice?`、`slippage?`。没有裸市价单：买入参考卖一，卖出参考买一，盘口为空时回退 mark，再生成 IOC 保护限价。

`ClosePositionRequest` 必填 `position` 和 `size`，SDK 决定买卖方向并强制只减仓。不会自动读取持仓、决定数量或修改杠杆。

## 杠杆与保证金

```ts
const leverage = await exchange.updateLeverage('BTC-USD', '5');
const margin = await exchange.updateIsolatedMargin('BTC-USD', 'Long', '10.50');
```

`updateLeverage(coin, leverage)` 使用十进制杠杆字符串，范围为 1–1,000,000，实际可用上限仍受市场风控约束。

`updateIsolatedMargin(coin, position, amount)` 的金额单位为 USD，正数增加、负数减少，精确到 6 位小数；更高精度会拒绝。

## TWAP 与分批订单

```ts
const twap = await exchange.twapOrder({
  coin: 'BTC-USD', isBuy: true, size: '0.01', price: '65000',
  durationS: 600, intervalS: 30, tolerancePpm: 10000,
});
const scaled = await exchange.scaledOrder({
  coin: 'BTC-USD', isBuy: true, size: '0.01',
  lowestPrice: '62000', highestPrice: '64000', numOrders: 5,
  profile: 'Equal', spacing: 'Linear',
});
```

`CreateTwapOrderRequest` 必填 `coin`、`isBuy`、`size`、`durationS`、`intervalS`，可选 `price`、`tolerancePpm`、`position`、`reduceOnly`、`isolated`。`tolerancePpm` 默认 10,000（1%），范围 0–999,999。TWAP 执行成功表示计划被建立，不代表计划所有子单已经成交。

`CreateScaledOrderRequest` 必填 `coin`、`isBuy`、`size`、`lowestPrice`、`highestPrice`、`numOrders`。可选：

- `profile`：`Equal`（默认）、`IncRatio`、`IncDiff`、`DecRatio`、`DecDiff`。
- `spacing`：`Linear`（默认）或 `Geometric`。
- `magnitudePpm`：默认 0，Equal 必须为 0；其他策略需满足相应数量分配约束。
- `tif`：`Gtc`（默认）或 `Ioc`。
- `position`、`reduceOnly`、`isolated`、`goodTilBlock`：含义与普通下单相同。

`size` 是总数量，子单数量和价格还需满足市场精度及链上校验。

## Signer 与 agent 管理

| Signer | 创建方式 |
| --- | --- |
| agent | `{ type: 'agent', seed: Uint8Array, slot?: number }`，32 字节 seed，slot 默认 1 |
| 钱包 owner | `createWalletSigner(signTypedDataCallback)` |
| 本地 owner | `createOwnerKeySigner(privateKey)`，32 字节或 `0x` 字符串 |

钱包回调收到完整 typed data，异步返回 `0x` 签名字符串。owner 交易先验证签名地址与链上账户一致；agent 交易使用链上的当前授权序号。

```ts
const approved = await owner.approveAgent(1, publicKey, 0n);
// 先检查 approved.successful()。撤销时：
const revoked = await owner.revokeAgent(1);
```

`approveAgent(slot, publicKey, expiry = 0n)` / `revokeAgent(slot)` 仅限 owner。slot 为 1–4，publicKey 为 32 字节，expiry 为到期区块高度，0 表示无到期高度。换 key / 撤销后，旧签名可能失效。

## 准备、执行与扩展交易

| 方法 | 作用 |
| --- | --- |
| `prepareOrder(request)` | 按用户字段准备单笔订单，返回 `PreparedAction`，不广播 |
| `prepare(action)` / `prepareActions(actions)` | 准备已构造的 `TradingAction`，不广播 |
| `execute(action)` / `executeActions(actions)` | 准备并提交已构造的 `TradingAction` |
| `submitPrepared(prepared[])` | 核对已签名数据并批量提交，返回 `OrderResponse` |

`TradingAction` 使用链上单位；普通接入优先使用 `order()` 等字段接口。`PreparedAction` 提供对账所需的 `account`、`nonce`、`genesisHash`、`transactionHash`，并保留签名交易供后续提交，不包含私钥。

新 Exchange 在准备阶段检查累计动作额度；Cancel / CancelAll 免额度。批量最多 20,000 项，提交还受到请求字节上限约束；不会自动拆分成多次提交。执行查询会按每次最多 10,000 项分组。

## 返回值与错误

交易方法统一返回 `OrderResponse`：

- `id: bigint`：提交批次 ID。
- `statuses: OrderStatus[]`：与请求一一对应的逐项结果。
- `submit: SubmitResult`：节点接收结果。
- `successful(): boolean`：全部项 `outcome.kind === 'executed' && outcome.ok` 才为 true。

每个 `OrderStatus` 含 `prepared`、`submitStatus`、`outcome`，失败时可能带 `error`。`submitStatus` 为 `accepted`、`malformed`、`bad_signature` 或 `unavailable`。

| `outcome.kind` | 含义 |
| --- | --- |
| `executed` | 已执行；继续检查 `ok` / `reject`，不能据此认定成交 |
| `pending` | 未等待或等待期限内仍未确认 |
| `not_submitted` | 节点明确未接收此项 |
| `nonce_used` | nonce 已使用，但没有可用执行详情 |

| 错误类 | 证据与处理 |
| --- | --- |
| `ActionAllowanceError` | 含 `used`、`limit`、`required`，签名前停止 |
| `ChainIdentityError` | 目标链或已准备交易的创世哈希不一致 |
| `ExchangeSubmissionUnknownError` | 含原始 `prepared[]`，提交响应丢失或无法信任，先对账 |
| `ExchangeTrackingError` | 含已接收证据 `response`，后续查询失败或取消，继续查原交易 |
| `ConnectError` | 请求或 RPC 层错误，可检查 `code` |
| `TypeError` / `RangeError` | 参数、精度、签名或一致性校验失败 |

业务执行拒绝保留在逐项结果中，不会一律抛异常。恢复示例见 [USAGE](USAGE.md)。

## 显示工具与扩展查询

```ts
import { marketUnits, subticksToPrice, priceUnitsToPrice, quantumsToSize } from '@svpchain/trading-sdk';

const market = await info.market('BTC-USD');
const units = marketUnits(market);
const book = await info.l2Snapshot(market.id, 1);
if (book.bids[0]) {
  console.log(subticksToPrice(book.bids[0].price, units));
  console.log(quantumsToSize(book.bids[0].size, units));
}
console.log(priceUnitsToPrice(market.mark, units));
```

盘口和挂单价格使用 `subticksToPrice`；成交、mark / oracle 和 K 线价格使用 `priceUnitsToPrice`；数量使用 `quantumsToSize`；USD 微单位使用 `microUsdToUsd`。不要对所有价格套同一个转换。

`info.rpc` 暴露生成的一元查询服务，`info.client` 保留旧 `ApolloClient` 访问入口；例如 `info.rpc.market.getOrderBook(...)`。

## 成交手续费汇总

`info.userFees({ account, market?, fromHeight?, after?, limit? }, options?)` 查询一页成交，并返回 `{ summary, index, next }`。`account` 为数字 ID，其他参数沿用成交查询。

`summarizeFees(account, fills)` 是不发请求的纯函数，适合对已经取得的成交记录汇总；传入的记录应去除重复页。

| `summary` 字段 | 类型 | 说明 |
| --- | --- | --- |
| `account` | `number` | 目标账户 |
| `makerFees` / `takerFees` | `bigint` | 对应角色的有符号费用，负数为返佣 |
| `feesPaid` | `bigint` | 正向支付费用之和 |
| `rebates` | `bigint` | 负向费用的绝对值之和 |
| `netFees` | `bigint` | 支付减返佣，可为负 |
| `fillCount` | `number` | 涉及本账户的成交记录数，同条记录两侧都是本账户时计一次 |
| `makerFillCount` / `takerFillCount` | `number` | 对应角色的记录数，自成交会同时计入两侧 |
| `byMarket` | `MarketFeeSummary[]` | 按市场 ID 排序，每项含 market 及上述费用和计数字段 |

统计口径为成交记录中的 makerFee / takerFee，所有金额均为微 USD。`userFees()` 返回本页汇总；存在 next 时继续分页，累加各页得到所查询历史的总额。使用 index.firstHeight / indexedHeight 确认查询覆盖的高度范围。完整分页示例见 [历史与费用](reference/HISTORY.md#账户手续费与成交返佣userfees)。
