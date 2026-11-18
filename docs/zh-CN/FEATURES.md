# 功能总览

[English](../FEATURES.md) | 简体中文

Apollo TypeScript SDK 提供永续交易所需的市场查询、账户查询、交易、历史数据、授权和结果处理接口。

选择接口时先确定业务目的，再到对应页面查看参数、调用示例、返回数据和使用限制。

## 已提供的交易功能

| 接入需求 | 对外接口 | 说明 |
| --- | --- | --- |
| 查询市场及交易精度 | `Info.meta`、`Info.market` | 市场状态、ticker、tick / step，以及公共费率档位和资金费配置 |
| 查询订单簿与行情 | `Info.l2Snapshot`、`Info.ticker` | HTTP 快照，包含盘口与行情数据 |
| 查询账户资产和风险 | `Info.userState`、`Info.userStateById` | 保证金、权益、可用保证金、风险状态及仓位 |
| 查询持仓和当前挂单 | `Info.positions`、`Info.openOrders` | 支持按市场筛选挂单 |
| 限价、IOC、只挂单 | `Exchange.order`、`Exchange.bulkOrders` | 支持单笔和批量，逐项返回结果 |
| 市价开仓、平仓 | `Exchange.marketOpen`、`Exchange.marketClose` | 使用滑点保护；平仓明确指定多空槽位和数量 |
| 止盈、止损 | `Exchange.order` 的 `orderType.trigger` | 支持触发市价或触发限价 |
| 单笔、批量、全市场撤单 | `Exchange.cancel`、`Exchange.bulkCancel`、`Exchange.cancelAll` | 指定订单、市场或全部市场 |
| 单笔、批量修改订单 | `Exchange.modifyOrder`、`Exchange.bulkModify` | 撤销旧单后创建新单，逐项处理结果，不保证整批原子执行 |
| 调整杠杆和逐仓保证金 | `Exchange.updateLeverage`、`Exchange.updateIsolatedMargin` | 仍受市场和账户的链上风控限制 |
| 创建、取消 TWAP，创建分批订单 | `Exchange.twapOrder`、`Exchange.cancelTwap`、`Exchange.scaledOrder` | TWAP 按父订单 ID 取消计划及当前子单，创建成功与最终成交分开判断 |
| 授权、撤销交易 agent | `Exchange.approveAgent`、`Exchange.revokeAgent` | owner 操作；交易 agent 无权管理授权 |
| 汇总手续费与成交返佣 | `Info.userFees`、`summarizeFees` | 按账户及市场汇总传入记录或当前页，金额为微 USD；保留分页和索引范围 |
| 查询成交与动作历史 | `Info.userFills`、`Info.historicalOrders`、`Info.actionHistory` | 依赖 archive 和历史索引；订单历史返回与订单有关的动作记录 |
| 查询 K 线及市场资金费指数 | `Info.candlesSnapshot`、`Info.fundingHistory` | K 线按时间范围；资金费指数按高度范围 |
| 查询动作执行及交易 | `Info.actionStatus`、`Info.transaction` | 使用 account / nonce 或交易哈希进行对账 |
| 检查授权和累计额度 | `Info.agents`、`Info.nonce`、`Info.userRateLimit` | 支持交易准备和异常恢复 |
| 分开准备与提交 | `Exchange.prepareOrder`、`Exchange.submitPrepared` | 准备阶段不广播，提交阶段重新核对签名授权 |

## 阅读顺序

1. [快速开始](../../README_zh-CN.md)：安装、查询及第一笔交易。
2. [API 总览](API.md)：初始化选项、参数类型和方法索引。
3. [市场和账户查询](reference/INFO.md)：行情、资产、仓位、挂单和授权。
4. [交易接口](reference/EXCHANGE.md)：下单、撤单、改单、风险设置和高级订单。
5. [历史数据](reference/HISTORY.md)：成交、动作、K 线及资金费指数。
6. [结果处理](reference/RESULTS.md)：节点接收、执行、成交、异常与对账。
7. [接入指南](USAGE.md)：并发、精度、超时、密钥及环境验证。
