# API

English | [简体中文](zh-CN/API.md)

The entry points are `Info` (read-only queries) and `Exchange` (signed trading), providing trading access over Apollo HTTP JSON-RPC.

This page is an overview of options and types. Browse by task:

| Page | Contents |
| --- | --- |
| [Feature overview](FEATURES.md) | Trading, query, authorization, and result-handling APIs |
| [Market and account queries](reference/INFO.md) | Markets, order book, tickers, assets, positions, and open orders |
| [Trading APIs](reference/EXCHANGE.md) | Place, cancel, and modify orders, risk settings, and authorization |
| [Historical data](reference/HISTORY.md) | Fills, order actions, candles, funding index, and pagination |
| [Results and errors](reference/RESULTS.md) | Acceptance, execution, fills, and recovery |

## Initialization

```ts
import { Info, Exchange } from '@svpchain/trading-sdk';

const info = new Info({ baseUrl });
const exchange = new Exchange({
  baseUrl, account, expectedGenesisHash,
  signer: { type: 'agent', seed, slot: 1 },
});
```

| Common option | Type | Description |
| --- | --- | --- |
| `baseUrl` | `string` | Node HTTP(S) JSON-RPC endpoint, required |
| `expectedGenesisHash` | `0x` string or `Uint8Array` | Optional 32-byte genesis hash of the target chain; recommended to set explicitly for trading |
| `defaultTimeoutMs` | `number` | Per-request timeout, default 10,000 ms |
| `maxRequestBytes` | `number` | Per-request byte limit, default 8 MiB; server limits also apply |
| `maxResponseBytes` | `number` | Per-response byte limit, default 16 MiB |
| `fetch` | `typeof fetch` | Custom request function |
| `nonceManager` | `NonceManager` | Pass when multiple trading instances share nonces for the same account |

`Exchange` additionally requires `account: number` and `signer: ExchangeSigner`. `account` is the ID of an existing non-vault account, in the range 1–4,294,967,295.

The last argument of every query method accepts `{ signal?: AbortSignal }`. Trading methods also accept `SubmitOptions`:

| Trading option | Default | Description |
| --- | --- | --- |
| `waitForExecution` | `true` | Whether to keep querying execution results after the node accepts |
| `timeoutMs` | `15000` | Total wait time for execution polling, in ms; when set explicitly, also applies to the submit request |
| `intervalMs` | `250` | Execution polling interval, in ms |
| `signal` | none | Cancels this request and wait; accepted transactions may still execute |

`exchange.connect()` verifies the chain identity up front and returns chain info. After its first connection, Exchange pins that chain's genesis hash and re-checks it on every subsequent sign or submit.

## Info

Return values keep the RPC's typed response structure: 64-bit integers are `bigint`, bytes are `Uint8Array`, and enums are their numeric values. The `account` in history requests is a `bigint`; the convenience account methods use `number`.

| Method | Parameters | Returns |
| --- | --- | --- |
| `chainInfo()` | — | chainId, genesisHash, executedHeight, etc. |
| `meta()` | — | `markets` list with status, precision, mark, etc. |
| `market(coin)` | Full ticker | A single market object; throws if not found |
| `l2Snapshot(market, depth = 20)` | Market ID, depth | `bids` / `asks` order book |
| `ticker(market)` | Market ID | Latest ticker |
| `userState(owner)` | 20-byte owner address or `0x` string | Account info; throws per RPC rules if it does not exist |
| `userStateById(account)` | Account ID | Account info |
| `positions(account)` | Account ID | Long and short positions |
| `openOrders(account, market?)` | Optional market ID | Open orders; omit the market for all markets, `0` is a valid market ID |
| `agents(account)` | Account ID | Approved agents, slots, sequence numbers, expiry heights |
| `nonce(account)` | Account ID | Used-nonce state |
| `userRateLimit(account)` | Account ID | Cumulative action allowance `used` / `limit` / `remaining` |
| `actionStatus(keys)` | `[{ account, nonce }]`, 1–10,000 items | Execution status per item; verify the returned keys, count, and status |
| `transaction(hash)` | 32-byte hash or `0x` string | Transaction query result; verify the returned hash |
| `indexStatus()` | — | History index status |
| `userFills(params)` | `UserFillsParams` | Fill list and `next` cursor |
| `userFees(params)` | `UserFeesParams` | Fee summary for the current page of fills, `index`, and `next` |
| `historicalOrders(params)` | `HistoryParams` | Historical orders and cursor |
| `actionHistory(params)` | `HistoryParams` | Account action history and cursor |
| `candlesSnapshot(params)` | `CandlesParams` | Candles |
| `fundingHistory(params)` | `FundingHistoryParams` | Funding index history |

Historical queries depend on an archive node and its index status. When `next` is present, pass it as `after` in the next request and keep the other filters.

```ts
const first = await info.userFills({ account: BigInt(account), limit: 100 });
if (first.next) {
  const second = await info.userFills({
    account: BigInt(account), limit: 100, after: first.next,
  });
  console.log(second.fills);
}
```

| History params | Fields |
| --- | --- |
| `UserFillsParams` | `account?: bigint`, `market?: number`, `fromHeight?: bigint`, `after?: { height?: bigint; index?: number }`, `limit?: number` |
| `UserFeesParams` | `account: number` is required; market, height, cursor, and limit are the same as `UserFillsParams` |
| `HistoryParams` | `account?: bigint`, `fromHeight?: bigint`, `after?`, `limit?: number`; account is required in practice |
| `CandlesParams` | `market?: number`, `interval?: CandleInterval`, `fromUnixS?: bigint`, `toUnixS?: bigint`, `limit?: number` |
| `FundingHistoryParams` | `market?: number`, `fromHeight?: bigint`, `limit?: number` |

These params are generated from the RPC types, so TypeScript autocompletion covers them; the candle enum is `history.CandleInterval` from `@svpchain/trading-sdk/protocol`. The server caps history limit at 1,000; 0 means the default of 100.

## Place orders: order / bulkOrders

```ts
const request = {
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  orderType: { limit: { tif: 'Gtc' as const } },
};
const response = await exchange.order(request);
const batch = await exchange.bulkOrders([request, request]);
```

`CreateOrderRequest`:

| Field | Type / default | Description |
| --- | --- | --- |
| `coin` | `string`, required | Full market ticker |
| `isBuy` | `boolean`, required | true to buy, false to sell |
| `size` | decimal `string`, required | Base-asset size; must match the market step |
| `price` | decimal `string` | Required for limit orders and trigger limit orders; must match tick |
| `orderType` | defaults to a plain limit order | Either `limit` or `trigger` |
| `orderType.limit.tif` | `Gtc` / `Ioc` / `PostOnly`, default `Gtc` | Time in force |
| `orderType.trigger.triggerPrice` | decimal `string` | Trigger price; must match tick |
| `orderType.trigger.isMarket` | `boolean` | Whether to execute as a market intent once triggered |
| `orderType.trigger.tpsl` | `tp` / `sl` | Take profit / stop loss |
| `reduceOnly` | `false` | Reduce-only |
| `position` | `Long` / `Short` | Defaults to Long for buys and Short for sells; specify explicitly when reducing |
| `isolated` | `false` | true for isolated margin, false for cross margin |
| `goodTilBlock` | `bigint` | Expiry block height; 0 means not set |
| `builder` | `{ account: number; feePpm: number }` | Optional builder info |
| `referencePrice` | decimal `string` | Reference price for the protective price of trigger market orders; if omitted, the order book is queried, falling back to mark |
| `slippage` | decimal `string`, default `'0.01'` | Market protection ratio, in the range 0–1, excluding 1 |

Prices and sizes are positive decimal strings; JS numbers and scientific notation are not accepted. Exceeding the market's representable precision, deviating from tick / step, an inactive market, and similar cases throw before broadcasting.

Stop-loss market example:

```ts
const stopped = await exchange.order({
  coin: 'BTC-USD', isBuy: false, size: '0.001',
  position: 'Long', reduceOnly: true,
  orderType: { trigger: { triggerPrice: '60000', isMarket: true, tpsl: 'sl' } },
  slippage: '0.01',
});
```

## Cancel and modify orders

| Method | Request |
| --- | --- |
| `cancel(request)` | `{ coin: string; orderId: bigint }` |
| `bulkCancel(requests)` | Array of the above requests |
| `cancelAll(coin = '')` | Full ticker; an empty string means all markets |
| `modifyOrder(request)` | `{ coin; orderId; price: string; size: string }` |
| `bulkModify(requests)` | Array of the above modify requests, 1–20,000 items, submitted once and returned per item |
| `cancelTwap(request)` | `{ coin: string; orderId: bigint }`, where orderId is the TWAP parent order ID |

`orderId` must be a `bigint` to avoid exceeding the JS safe integer range. Modifying an order cancels the old order and places a new one; a rejected new order does not mean the old order still exists.

`cancelTwap()` reuses the existing cancel action and cancels the parent plan and its current child order. Bulk modify validates fields for the whole batch before signing; each item executes independently on-chain.

## Market open and close

```ts
await exchange.marketOpen({
  coin: 'BTC-USD', isBuy: true, size: '0.001', slippage: '0.01',
});
await exchange.marketClose({
  coin: 'BTC-USD', position: 'Long', size: '0.001', slippage: '0.01',
});
```

`MarketOrderRequest` accepts `coin`, `isBuy`, `size`, `position?`, `reduceOnly?`, `isolated?`, `referencePrice?`, `slippage?`. There are no naked market orders: buys reference the best ask, sells reference the best bid, an empty order book falls back to mark, and the SDK then builds an IOC order with a protective limit price.

`ClosePositionRequest` requires `position` and `size`; the SDK determines the buy/sell side and forces reduce-only. It does not read positions, choose a size, or change leverage automatically.

## Leverage and margin

```ts
const leverage = await exchange.updateLeverage('BTC-USD', '5');
const margin = await exchange.updateIsolatedMargin('BTC-USD', 'Long', '10.50');
```

`updateLeverage(coin, leverage)` takes leverage as a decimal string in the range 1–1,000,000; the actual usable maximum is still constrained by market risk controls.

`updateIsolatedMargin(coin, position, amount)` takes an amount in USD: positive to add, negative to remove, with up to 6 decimal places; higher precision is rejected.

## TWAP and scaled orders

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

`CreateTwapOrderRequest` requires `coin`, `isBuy`, `size`, `durationS`, `intervalS`, with optional `price`, `tolerancePpm`, `position`, `reduceOnly`, `isolated`. `tolerancePpm` defaults to 10,000 (1%), in the range 0–999,999. A successful TWAP execution means the plan was created, not that all of its child orders have been filled.

`CreateScaledOrderRequest` requires `coin`, `isBuy`, `size`, `lowestPrice`, `highestPrice`, `numOrders`. Optional:

- `profile`: `Equal` (default), `IncRatio`, `IncDiff`, `DecRatio`, `DecDiff`.
- `spacing`: `Linear` (default) or `Geometric`.
- `magnitudePpm`: default 0, and must be 0 for Equal; other profiles must satisfy their size-distribution constraints.
- `tif`: `Gtc` (default) or `Ioc`.
- `position`, `reduceOnly`, `isolated`, `goodTilBlock`: same meaning as for regular orders.

`size` is the total size; child order sizes and prices must also satisfy market precision and on-chain validation.

## Signers and agent management

| Signer | How to create |
| --- | --- |
| agent | `{ type: 'agent', seed: Uint8Array, slot?: number }`, 32-byte seed, slot defaults to 1 |
| Wallet owner | `createWalletSigner(signTypedDataCallback)` |
| Local owner | `createOwnerKeySigner(privateKey)`, 32 bytes or `0x` string |

The wallet callback receives the full typed data and asynchronously returns a `0x` signature string. Owner transactions first verify that the signing address matches the on-chain account; agent transactions use the current on-chain approval sequence number.

```ts
const approved = await owner.approveAgent(1, publicKey, 0n);
// Check approved.successful() first. To revoke:
const revoked = await owner.revokeAgent(1);
```

`approveAgent(slot, publicKey, expiry = 0n)` / `revokeAgent(slot)` are owner-only. slot is 1–4, publicKey is 32 bytes, and expiry is the expiry block height, where 0 means no expiry height. After a key rotation or revocation, earlier signatures may become invalid.

## Prepare, execute, and extended transactions

| Method | Purpose |
| --- | --- |
| `prepareOrder(request)` | Prepares a single order from user-facing fields and returns a `PreparedAction`, without broadcasting |
| `prepare(action)` / `prepareActions(actions)` | Prepares pre-built `TradingAction`s, without broadcasting |
| `execute(action)` / `executeActions(actions)` | Prepares and submits pre-built `TradingAction`s |
| `submitPrepared(prepared[])` | Verifies signed data and submits it as a batch, returning an `OrderResponse` |

`TradingAction` uses on-chain units; regular integrations should prefer field-based APIs such as `order()`. `PreparedAction` provides the `account`, `nonce`, `genesisHash`, and `transactionHash` needed for reconciliation, and keeps the signed transaction for later submission; it does not contain the private key.

A new Exchange checks the cumulative action allowance during the prepare step; Cancel / CancelAll are exempt. Batches are limited to 20,000 items, and submission is also subject to the request byte limit; batches are not automatically split into multiple submits. Execution queries are grouped into chunks of at most 10,000 items.

## Return values and errors

All trading methods return an `OrderResponse`:

- `id: bigint`: submit batch ID.
- `statuses: OrderStatus[]`: per-item results in one-to-one correspondence with the request.
- `submit: SubmitResult`: node acceptance result.
- `successful(): boolean`: true only if every item has `outcome.kind === 'executed' && outcome.ok`.

Each `OrderStatus` contains `prepared`, `submitStatus`, and `outcome`, and may include `error` on failure. `submitStatus` is `accepted`, `malformed`, `bad_signature`, or `unavailable`.

| `outcome.kind` | Meaning |
| --- | --- |
| `executed` | Executed; still check `ok` / `reject`, and do not treat it as filled |
| `pending` | Not waited for, or still unconfirmed within the wait period |
| `not_submitted` | The node explicitly did not accept this item |
| `nonce_used` | The nonce has been used, but no execution details are available |

| Error class | Evidence and handling |
| --- | --- |
| `ActionAllowanceError` | Contains `used`, `limit`, `required`; stops before signing |
| `ChainIdentityError` | Genesis hash of the target chain or of a prepared transaction does not match |
| `ExchangeSubmissionUnknownError` | Contains the original `prepared[]`; the submit response was lost or cannot be trusted, so reconcile first |
| `ExchangeTrackingError` | Contains acceptance evidence in `response`; subsequent queries failed or were cancelled, so keep checking the original transactions |
| `ConnectError` | Request or RPC-layer error; inspect `code` |
| `TypeError` / `RangeError` | Parameter, precision, signature, or consistency validation failed |

Business-level execution rejections are kept in the per-item results and are not always thrown as exceptions. See [USAGE](USAGE.md) for recovery examples.

## Display helpers and extended queries

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

Use `subticksToPrice` for order book and open-order prices; `priceUnitsToPrice` for fill, mark / oracle, and candle prices; `quantumsToSize` for sizes; and `microUsdToUsd` for micro-USD amounts. Do not apply the same conversion to every price.

`info.rpc` exposes the generated unary query services, and `info.client` keeps the legacy `ApolloClient` entry point; for example, `info.rpc.market.getOrderBook(...)`.

## Fill fee summary

`info.userFees({ account, market?, fromHeight?, after?, limit? }, options?)` queries one page of fills and returns `{ summary, index, next }`. `account` is the numeric ID; other parameters follow the fills query.

`summarizeFees(account, fills)` is a pure function that makes no requests, suitable for summarizing fill records you already have; deduplicate pages before passing records in.

| `summary` field | Type | Description |
| --- | --- | --- |
| `account` | `number` | Target account |
| `makerFees` / `takerFees` | `bigint` | Signed fees for each role; negative values are rebates |
| `feesPaid` | `bigint` | Sum of positive fees paid |
| `rebates` | `bigint` | Sum of absolute values of negative fees |
| `netFees` | `bigint` | Fees paid minus rebates; may be negative |
| `fillCount` | `number` | Number of fill records involving this account; a record where both sides are this account counts once |
| `makerFillCount` / `takerFillCount` | `number` | Number of records per role; self-trades count toward both sides |
| `byMarket` | `MarketFeeSummary[]` | Sorted by market ID; each item contains market plus the fee and count fields above |

Totals are based on the makerFee / takerFee in fill records, and all amounts are in micro-USD. `userFees()` returns the summary for this page; when next is present, keep paging and add up the pages to get the total for the queried history. Use index.firstHeight / indexedHeight to confirm the height range the query covers. See [history and fees](reference/HISTORY.md#account-fees-and-fill-rebates-userfees) for a full pagination example.
