# 交易结果与异常

交易接入需要分别确认节点接收、动作执行和订单成交。SDK 的返回值保留这三个阶段的边界，应用可据此更新界面、处理拒绝和恢复交易。

## 交易方法返回什么

`order()`、`cancel()`、`modifyOrder()` 等方法统一返回 `OrderResponse`。单笔也使用 `statuses` 数组，便于与批量复用处理逻辑。

| 返回字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | `bigint` | 本次提交批次 ID |
| `statuses` | `OrderStatus[]` | 按输入顺序返回的逐项结果 |
| `submit` | `SubmitResult` | 节点接收结果 |
| `successful()` | 方法，返回 boolean | 仅当全部项已执行且执行成功时为 true |

每个 `OrderStatus` 包含：

| 字段 | 含义 |
| --- | --- |
| `prepared.account` / `prepared.nonce` | 原动作的对账键 |
| `prepared.transactionHash` | 原交易哈希 |
| `submitStatus` | 节点接收或明确拒绝状态 |
| `outcome` | 动作执行情况 |
| `error` | 存在时提供接收或执行失败原因 |

以下例子把返回值映射为便于应用保存的摘要，`bigint` 转成字符串后可以 JSON 序列化：

```ts
const response = await exchange.order({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
});
const summary = response.statuses.map(item => ({
  account: item.prepared.account,
  nonce: item.prepared.nonce.toString(),
  transactionHash: item.prepared.transactionHash,
  submitStatus: item.submitStatus,
  execution: item.outcome.kind,
  ok: item.outcome.kind === 'executed' ? item.outcome.ok : null,
  error: item.error ?? null,
}));
console.log(summary);
```

摘要中的 `ok: true` 只表示动作成功，不表示订单已成交。

## 节点接收状态

| `submitStatus` | 含义 | 业务处理 |
| --- | --- | --- |
| `accepted` | 节点接收此项 | 继续确认执行结果 |
| `malformed` | 节点明确拒绝，数据不符合要求 | 检查参数和版本 |
| `bad_signature` | 节点明确拒绝签名或授权校验 | 刷新账户、agent 和 nonce 状态 |
| `unavailable` | 节点明确未接收此项 | 检查服务状态并根据业务决定下一步 |

批量可能混合接收与拒绝。`submit.ok` 只表示各项都被接收；最终执行仍需逐项判断。

## 动作执行状态

| `outcome.kind` | 其他字段 | 含义 |
| --- | --- | --- |
| `executed` | `ok: true`、height、可选 orderId、fills | 动作执行成功 |
| `executed` | `ok: false`、reject | 动作执行被拒 |
| `pending` | — | 本次没有得到最终执行详情 |
| `nonce_used` | — | nonce 已使用，但没有可用执行详情 |
| `not_submitted` | — | 节点明确未接收此项 |

`fills` 是该动作直接产生的成交条目数，不是逐笔成交明细，也不能单独确定全部委托数量已成交。完整成交用 `userFills()`，剩余挂单用 `openOrders()`。

常见情况：限价动作成功但仍在挂单；IOC 动作成功但未成交或部分成交；TWAP 动作成功但计划仍在后续执行。应用应根据实际成交和持仓更新业务状态。

## 查询原动作：actionStatus

**用途**：下单后继续等待确认，或提交结果不确定时对账。

```ts
const item = response.statuses[0];
const status = await info.actionStatus([
  { account: item.prepared.account, nonce: item.prepared.nonce },
]);
console.log(status.statuses);
```

每次接收 1–10,000 个 `{ account: number, nonce: bigint }`，返回按键对应的原始执行状态。枚举类型为 `@svpchain/trading-sdk/protocol` 的 `tx.ActionState`。

`NOT_FOUND` 表示当前查询没有执行详情，不能证明交易从未接收。`NONCE_USED` 也不是执行成功的同义词。结合 [历史索引范围](HISTORY.md#索引状态indexstatus) 和原交易继续核查。

## 查询交易：transaction

**用途**：按交易哈希核查节点记录。

```ts
const transaction = await info.transaction(response.statuses[0].prepared.transactionHash);
console.log(transaction);
```

参数为 32 字节 `Uint8Array` 或 `0x` 字符串。SDK 核对返回哈希；目标节点能否找到记录取决于保存范围、执行及索引进度。交易未找到时，保留原 account / nonce 继续核查，不要自动生成另一笔订单。

## 等待与超时

默认等待执行最多 15 秒、每 250 毫秒查询一次。可以传 `{ waitForExecution: false }` 只等提交响应；此时 accepted 项仍为 pending。

```ts
const response = await exchange.order(
  { coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001' },
  { waitForExecution: false },
);
console.log(response.statuses);
```

执行等待正常到期会返回仍为 pending 的项，已经确认的项会保留。取消本地等待不会撤回已经接收的交易。超时选项和取消方式见 [接入指南](../USAGE.md#5-超时与取消)。

## 异常与恢复

| 异常 | SDK 保留的内容 | 下一步 |
| --- | --- | --- |
| `ExchangeSubmissionUnknownError` | 原始 `prepared[]` | 提交响应丢失或无法信任，查原 account / nonce 和交易哈希 |
| `ExchangeTrackingError` | `response`，含接收证据和部分结果 | 保留已确认结果，继续查询未确认项 |
| `ActionAllowanceError` | used、limit、required | 额度不足，停止重复提交 |
| `ChainIdentityError` | 错误原因 | 核对网络和目标创世哈希 |
| `ConnectError` | RPC code 和消息 | 结合发生阶段处理；提交阶段的不确定结果会被专门异常封装 |
| `TypeError` / `RangeError` | 校验原因 | 检查精度、参数、签名或数据一致性 |

```ts
import { ExchangeSubmissionUnknownError, ExchangeTrackingError } from '@svpchain/trading-sdk';

try {
  const response = await exchange.order({
    coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  });
  console.log(response.statuses);
} catch (error) {
  if (error instanceof ExchangeSubmissionUnknownError) {
    // 大批次分组，每次 actionStatus 最多 10,000 项。
    for (let i = 0; i < error.prepared.length; i += 10000) {
      const keys = error.prepared.slice(i, i + 10000)
        .map(p => ({ account: p.account, nonce: p.nonce }));
      console.log(await exchange.info.actionStatus(keys));
    }
  } else if (error instanceof ExchangeTrackingError) {
    console.log(error.response.statuses);
  } else {
    throw error;
  }
}
```

SDK 不自动重发 Submit，也不会自动换 nonce 再下单。恢复流程先核实原请求；批量部分成功时仅对明确需要后续操作的项处理，避免重复交易。
