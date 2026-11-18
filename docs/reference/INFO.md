# Market and Account Queries

English | [简体中文](../zh-CN/reference/INFO.md)

`Info` provides read-only queries and requires no wallet signature. The examples below use an initialized `info`; every method accepts `{ signal }` as its last argument to cancel the request.

```ts
import { Info } from '@svpchain/trading-sdk';

const info = new Info({ baseUrl });
```

64-bit integers in return values are `bigint`, and bytes are `Uint8Array`. The "Returned fields" in this page list fields commonly used by applications; the full types are provided by the SDK's TypeScript declarations.

## Market list: meta / market

**Purpose**: find tradable markets and read market status and trading precision.

```text
info.meta(options?)
info.market(coin, options?)
```

`coin` is the full market ticker, such as `BTC-USD`. `meta()` returns the list, and `market()` returns a single market object.

```ts
const meta = await info.meta();
const market = await info.market('BTC-USD');
console.log(market.id, market.ticker, market.status);
console.log(market.stepBaseQuantums, market.subticksPerTick);
console.log(meta.feeTiers, meta.funding);
```

| Returns | Meaning |
| --- | --- |
| `meta.markets` | Market list, including status, precision, mark, etc. |
| `meta.liquidityTiers` / `meta.feeTiers` | Public liquidity and fee tiers |
| `meta.funding` | Public funding configuration |
| `market.id` | Market ID used for order book, ticker, and other queries |

`market()` throws if the market does not exist. A created market is not necessarily active; confirm its status before trading. Fee tiers are also not a bill of the account's historical fees.

## Order book: l2Snapshot

**Purpose**: query aggregated price levels to display the order book or compute a reference price for orders.

```text
info.l2Snapshot(market, depth = 20, options?)
```

| Parameter | Type | Description |
| --- | --- | --- |
| `market` | `number` | Market ID; 0 is a valid value |
| `depth` | `number` | Levels per side; SDK default 20, node maximum 1,000; an explicit 0 uses the node default of 50 |

```ts
import { marketUnits, subticksToPrice, quantumsToSize } from '@svpchain/trading-sdk';

const market = await info.market('BTC-USD');
const units = marketUnits(market);
const book = await info.l2Snapshot(market.id, 20);
const bids = book.bids.map(level => ({
  price: subticksToPrice(level.price, units),
  size: quantumsToSize(level.size, units),
}));
console.log(bids);
```

Returns `market`, `bids`, `asks`, and `at`. Each level is `{ price: bigint, size: bigint }`; bids are sorted from high to low price, asks from low to high. Prices and sizes are in on-chain integer units, and the example converts them to human-readable strings.

This is a snapshot from a single HTTP query. An empty order book is a valid result; for continuous display, the application can poll for updates as needed.

## Ticker: ticker

**Purpose**: query mark price, best bid/ask, last price, trade statistics, and funding index.

```ts
const market = await info.market('BTC-USD');
const ticker = await info.ticker(market.id);
console.log(ticker.mark, ticker.bestBid, ticker.bestAsk, ticker.fundingIndex);
```

Returns `mark`, optional `bestBid` / `bestAsk` / `lastPrice`, `volume24h`, `high24h` / `low24h`, `trades24h`, `openInterest`, `fundingIndex`, etc.

Some price fields may be absent. The last trade and 24-hour statistics depend on how long the node has actually been running and what it has observed; the presence of a field does not mean the node holds a full 24 hours of history. fundingIndex is the market's cumulative funding index. See [API](../API.md#display-helpers-and-extended-queries) for price unit conversion.

## Account state: userState / userStateById

**Purpose**: query account assets, risk, and positions by owner address or numeric ID.

```text
info.userState(owner, options?)
info.userStateById(account, options?)
```

`owner` is a 20-byte `Uint8Array` or a `0x` address string; `account` is the numeric ID of a non-vault account.

```ts
import { microUsdToUsd } from '@svpchain/trading-sdk';

const state = await info.userState(ownerAddress);
const account = Number(state.account);
console.log({
  account,
  collateral: microUsdToUsd(state.collateral),
  equity: microUsdToUsd(state.equity),
  marginHeadroom: microUsdToUsd(state.marginHeadroom),
  belowMaintenance: state.belowMaintenance,
});
```

| Returned field | Meaning |
| --- | --- |
| `account` / `owner` | On-chain account ID / owner address |
| `collateral` / `equity` | Collateral / account equity, in micro-USD |
| `marginHeadroom` | Equity in excess of the current initial margin requirement, in micro-USD |
| `belowMaintenance` | Whether the account is below the maintenance margin requirement |
| `positions` / `settings` | Positions and per-market settings |
| `actionsUsed` / `lastNonce` / `openOrders` | Used action allowance, highest used nonce, open order count |

If the account does not exist, an RPC error is returned according to node rules. `marginHeadroom` is not a "balance you can withdraw unconditionally", nor does it guarantee that the next order will pass risk checks.

## Positions: positions

**Purpose**: read positions on their own to display long/short and isolated margin info.

```ts
const result = await info.positions(account);
for (const position of result.positions) {
  console.log(position.market, position.side, position.size, position.isolatedMargin);
}
```

Returns `positions` and the read height `at`. Each position includes market, side, signed size, cost, open-order exposure, funding index, and isolated margin. Size uses the market's base-asset precision; cost and margin fields use their own declared amount units.

## Open orders: openOrders

**Purpose**: query orders still resting on the order book, for display, cancellation, and reconciliation.

```text
info.openOrders(account, market?, options?)
```

```ts
const market = await info.market('BTC-USD');
const result = await info.openOrders(account, market.id);
for (const order of result.orders) {
  console.log(order.orderId, order.market, order.remaining, order.expiry);
}
```

Returns `orders`, each with `orderId`, `market`, `side`, `price`, `remaining`, `expiry`, and `position`. `remaining` is the remaining base-asset size in integer units, and `expiry` is the expiry height, where 0 means not set.

Omitting market means all markets; an explicit 0 queries only market 0. The list excludes fully filled or cancelled orders; "not among open orders" alone does not prove an order was filled, so verify it with [fill and action history](HISTORY.md).

## Authorization, nonce, and allowance

| Method | Use case | Returned fields |
| --- | --- | --- |
| `agents(account)` | Confirm current agent authorizations | `agents`, each with slot, key, seq, expiry |
| `nonce(account)` | Coordinate signing and recover transactions | `lastNonce`, `window` |
| `userRateLimit(account)` | Query cumulative action allowance | `used`, `limit`, `remaining` |
| `chainInfo()` | Confirm the target chain and current height | `chainId`, `genesisHash`, `executedHeight`, etc. |

```ts
const agents = await info.agents(account);
const allowance = await info.userRateLimit(account);
console.log(agents.agents, allowance.remaining);
```

Agent expiry is measured in block height, and an expiry of 0 means no expiry height. The cumulative action allowance is shared by the owner and agents, and is counted separately from HTTP request rate and wallet SVP balance.

See [result handling](RESULTS.md) for action execution and transaction hash queries. See [historical data](HISTORY.md) for history and pagination.
