# 交易接口

[English](../../reference/EXCHANGE.md) | 简体中文

`Exchange` 绑定一个 Apollo 账户和一个 signer，负责准备、签名、提交及查询动作执行结果。下面示例使用已授权 agent 的 `exchange`；owner 授权操作使用 `owner`。

```ts
import { Exchange } from '@svpchain/trading-sdk';

const exchange = new Exchange({
  baseUrl, account, expectedGenesisHash,
  signer: { type: 'agent', seed, slot: 1 },
});
```

所有交易方法返回 `OrderResponse`。每一项必须区分节点接收、动作执行和订单成交，详见 [结果处理](RESULTS.md)。第二个参数一般可传 `{ waitForExecution, timeoutMs, intervalMs, signal }`，具体位置见 [API](../API.md)。

## 限价下单：order

**用途**：按指定价格和数量下单，选择长期挂单、立即成交剩余撤销或只挂单。

```text
exchange.order(request, options?)
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `coin` | `string` | 完整市场 ticker |
| `isBuy` | `boolean` | 买入为 true，卖出为 false |
| `price` | `string` | 限价，符合 tick |
| `size` | `string` | 基础币数量，符合 step |
| `orderType.limit.tif` | `Gtc` / `Ioc` / `PostOnly` | 默认 Gtc |
| `position` | `Long` / `Short` | 多空槽位，买入默认 Long、卖出默认 Short |
| `reduceOnly` | `boolean` | 是否只减仓，默认 false |
| `isolated` | `boolean` | 是否逐仓，默认 false |

```ts
const response = await exchange.order({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  orderType: { limit: { tif: 'Gtc' } },
});
const status = response.statuses[0];
console.log(status.submitStatus, status.outcome);
```

**返回**：一项结果，包含原交易标识、接收状态和执行状态。执行成功时订单可能仍挂在盘口中，后续使用 `openOrders()` 和 `userFills()` 查询。

**限制**：市场必须启用；价格和数量传十进制字符串，偏离 tick / step 会在广播前报错。可选 builder、截止高度等完整参数见 [API](../API.md#下单order--bulkorders)。

## 批量下单：bulkOrders

**用途**：一次提交多笔独立委托。

```ts
const response = await exchange.bulkOrders([
  { coin: 'BTC-USD', isBuy: true, price: '64000', size: '0.001' },
  { coin: 'BTC-USD', isBuy: false, price: '66000', size: '0.001', position: 'Short' },
]);
for (const status of response.statuses) console.log(status.submitStatus, status.outcome);
```

参数为 `CreateOrderRequest[]`，返回 `statuses` 与输入顺序对应。1–20,000 项还需满足请求字节上限；不会自动拆分成多次提交。

准备阶段检查整批订单字段，再签名和提交。链上结果仍可能部分成功、部分失败，批量不保证原子执行。不要在部分失败后重下整批订单。

## 市价开仓和平仓：marketOpen / marketClose

**用途**：按当前市场价格立即尝试成交，同时限制可接受滑点。

```ts
const opened = await exchange.marketOpen({
  coin: 'BTC-USD', isBuy: true, size: '0.001', slippage: '0.01',
});
const closed = await exchange.marketClose({
  coin: 'BTC-USD', position: 'Long', size: '0.001', slippage: '0.01',
});
console.log(opened.statuses, closed.statuses);
```

| 参数 | 说明 |
| --- | --- |
| `coin`、`size` | 市场和基础币数量，必填 |
| `isBuy` | 开仓方法必填；平仓方法自动确定方向 |
| `position` | 平仓必填 Long / Short；开仓可选 |
| `slippage` | 比例字符串，默认 `'0.01'`，允许 0，必须小于 1 |
| `referencePrice` | 可选参考价字符串；不传则读对手盘最佳价，空盘口回退 mark |
| `isolated` | 可选逐仓标记 |

**返回**：动作执行结果。执行成功不能保证全部数量成交，应查询实际成交量和剩余仓位。

**限制**：市价意图通过 IOC 保护限价实现。平仓强制只减仓，并需要调用方提供数量；不会自动猜测多空仓位或读取全仓数量。参考价不足或风控不满足时仍可能被拒。

## 止盈止损：orderType.trigger

**用途**：价格达到触发条件后提交限价或市价意图。

```ts
const stop = await exchange.order({
  coin: 'BTC-USD', isBuy: false, size: '0.001',
  position: 'Long', reduceOnly: true,
  orderType: {
    trigger: { triggerPrice: '60000', isMarket: true, tpsl: 'sl' },
  },
  slippage: '0.01',
});
console.log(stop.statuses);
```

| 参数 | 说明 |
| --- | --- |
| `triggerPrice` | 触发价字符串，必须符合 tick |
| `tpsl` | `tp` 止盈，`sl` 止损 |
| `isMarket` | true 为触发市价意图，false 为触发限价 |
| `price` | 触发限价时必填，表示触发后的委托价格 |
| `position`、`reduceOnly` | 用于平仓止盈止损时应显式指定 |

**返回**：触发订单动作的结果。创建成功不表示已经触发或成交，也不保证止盈止损在市场剧烈变化时全部成交。每个触发订单分别返回自己的交易标识和执行结果。

## 撤单：cancel / bulkCancel / cancelAll

**用途**：撤销一个、多个、某市场全部或账户全部挂单。

```ts
const one = await exchange.cancel({ coin: 'BTC-USD', orderId });
const multiple = await exchange.bulkCancel([
  { coin: 'BTC-USD', orderId: firstOrderId },
  { coin: 'BTC-USD', orderId: secondOrderId },
]);
const marketOrders = await exchange.cancelAll('BTC-USD');
// 所有市场：await exchange.cancelAll('');
console.log(one.statuses, multiple.statuses, marketOrders.statuses);
```

`orderId` 是 `bigint`。`bulkCancel()` 接收 1–20,000 个 `{ coin, orderId }`，并受请求大小限制。`cancelAll()` 默认空字符串，代表所有市场。

**返回**：每个撤单动作的执行结果。撤单与成交可能竞争；撤单后仍应核对成交及挂单。Cancel / CancelAll 免累计动作额度，但参数、授权和 nonce 仍需有效。

## 改单：modifyOrder

**用途**：替换已有订单的价格和数量。

```ts
const response = await exchange.modifyOrder({
  coin: 'BTC-USD', orderId, price: '65100', size: '0.002',
});
console.log(response.statuses);
```

请求必填 `coin`、`orderId: bigint`、`price: string`、`size: string`。price / size 仍需符合市场精度。

**返回**：改单动作执行结果。新订单使用新标识，应按结果及挂单查询确认，不应一直沿用旧 ID。

**限制**：先撤旧单再建新单，新单创建失败时旧单可能已撤销。

批量修改使用 `bulkModify(requests, options?)`，参数为上述请求数组，最多 20,000 项并受请求字节上限限制：

```ts
const response = await exchange.bulkModify([
  { coin: 'BTC-USD', orderId: firstOrderId, price: '65100', size: '0.001' },
  { coin: 'BTC-USD', orderId: secondOrderId, price: '65200', size: '0.002' },
]);
for (const status of response.statuses) console.log(status.outcome);
```

SDK 在签名前验证整批字段并检查总动作额度，再一次提交。结果按请求顺序逐项返回，可能部分成功；不能在失败后直接重发整批。

## 杠杆与逐仓保证金

**用途**：设置市场杠杆，或增减某方向的逐仓保证金。

```ts
const leverage = await exchange.updateLeverage('BTC-USD', '5');
const margin = await exchange.updateIsolatedMargin('BTC-USD', 'Long', '10.50');
console.log(leverage.statuses, margin.statuses);
```

| 方法 | 参数 |
| --- | --- |
| `updateLeverage(coin, leverage, options?)` | 完整 ticker、杠杆十进制字符串 |
| `updateIsolatedMargin(coin, position, amount, options?)` | ticker、Long / Short、USD 金额字符串 |

保证金正数增加、负数减少，最多 6 位小数。杠杆输入范围为 1–1,000,000，实际可用值由市场和账户风控决定。

**返回**：设置动作的执行结果；成功后通过账户状态重新读取设置和保证金。减少保证金或提高杠杆可能被风控拒绝。

## TWAP 与分批订单

**用途**：创建按时间执行的交易计划，或按价格区间分配数量。

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
console.log(twap.statuses, scaled.statuses);
```

TWAP 的 `durationS` / `intervalS` 以秒计，`tolerancePpm` 默认 10,000，表示 1%。分批订单的 `size` 是总数量，`numOrders` 是子单数量；其余分配选项见 [API](../API.md#twap-与分批订单)。

**返回**：创建动作的结果。TWAP 计划建立与全部子单成交是不同阶段；分批动作成功也不能据此认为所有子单成交。

取消 TWAP 使用父订单 ID：

```ts
const response = await exchange.cancelTwap({ coin: 'BTC-USD', orderId: twapParentId });
console.log(response.statuses);
```

父订单 ID 为创建 TWAP 时的 nonce，可从创建结果的 `prepared.nonce` 保存。取消沿用现有撤单动作，会取消父计划及其当前子单，免累计动作额度。已经成交的子单不会被撤回。

## Owner 授权和撤销 agent

**用途**：由 owner 允许专门的交易 key 操作账户，并在需要时撤销。

```ts
const approval = await owner.approveAgent(1, publicKey, 0n);
if (!approval.successful()) throw new Error('Approval not confirmed');
const agents = await owner.info.agents(account);
console.log(agents.agents);
// 撤销：await owner.revokeAgent(1);
```

`approveAgent(slot, publicKey, expiry = 0n, options?)` 的 slot 为 1–4，publicKey 为 32 字节，expiry 是到期高度，0 表示无到期高度。`revokeAgent(slot, options?)` 撤销指定槽位。

**返回**：授权动作执行结果。需要确认执行成功后才能使用新 agent。agent 无权管理授权；换 key 或撤销可能使之前准备的签名失效。owner 的钱包和本地 key 接入见 [README](../../../README.zh-CN.md#owner-钱包与-agent-授权)。

## 先准备，再提交

**用途**：先检查并签名，待业务流程决定提交时再广播。

```ts
const prepared = await exchange.prepareOrder({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
});
console.log(prepared.transactionHash, prepared.nonce);
const response = await exchange.submitPrepared([prepared]);
console.log(response.statuses);
```

准备不会广播；提交会重新核对目标链、账户和当前授权。签名数据应按可提交交易保管。提交超时或响应丢失时，先查询原 account / nonce，见 [结果处理](RESULTS.md)。
