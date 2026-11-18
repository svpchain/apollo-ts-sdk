# Feature Overview

English | [简体中文](zh-CN/FEATURES.md)

The Apollo TypeScript SDK provides the market query, account query, trading, historical data, authorization, and result-handling APIs needed for perpetuals trading.

When choosing an API, start from your use case, then see the corresponding page for parameters, examples, return data, and limits.

## Available trading features

| Need | Public API | Notes |
| --- | --- | --- |
| Query markets and trading precision | `Info.meta`, `Info.market` | Market status, ticker, tick / step, plus public fee tiers and funding configuration |
| Query order book and tickers | `Info.l2Snapshot`, `Info.ticker` | HTTP snapshot with order book and ticker data |
| Query account assets and risk | `Info.userState`, `Info.userStateById` | Collateral, equity, available margin, risk status, and positions |
| Query positions and open orders | `Info.positions`, `Info.openOrders` | Open orders can be filtered by market |
| Limit, IOC, post-only | `Exchange.order`, `Exchange.bulkOrders` | Single and bulk; results returned per item |
| Market open, close position | `Exchange.marketOpen`, `Exchange.marketClose` | Uses slippage protection; closing specifies the long/short slot and size explicitly |
| Take profit, stop loss | `orderType.trigger` of `Exchange.order` | Supports trigger market and trigger limit |
| Single, bulk, and all-market cancel | `Exchange.cancel`, `Exchange.bulkCancel`, `Exchange.cancelAll` | By order, market, or all markets |
| Single and bulk modify | `Exchange.modifyOrder`, `Exchange.bulkModify` | Cancels the old order and creates a new one; results handled per item; batches are not guaranteed atomic |
| Adjust leverage and isolated margin | `Exchange.updateLeverage`, `Exchange.updateIsolatedMargin` | Still subject to on-chain market and account risk limits |
| Create and cancel TWAP, create scaled orders | `Exchange.twapOrder`, `Exchange.cancelTwap`, `Exchange.scaledOrder` | TWAP is cancelled by parent order ID, cancelling the plan and current child order; creation success and final fills are checked separately |
| Approve and revoke trading agents | `Exchange.approveAgent`, `Exchange.revokeAgent` | Owner operation; trading agents cannot manage authorizations |
| Summarize fees and fill rebates | `Info.userFees`, `summarizeFees` | Summarizes given records or the current page by account and market, in micro-USD; keeps pagination and index range |
| Query fill and action history | `Info.userFills`, `Info.historicalOrders`, `Info.actionHistory` | Depends on archive and the history index; order history returns order-related action records |
| Query candles and market funding index | `Info.candlesSnapshot`, `Info.fundingHistory` | Candles by time range; funding index by height range |
| Query action execution and transactions | `Info.actionStatus`, `Info.transaction` | Reconcile by account / nonce or transaction hash |
| Check authorizations and cumulative allowance | `Info.agents`, `Info.nonce`, `Info.userRateLimit` | Supports transaction preparation and error recovery |
| Separate prepare and submit | `Exchange.prepareOrder`, `Exchange.submitPrepared` | The prepare step does not broadcast; the submit step re-checks signing authorization |

## Reading order

1. [Quick start](../README.md): installation, queries, and your first trade.
2. [API overview](API.md): initialization options, parameter types, and method index.
3. [Market and account queries](reference/INFO.md): tickers, assets, positions, open orders, and authorizations.
4. [Trading APIs](reference/EXCHANGE.md): place, cancel, and modify orders, risk settings, and advanced orders.
5. [Historical data](reference/HISTORY.md): fills, actions, candles, and funding index.
6. [Result handling](reference/RESULTS.md): node acceptance, execution, fills, errors, and reconciliation.
7. [Integration guide](USAGE.md): concurrency, precision, timeouts, keys, and environment verification.
