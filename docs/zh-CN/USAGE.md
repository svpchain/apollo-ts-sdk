# 接入指南

[English](../USAGE.md) | 简体中文

## 1. 选择查询与交易客户端

`Info` 不需要私钥，可直接查询；`Exchange` 绑定一个账户和一个签名者，负责该账户的交易。

```ts
import { Info, Exchange } from '@svpchain/trading-sdk';

const info = new Info({ baseUrl });
const chain = await info.chainInfo();
const state = await info.userState(ownerAddress);
const account = Number(state.account);
const markets = await info.meta();
console.log(chain.chainId, chain.genesisHash, markets.markets);

const exchange = new Exchange({
  baseUrl, account, expectedGenesisHash,
  signer: { type: 'agent', seed: agentSeed, slot: 1 },
});
```

交易前确认账户存在、保证金足够、市场处于 ACTIVE 状态、agent 已获得授权。`expectedGenesisHash` 从独立可信的环境配置提供，避免连到其他链或重部署前的环境。

## 2. 使用字符串传价格和数量

```ts
const prepared = await exchange.prepareOrder({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  orderType: { limit: { tif: 'Gtc' } },
});
```

高层 API 不接收 JS number，也不接收科学计数法。查询市场精度后，确保价格符合 tick，数量符合 step；不符合会在广播前报错，不会静默补成最小数量。用户输入经你自己的规则取整后，需要再次让用户或策略确认最终价格和数量。

`prepareOrder()` 只查询和签名，不广播。准备好的数据不含私钥，但包含可提交的签名交易，应按业务需要保管。

## 3. 检查每一项交易结果

```ts
const response = await exchange.submitPrepared([prepared]);
for (const item of response.statuses) {
  switch (item.outcome.kind) {
    case 'executed':
      if (item.outcome.ok) {
        console.log('动作执行成功；接下来查询挂单与成交');
      } else {
        console.log('执行被拒:', item.outcome.reject);
      }
      break;
    case 'pending':
      console.log('继续查询原 nonce:', item.prepared.nonce);
      break;
    case 'nonce_used':
      console.log('查询 archive 交易及动作历史，核实最终结果');
      break;
    case 'not_submitted':
      console.log('未被接收:', item.submitStatus, item.error);
      break;
  }
}
```

需要区分三件事：节点接收、动作执行、订单成交。限价下单执行成功可能只是挂入订单簿；IOC 可能没有成交，TWAP 可能只是计划建立。`response.successful()` 只检查动作是否全部执行成功。

批量结果按输入顺序返回，部分被拒时其他项可能仍然执行。先逐项对账，再决定是否对明确失败的项采取下一步操作。

## 4. 提交不确定与查询失败

```ts
import {
  ExchangeSubmissionUnknownError, ExchangeTrackingError,
  ActionAllowanceError,
} from '@svpchain/trading-sdk';

try {
  const response = await exchange.order({
    coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  });
  console.log(response.statuses);
} catch (error) {
  if (error instanceof ExchangeSubmissionUnknownError) {
    // 请求可能已经到达节点。使用原交易查询，不能直接换 nonce 重下。
    const statuses = await exchange.info.actionStatus(
      error.prepared.map(p => ({ account: p.account, nonce: p.nonce })),
    );
    console.log(statuses);
  } else if (error instanceof ExchangeTrackingError) {
    // error.response 保留已接收证据及部分已确认结果。
    console.log(error.response.statuses);
  } else if (error instanceof ActionAllowanceError) {
    console.log('账户动作额度不足:', error.used, error.limit, error.required);
  } else {
    throw error;
  }
}
```

恢复查询每次最多 10,000 个键；更大的批次应分组。`NOT_FOUND` 只能表示当前没查到，不能直接证明原交易从未被接收；可能存在执行延迟、结果缓存范围或索引延迟。`nonce_used` 同样不能视为成功，应查 archive 的交易和动作历史。

SDK 不自动重发 Submit。它也不会在响应丢失后自动换 nonce 创建另一笔交易。准备好的签名可供业务恢复流程使用，提交前仍会核对账户、当前签名授权和链身份。

## 5. 超时与取消

```ts
const controller = new AbortController();
const response = await exchange.order(
  { coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001' },
  {
    signal: controller.signal,
    timeoutMs: 30000,
    intervalMs: 500,
  },
);
```

单次 RPC 默认超时 10 秒，接收后的执行等待默认 15 秒。显式传 `timeoutMs` 时也用于提交请求；执行等待另起同样长度的总期限。内部轮询分组共用执行等待期限。

执行等待正常到期会返回仍为 `pending` 的项，保留已确认项；接收后的查询失败或调用方主动取消，会抛出 `ExchangeTrackingError`。取消本地等待不会撤回链上交易。

不等待执行可传 `{ waitForExecution: false }`，此时 `accepted` 项的 outcome 为 `pending`；你的业务需要后续查询确认。

## 6. 多实例共享 nonce

```ts
import { NonceAllocator, Exchange } from '@svpchain/trading-sdk';

const shared = new NonceAllocator({ namespace: 'my-app' });
const options = { baseUrl, account, expectedGenesisHash, nonceManager: shared };
const first = new Exchange({ ...options, signer: { type: 'agent', seed: firstSeed, slot: 1 } });
const second = new Exchange({ ...options, signer: { type: 'agent', seed: secondSeed, slot: 2 } });
```

同一网络、同一账户的 owner 与所有 agent 共用 nonce 空间。同一实例会复用其分配器，多个实例需显式共享；不要因为切换 agent 就换一套互不协调的 nonce。

默认分配器只协调当前 JS 实例，不提供跨进程或跨浏览器标签页的互斥保证。多进程部署应实现 `NonceManager` 的 `next(account)` 和 `syncFromChain(account, lastNonce)`，使用外部原子协调；不同网络使用不同命名空间。

链的 nonce 乱序窗口为 16，唯一分配不能保证无限并发乱序仍可接收。需要先授权再下单、先改单再依赖新单等场景，等待前一步确认后再继续。控制同账户并发，优先使用不同账户分摊吞吐。

## 7. 批量大小与额度

`bulkOrders()`、`bulkCancel()` 和 `executeActions()` 每次最多 20,000 项，提交前会验证整批输入并准备所有签名，再发送一次提交请求；不保证整批原子执行。

请求还有字节限制。SDK 默认上限 8 MiB，节点和代理可能更小。应按实际环境设置 `maxRequestBytes` 并控制批次大小，不要直接将 20,000 项当作建议批量。大批次的前置查询、签名和执行等待也会占用时间。

`userRateLimit(account)` 返回账户累计动作额度；这与 HTTP 每秒限流、gas、钱包 SVP 余额是不同概念。owner 与 agent 共享额度，充值和更换签名 key 不会重置。Cancel / CancelAll 免额度，新 Exchange 在准备其他动作前检查剩余额度；并发提交仍可能在检查后耗尽，需要处理链上最终拒绝。

## 8. 钱包与密钥

Web 应用优先通过钱包回调创建 owner signer，批准专门的 agent；不要把 owner 私钥放进前端包。agent seed 也具备交易权限，不能写入源码、日志或提交到仓库。

`createOwnerKeySigner()` 适合受控 Node.js 服务。SDK 会复制传入 key / seed，调用方后续修改原数组不会切换签名身份。agent 被换 key、撤销或过期后应重新确认授权；已准备交易可能不再有效。

## 9. 最小接入验证

先在测试环境用专门账户完成授权、下单、查挂单、撤单、成交与仓位核对，再进入持续交易。仓库自动测试使用模拟链服务，不能代替你的目标环境验证。

查询方法见 [Info 方法](API.md)。
