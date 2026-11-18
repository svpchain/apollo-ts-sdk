# 版本与运行环境

[English](PROVENANCE.md) | 简体中文

## 版本

包名：`@svpchain/trading-sdk`，遵循语义化版本，各版本变更见 [版本记录](CHANGELOG.zh-CN.md)。

SDK 使用 ESM，附带 TypeScript 类型声明。安装方法见 [快速开始](README_zh-CN.md#安装)。

## 运行环境

- Node.js 22 及以上。
- 支持 `fetch`、`AbortController`、`BigInt` 和 `structuredClone` 的现代浏览器。
- TypeScript 项目使用支持 ESM 的模块配置。

## 客户端

- `Info`：市场、盘口、账户、持仓、挂单、成交、费用及历史查询。
- `Exchange`：下单、撤单、改单、杠杆、逐仓保证金、TWAP、分批订单及 agent 授权。

## 接入配置

`baseUrl` 使用目标环境的 Apollo HTTP(S) JSON-RPC 地址。交易客户端配置账户 ID、signer 和目标创世哈希。历史查询连接提供 archive 索引的节点，并通过 `indexStatus()` 确认数据高度。

接口目录见 [功能总览](docs/zh-CN/FEATURES.md)，参数与结果类型见 [API](docs/zh-CN/API.md)。
