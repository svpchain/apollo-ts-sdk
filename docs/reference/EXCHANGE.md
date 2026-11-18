# Trading APIs

English | [简体中文](../zh-CN/reference/EXCHANGE.md)

`Exchange` is bound to one Apollo account and one signer, and handles preparing, signing, submitting, and querying action execution results. The examples below use an `exchange` with an approved agent; owner authorization operations use `owner`.

```ts
import { Exchange } from '@svpchain/trading-sdk';

const exchange = new Exchange({
  baseUrl, account, expectedGenesisHash,
  signer: { type: 'agent', seed, slot: 1 },
});
```

All trading methods return an `OrderResponse`. For each item you must distinguish node acceptance, action execution, and order fills; see [result handling](RESULTS.md). The second argument generally accepts `{ waitForExecution, timeoutMs, intervalMs, signal }`; see [API](../API.md) for the exact position.

## Limit orders: order

**Purpose**: place an order at a given price and size, choosing a resting order, immediate-or-cancel, or post-only.

```text
exchange.order(request, options?)
```

| Parameter | Type | Description |
| --- | --- | --- |
| `coin` | `string` | Full market ticker |
| `isBuy` | `boolean` | true to buy, false to sell |
| `price` | `string` | Limit price, matching tick |
| `size` | `string` | Base-asset size, matching step |
| `orderType.limit.tif` | `Gtc` / `Ioc` / `PostOnly` | Default Gtc |
| `position` | `Long` / `Short` | Long/short slot; buys default to Long, sells to Short |
| `reduceOnly` | `boolean` | Whether reduce-only, default false |
| `isolated` | `boolean` | Whether isolated margin, default false |

```ts
const response = await exchange.order({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  orderType: { limit: { tif: 'Gtc' } },
});
const status = response.statuses[0];
console.log(status.submitStatus, status.outcome);
```

**Returns**: one result containing the original transaction identifiers, acceptance status, and execution status. On successful execution the order may still be resting on the order book; query it afterwards with `openOrders()` and `userFills()`.

**Limits**: the market must be active; pass price and size as decimal strings, and deviations from tick / step throw before broadcasting. See [API](../API.md#place-orders-order--bulkorders) for the full parameters, including optional builder and expiry height.

## Bulk orders: bulkOrders

**Purpose**: submit multiple independent orders at once.

```ts
const response = await exchange.bulkOrders([
  { coin: 'BTC-USD', isBuy: true, price: '64000', size: '0.001' },
  { coin: 'BTC-USD', isBuy: false, price: '66000', size: '0.001', position: 'Short' },
]);
for (const status of response.statuses) console.log(status.submitStatus, status.outcome);
```

The parameter is `CreateOrderRequest[]`, and the returned `statuses` follow the input order. 1–20,000 items, also subject to the request byte limit; batches are not automatically split into multiple submits.

The prepare step validates the fields of the whole batch, then signs and submits. On-chain results may still be partially successful, and batches are not guaranteed to execute atomically. Do not re-place the whole batch after a partial failure.

## Market open and close: marketOpen / marketClose

**Purpose**: try to fill immediately at the current market price while limiting acceptable slippage.

```ts
const opened = await exchange.marketOpen({
  coin: 'BTC-USD', isBuy: true, size: '0.001', slippage: '0.01',
});
const closed = await exchange.marketClose({
  coin: 'BTC-USD', position: 'Long', size: '0.001', slippage: '0.01',
});
console.log(opened.statuses, closed.statuses);
```

| Parameter | Description |
| --- | --- |
| `coin`, `size` | Market and base-asset size, required |
| `isBuy` | Required for the open method; the close method determines the side automatically |
| `position` | Long / Short, required for close; optional for open |
| `slippage` | Ratio string, default `'0.01'`; 0 is allowed, must be less than 1 |
| `referencePrice` | Optional reference price string; if omitted, the best opposite-side price is used, falling back to mark for an empty order book |
| `isolated` | Optional isolated margin flag |

**Returns**: action execution results. Successful execution does not guarantee the full size was filled; query actual filled size and remaining position.

**Limits**: market intents are implemented as IOC orders with a protective limit price. Closing forces reduce-only and requires the caller to provide a size; the SDK does not guess the long/short position or read the full position size. Orders may still be rejected if the reference price is insufficient or risk checks are not met.

## Take profit and stop loss: orderType.trigger

**Purpose**: submit a limit or market intent once the price reaches a trigger condition.

```ts
const stop = await exchange.order({
  coin: 'BTC-USD', isBuy: false, size: '0.001',
  position: 'Long', reduceOnly: true,
  orderType: {
    trigger: { triggerPrice: '60000', isMarket: true, tpsl: 'sl' },
  },
  slippage: '0.01',
});
console.log(stop.statuses);
```

| Parameter | Description |
| --- | --- |
| `triggerPrice` | Trigger price string; must match tick |
| `tpsl` | `tp` take profit, `sl` stop loss |
| `isMarket` | true for a trigger market intent, false for a trigger limit |
| `price` | Required for trigger limit; the order price after triggering |
| `position`, `reduceOnly` | Specify explicitly for take profit / stop loss that closes a position |

**Returns**: the result of the trigger order action. Successful creation does not mean the order has triggered or filled, nor does it guarantee that take profit / stop loss fills completely during sharp market moves. Each trigger order returns its own transaction identifiers and execution result.

## Cancel orders: cancel / bulkCancel / cancelAll

**Purpose**: cancel one order, multiple orders, all open orders in a market, or all open orders of the account.

```ts
const one = await exchange.cancel({ coin: 'BTC-USD', orderId });
const multiple = await exchange.bulkCancel([
  { coin: 'BTC-USD', orderId: firstOrderId },
  { coin: 'BTC-USD', orderId: secondOrderId },
]);
const marketOrders = await exchange.cancelAll('BTC-USD');
// All markets: await exchange.cancelAll('');
console.log(one.statuses, multiple.statuses, marketOrders.statuses);
```

`orderId` is a `bigint`. `bulkCancel()` accepts 1–20,000 `{ coin, orderId }` items and is subject to the request size limit. `cancelAll()` defaults to an empty string, meaning all markets.

**Returns**: the execution result of each cancel action. Cancels can race with fills; after cancelling, still verify fills and open orders. Cancel / CancelAll are exempt from the cumulative action allowance, but parameters, authorization, and nonce must still be valid.

## Modify orders: modifyOrder

**Purpose**: replace the price and size of an existing order.

```ts
const response = await exchange.modifyOrder({
  coin: 'BTC-USD', orderId, price: '65100', size: '0.002',
});
console.log(response.statuses);
```

The request requires `coin`, `orderId: bigint`, `price: string`, and `size: string`. price / size must still match market precision.

**Returns**: the execution result of the modify action. The new order has a new identifier; confirm it from the result and an open-orders query, and do not keep using the old ID.

**Limits**: the old order is cancelled before the new one is created; if creating the new order fails, the old order may already be cancelled.

For bulk modification use `bulkModify(requests, options?)`, which takes an array of the above requests, up to 20,000 items, subject to the request byte limit:

```ts
const response = await exchange.bulkModify([
  { coin: 'BTC-USD', orderId: firstOrderId, price: '65100', size: '0.001' },
  { coin: 'BTC-USD', orderId: secondOrderId, price: '65200', size: '0.002' },
]);
for (const status of response.statuses) console.log(status.outcome);
```

Before signing, the SDK validates the fields of the whole batch and checks the total action allowance, then submits once. Results are returned per item in request order and may be partially successful; do not resend the whole batch after a failure.

## Leverage and isolated margin

**Purpose**: set market leverage, or add or remove isolated margin for one side.

```ts
const leverage = await exchange.updateLeverage('BTC-USD', '5');
const margin = await exchange.updateIsolatedMargin('BTC-USD', 'Long', '10.50');
console.log(leverage.statuses, margin.statuses);
```

| Method | Parameters |
| --- | --- |
| `updateLeverage(coin, leverage, options?)` | Full ticker, leverage as a decimal string |
| `updateIsolatedMargin(coin, position, amount, options?)` | Ticker, Long / Short, USD amount string |

A positive margin amount adds and a negative amount removes, with up to 6 decimal places. Leverage input ranges from 1–1,000,000; the actual usable value is determined by market and account risk controls.

**Returns**: the execution result of the settings action; after success, re-read settings and margin from the account state. Removing margin or raising leverage may be rejected by risk controls.

## TWAP and scaled orders

**Purpose**: create a time-based trading plan, or distribute size across a price range.

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
console.log(twap.statuses, scaled.statuses);
```

TWAP `durationS` / `intervalS` are in seconds, and `tolerancePpm` defaults to 10,000, meaning 1%. For scaled orders, `size` is the total size and `numOrders` is the number of child orders; see [API](../API.md#twap-and-scaled-orders) for the remaining distribution options.

**Returns**: the result of the create action. Creating a TWAP plan and filling all of its child orders are different stages; a successful scaled-order action likewise does not mean all child orders are filled.

Cancel a TWAP using the parent order ID:

```ts
const response = await exchange.cancelTwap({ coin: 'BTC-USD', orderId: twapParentId });
console.log(response.statuses);
```

The parent order ID is the nonce used when creating the TWAP, which you can save from `prepared.nonce` in the creation result. Cancellation reuses the existing cancel action, cancels the parent plan and its current child order, and is exempt from the cumulative action allowance. Child orders that already filled are not reversed.

## Owner approval and agent revocation

**Purpose**: let the owner allow a dedicated trading key to operate the account, and revoke it when needed.

```ts
const approval = await owner.approveAgent(1, publicKey, 0n);
if (!approval.successful()) throw new Error('Approval not confirmed');
const agents = await owner.info.agents(account);
console.log(agents.agents);
// Revoke: await owner.revokeAgent(1);
```

For `approveAgent(slot, publicKey, expiry = 0n, options?)`, slot is 1–4, publicKey is 32 bytes, and expiry is the expiry height, where 0 means no expiry height. `revokeAgent(slot, options?)` revokes the given slot.

**Returns**: the execution result of the authorization action. Use the new agent only after execution is confirmed successful. Agents cannot manage authorizations; key rotation or revocation may invalidate previously prepared signatures. See [README](../../README.md#owner-wallet-and-agent-approval) for owner wallet and local key integration.

## Prepare first, submit later

**Purpose**: check and sign first, then broadcast when your application flow decides to submit.

```ts
const prepared = await exchange.prepareOrder({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
});
console.log(prepared.transactionHash, prepared.nonce);
const response = await exchange.submitPrepared([prepared]);
console.log(response.statuses);
```

Preparing does not broadcast; submitting re-checks the target chain, account, and current authorization. Store signed data as you would a submittable transaction. If a submit times out or the response is lost, first query the original account / nonce; see [result handling](RESULTS.md).
