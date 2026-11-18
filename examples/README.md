# 命令行示例

示例直接调用 SDK。先在 SDK 仓库安装依赖并编译：

```bash
npm ci
npm run build
npm run examples:build
```

使用 Node.js 22 及以上。环境变量由调用方通过 shell 或本地配置文件提供，脚本不会自动加载或输出密钥。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `APOLLO_RPC_URL` | Apollo HTTP(S) JSON-RPC 地址 |
| `APOLLO_ACCOUNT` | 非零账户数字 ID，账户查询和交易使用 |
| `APOLLO_GENESIS_HASH` | 可信创世哈希，签名交易必填，查询时也可设置以核对目标链 |
| `APOLLO_AGENT_SEED` | 已由账户 owner 授权的 32 字节 agent seed 十六进制 |
| `APOLLO_AGENT_SLOT` | 撤单 / 改单工具中的 agent 槽位，默认 1；普通 order.js 示例固定槽位 1 |
| `APOLLO_COIN` | 市场完整 ticker；查询挂单不传则查全部市场 |
| `APOLLO_PRICE` / `APOLLO_SIZE` | 价格和基础币数量的十进制字符串 |
| `APOLLO_ORDER_ID` | 目标订单 ID 的十进制数字字符串，不带末尾的 n |

价格、数量需要满足目标市场的 tick / step。配置文件包含密钥时仅在本地保管；仓库忽略 `.env.*` 文件。

## 查询链和市场

```bash
node .examples-dist/query.js
```

只需要 APOLLO_RPC_URL，返回链身份和市场列表。

## 下单

```bash
# 准备并签名，不广播
node .examples-dist/order.js

# 真实提交一笔 Gtc 限价买单
node .examples-dist/order.js --submit
```

设置 RPC、账户、可信创世哈希、agent seed、市场、价格和数量。示例固定使用槽位 1。每次运行会重新准备交易并分配 nonce；保存真实提交那次输出的订单 ID 和交易哈希。

## 查询挂单

```bash
npm run example:orders
npm run example:orders -- --coin BTC-USD
npm run example:orders -- --order-id "$APOLLO_ORDER_ID"
```

需要 RPC 和账户 ID，不需要 agent seed。可按完整 ticker 和订单 ID 筛选，命令行参数优先于同名环境配置。结果显示订单 ID、市场、方向、价格、剩余数量和持仓槽位。

查询不到挂单时，结合动作执行和成交记录判断最终状态。

## 撤销指定订单

```bash
# 只准备撤单签名
npm run example:cancel -- --order-id "$APOLLO_ORDER_ID"

# 真实发送撤单
npm run example:cancel -- --order-id "$APOLLO_ORDER_ID" --submit
```

市场来自 APOLLO_COIN，也可以传 --coin。脚本只处理指定账户、市场和订单 ID，默认不广播。需要设置有效的 agent 和创世哈希。

执行成功后会重新查询挂单，输出 `Still open after cancellation: false`。输出中另一个 nonce 属于撤单动作，目标订单 ID 保持不变。

## 修改指定订单

```bash
# 准备修改后的价格与数量
npm run example:modify -- --order-id "$APOLLO_ORDER_ID" --price 65100 --size 0.001

# 真实提交修改
npm run example:modify -- --order-id "$APOLLO_ORDER_ID" --price 65100 --size 0.001 --submit
```

Price / Size 参数也可来自环境变量，命令行优先。修改先撤旧单再建新单，替换成功后使用新订单 ID；即使替换失败，旧单也可能已经撤销。

## 结果和异常

接收、执行和成交分别判断。accepted 表示节点接收；executed 且 ok=true 表示动作执行成功，实际成交仍需查询。

未确认成功时，撤单 / 改单脚本以非零状态退出并保留对账标识。提交结果不确定或查询中断时，先核查原 account / nonce，避免直接重发。脚本不自动重试提交。

## 帮助和验证

```bash
npm run example:orders -- --help
npm run example:cancel -- --help
npm run example:modify -- --help

# 本地模拟节点验证，不使用真实账户或发送链上交易
npm run test:examples
```
