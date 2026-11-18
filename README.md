# Apollo TypeScript SDK

`@svpchain/trading-sdk` 是 Apollo 的 HTTP JSON-RPC 交易 SDK，可用于 Web 应用、Node.js 服务和交易机器人。

接口按 `Info` / `Exchange` 组织：`Info` 查询市场和账户，`Exchange` 负责签名、下单和账户操作。价格、数量使用十进制字符串，交易结果逐项返回。

| 客户端 | 常用方法 |
| --- | --- |
| `Info` | `meta`、`l2Snapshot`、`userState`、`openOrders`、`userFills`、`userFees` |
| `Exchange` | `order`、`bulkOrders`、`bulkModify`、`cancelTwap`、`marketOpen`、`marketClose` |

支持的交易与查询接口见 [功能总览](docs/FEATURES.md)。各类接口按用途、参数、调用示例和返回值介绍。

## 安装

```bash
npm install @svpchain/trading-sdk
```

默认安装最新正式版，并把具体版本写入你项目的 `package.json` 和 lock 文件。需要固定版本时写明版本号，例如 `npm install @svpchain/trading-sdk@1.0.0`。各版本的变更见 [版本记录](CHANGELOG.md)。

运行环境为 Node.js 22+，或支持 `fetch`、`AbortController`、`BigInt` 的现代浏览器。SDK 为 ESM，附带 TypeScript 类型声明，不依赖 React。

## 查询市场和账户

```ts
import { Info } from '@svpchain/trading-sdk';

const info = new Info({ baseUrl: 'https://rpc.example.com' });
const { markets } = await info.meta();
const market = markets.find(m => m.ticker === 'BTC-USD');
if (!market) throw new Error('Market not found');

const book = await info.l2Snapshot(market.id, 20);
const account = await info.userState('0xYourOwnerAddress');
console.log(book.bids, book.asks, account.account);
```

`baseUrl` 填 Apollo 节点的 HTTP(S) JSON-RPC 地址。`coin` 是市场列表里的完整 `ticker`，例如 `BTC-USD`，不应直接填 `BTC`。账户交易使用链上数字 ID；可先通过 owner 地址查询。

查询返回的是带类型的链上数据，64 位整数为 `bigint`。显示价格和数量时使用 SDK 的转换工具，见 [API](docs/API.md)。

## 用已授权的 agent 下单

下面的 `seed`、`account`、`expectedGenesisHash` 都应从你的环境提供；agent 公钥需要事先获得账户 owner 授权。

```ts
import { Exchange, hexToBytes32 } from '@svpchain/trading-sdk';

const exchange = new Exchange({
  baseUrl: 'https://rpc.example.com',
  expectedGenesisHash, // 目标链的创世哈希，0x 十六进制或 32 字节
  account,            // 链上账户数字 ID
  signer: { type: 'agent', seed: hexToBytes32(agentSeedHex), slot: 1 },
});

const response = await exchange.order({
  coin: 'BTC-USD',
  isBuy: true,
  price: '65000',
  size: '0.001',
  orderType: { limit: { tif: 'Gtc' } },
});

for (const status of response.statuses) {
  console.log(status.prepared.transactionHash, status.submitStatus, status.outcome);
}
if (!response.successful()) {
  // 逐项处理拒绝、待确认或 nonce 已用等结果。
  console.log(response.statuses);
}
```

默认等待执行最多 15 秒。`successful()` 表示全部动作执行成功，**不能据此认定订单已成交**；挂单和成交需继续查询。节点接收和执行失败也会逐项返回，详见 [结果处理](docs/USAGE.md)。

## 常用交易

```ts
// 批量下单：一个提交请求，逐项返回结果。
const batch = await exchange.bulkOrders([
  { coin: 'BTC-USD', isBuy: true, price: '64000', size: '0.001' },
  { coin: 'BTC-USD', isBuy: false, price: '66000', size: '0.001', position: 'Short' },
]);

// 市价意图会转换为带滑点保护的 IOC 订单，默认滑点 1%。
const opened = await exchange.marketOpen({
  coin: 'BTC-USD', isBuy: true, size: '0.001', slippage: '0.01',
});

const cancelled = await exchange.cancel({ coin: 'BTC-USD', orderId });
const allCancelled = await exchange.cancelAll('BTC-USD'); // '' 表示全部市场
const modified = await exchange.modifyOrder({
  coin: 'BTC-USD', orderId, price: '65100', size: '0.001',
});
const closed = await exchange.marketClose({
  coin: 'BTC-USD', position: 'Long', size: '0.001', slippage: '0.01',
});
```

每次调用都会执行对应交易。上面的代码展示方法签名，实际接入时应根据业务选择调用，并检查每次返回结果。

Apollo 支持多空持仓槽位，平仓要指定 `Long` / `Short` 和数量。默认全仓；`isolated: true` 选择逐仓。改单会先撤旧单再建新单，新单失败时旧单可能已经撤销。批量操作不保证原子执行。

## 批量改单、TWAP 取消与费用

```ts
const modified = await exchange.bulkModify([
  { coin: 'BTC-USD', orderId: firstOrderId, price: '65100', size: '0.001' },
  { coin: 'BTC-USD', orderId: secondOrderId, price: '65200', size: '0.002' },
]);
const cancelled = await exchange.cancelTwap({ coin: 'BTC-USD', orderId: twapParentId });
const fees = await info.userFees({ account, limit: 100 });
console.log(modified.statuses, cancelled.statuses);
console.log(fees.summary.feesPaid, fees.summary.rebates, fees.summary.netFees, fees.next);
```

TWAP 取消使用父订单 ID，会取消父计划和当前子单。费用按成交记录中的 makerFee / takerFee 统计，使用微 USD 整数，`feesPaid` 和 `rebates` 为正数，`netFees` 为支付减返佣。`userFees()` 汇总当前成交页，保留 `next` 和索引范围；全量汇总需要继续分页。详见 [交易接口](docs/reference/EXCHANGE.md) 和 [费用说明](docs/reference/HISTORY.md#账户手续费与成交返佣userfees)。

## Owner 钱包与 agent 授权

```ts
import { Exchange, createWalletSigner, createAgentSigner } from '@svpchain/trading-sdk';

if (!wallet.account) throw new Error('Connect the owner wallet first');
const walletAccount = wallet.account;
const owner = new Exchange({
  baseUrl, account, expectedGenesisHash,
  signer: createWalletSigner(data =>
    wallet.signTypedData({ ...data, account: walletAccount })),
});

const { publicKey } = createAgentSigner(agentSeed, 1, 0);
const approval = await owner.approveAgent(1, publicKey, 0n);
if (!approval.successful()) throw new Error('Agent approval is not confirmed');
// 0n 表示无到期高度。确认授权后，再使用该 agent 交易。
```

Node.js 服务也可使用 `createOwnerKeySigner(ownerPrivateKey)`。钱包签名回调与本地 owner key 都会在准备阶段核对链上 owner 身份。agent 授权槽位为 1–4，agent 不能批准或撤销其他 agent。

## 只准备，不广播

```ts
const prepared = await exchange.prepareOrder({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
});
console.log(prepared.transactionHash, prepared.nonce);

// 业务确认后，显式提交已准备的交易。
const response = await exchange.submitPrepared([prepared]);
```

SDK 不自动重发交易。提交超时或响应丢失时，使用原 account / nonce 查询结果，避免直接生成第二笔订单。准备和提交之间若发生 agent 撤销、换 key 或切链，会拒绝提交。

## 并发与限制

- 同一 Exchange 内共享 nonce 分配器。多个实例操作同一账户时，显式传入同一个 `nonceManager`；多个进程需要外部原子协调。
- 批量上限为 20,000 项，还受到请求字节大小和服务端限制；并非任意 20,000 项都能成功提交。
- 价格、数量、保证金均传字符串；不符合 tick / step 的限价或数量会报错。

## 文档与示例

- [功能总览](docs/FEATURES.md)
- [API 参数与返回值](docs/API.md)
- [市场和账户查询](docs/reference/INFO.md)
- [交易接口](docs/reference/EXCHANGE.md)
- [历史数据](docs/reference/HISTORY.md)
- [交易结果与异常](docs/reference/RESULTS.md)
- [接入、结果处理与并发](docs/USAGE.md)
- [版本与运行环境](PROVENANCE.md)
- [版本记录](CHANGELOG.md)
- [命令行示例用法](examples/README.md)：查询挂单、准备订单、改单和撤单。
- `examples/query.ts`：只读查询。
- `examples/order.ts`：默认只准备，显式 `--submit` 才广播。
- `examples/wallet.ts`：钱包授权 agent。
- `examples/open-orders.ts`：查询并格式化挂单，可按订单 ID 筛选。
- `examples/cancel.ts`：准备或提交指定订单的撤单，并核对撤单后的挂单。
- `examples/modify-order.ts`：准备或提交指定订单的价格和数量修改。
- `examples/trading.ts`：交易与撤单集成函数。

```bash
npm run check
npm test
npm run build
npm run examples:build
npm run test:examples
npm run test:package
```
