# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

## 1.0.2

- The npm package page now shows the English README. The Chinese README is renamed to `README_zh-CN.md` and remains available on GitHub.

## 1.0.1

- Added English documentation; English is now the default. The Chinese docs moved to `README.zh-CN.md` and `docs/zh-CN/`, with a language switcher at the top of every page.

## 1.0.0

First public release.

- `Info` queries: markets, order book, tickers, accounts, positions, open orders, fills, fee summaries, and historical data.
- `Exchange` trading: limit, trigger, and market IOC orders; bulk place / modify / cancel; close position; leverage; isolated margin; TWAP; scaled orders; and agent approval.
- Three signing methods: wallet callback, local owner key, and agent.
- Separate prepare and submit steps, chain identity checks, execution tracking, and reconciliation after an uncertain submit.
- Exact decimal conversion, concurrent nonce allocation, request timeouts, and cancellation.
- ESM with TypeScript type declarations; supports Node.js 22+ and modern browsers.
