# Trading Results and Errors

English | [简体中文](../zh-CN/reference/RESULTS.md)

Trading integrations need to confirm node acceptance, action execution, and order fills separately. The SDK's return values preserve the boundaries between these three stages, so applications can update their UI, handle rejections, and recover transactions accordingly.

## What trading methods return

Methods such as `order()`, `cancel()`, and `modifyOrder()` all return an `OrderResponse`. Single operations also use a `statuses` array, so the same handling logic works for batches.

| Returned field | Type | Meaning |
| --- | --- | --- |
| `id` | `bigint` | ID of this submit batch |
| `statuses` | `OrderStatus[]` | Per-item results in input order |
| `submit` | `SubmitResult` | Node acceptance result |
| `successful()` | Method returning boolean | true only when every item has executed and executed successfully |

Each `OrderStatus` contains:

| Field | Meaning |
| --- | --- |
| `prepared.account` / `prepared.nonce` | Reconciliation key of the original action |
| `prepared.transactionHash` | Original transaction hash |
| `submitStatus` | Node acceptance or explicit rejection status |
| `outcome` | Action execution status |
| `error` | When present, the reason for acceptance or execution failure |

The following example maps the return value to a summary that is easy for applications to store; after converting `bigint` to string, it can be JSON-serialized:

```ts
const response = await exchange.order({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
});
const summary = response.statuses.map(item => ({
  account: item.prepared.account,
  nonce: item.prepared.nonce.toString(),
  transactionHash: item.prepared.transactionHash,
  submitStatus: item.submitStatus,
  execution: item.outcome.kind,
  ok: item.outcome.kind === 'executed' ? item.outcome.ok : null,
  error: item.error ?? null,
}));
console.log(summary);
```

`ok: true` in the summary only means the action succeeded, not that the order was filled.

## Node acceptance status

| `submitStatus` | Meaning | Handling |
| --- | --- | --- |
| `accepted` | The node accepted this item | Continue to confirm the execution result |
| `malformed` | The node explicitly rejected it; the data does not meet requirements | Check parameters and version |
| `bad_signature` | The node explicitly rejected the signature or authorization check | Refresh account, agent, and nonce state |
| `unavailable` | The node explicitly did not accept this item | Check service status and decide the next step for your application |

A batch may mix accepted and rejected items. `submit.ok` only means every item was accepted; final execution must still be checked per item.

## Action execution status

| `outcome.kind` | Other fields | Meaning |
| --- | --- | --- |
| `executed` | `ok: true`, height, optional orderId, fills | Action executed successfully |
| `executed` | `ok: false`, reject | Action execution was rejected |
| `pending` | — | No final execution details were obtained this time |
| `nonce_used` | — | The nonce has been used, but no execution details are available |
| `not_submitted` | — | The node explicitly did not accept this item |

`fills` is the number of fill entries produced directly by the action, not per-fill details, and it alone cannot determine whether the full order size was filled. Use `userFills()` for complete fills and `openOrders()` for remaining open orders.

Common cases: a limit action succeeds but the order is still open; an IOC action succeeds but fills partially or not at all; a TWAP action succeeds but the plan is still executing. Applications should update their state based on actual fills and positions.

## Query the original action: actionStatus

**Purpose**: keep waiting for confirmation after placing an order, or reconcile when the submit result is uncertain.

```ts
const item = response.statuses[0];
const status = await info.actionStatus([
  { account: item.prepared.account, nonce: item.prepared.nonce },
]);
console.log(status.statuses);
```

Each call accepts 1–10,000 `{ account: number, nonce: bigint }` items and returns the raw execution status for each key. The enum type is `tx.ActionState` from `@svpchain/trading-sdk/protocol`.

`NOT_FOUND` means the current query has no execution details; it does not prove the transaction was never accepted. `NONCE_USED` is not a synonym for successful execution either. Keep checking with the [history index range](HISTORY.md#index-status-indexstatus) and the original transaction.

## Query a transaction: transaction

**Purpose**: check the node's record by transaction hash.

```ts
const transaction = await info.transaction(response.statuses[0].prepared.transactionHash);
console.log(transaction);
```

The parameter is a 32-byte `Uint8Array` or a `0x` string. The SDK verifies the returned hash; whether the target node can find the record depends on its retention range and execution and indexing progress. If the transaction is not found, keep the original account / nonce for further checks, and do not automatically create another order.

## Waiting and timeouts

By default the SDK waits up to 15 seconds for execution, querying every 250 ms. Pass `{ waitForExecution: false }` to wait only for the submit response; accepted items then remain pending.

```ts
const response = await exchange.order(
  { coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001' },
  { waitForExecution: false },
);
console.log(response.statuses);
```

When the execution wait expires normally, items still pending are returned and confirmed items are kept. Cancelling the local wait does not withdraw transactions that were already accepted. See the [integration guide](../USAGE.md#5-timeouts-and-cancellation) for timeout options and cancellation.

## Errors and recovery

| Error | What the SDK keeps | Next step |
| --- | --- | --- |
| `ExchangeSubmissionUnknownError` | Original `prepared[]` | The submit response was lost or cannot be trusted; query the original account / nonce and transaction hash |
| `ExchangeTrackingError` | `response`, with acceptance evidence and partial results | Keep confirmed results and continue querying unconfirmed items |
| `ActionAllowanceError` | used, limit, required | Insufficient allowance; stop repeated submits |
| `ChainIdentityError` | Error reason | Check the network and the target genesis hash |
| `ConnectError` | RPC code and message | Handle based on the stage where it occurred; uncertain results during submit are wrapped in a dedicated error |
| `TypeError` / `RangeError` | Validation reason | Check precision, parameters, signature, or data consistency |

```ts
import { ExchangeSubmissionUnknownError, ExchangeTrackingError } from '@svpchain/trading-sdk';

try {
  const response = await exchange.order({
    coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  });
  console.log(response.statuses);
} catch (error) {
  if (error instanceof ExchangeSubmissionUnknownError) {
    // Split large batches into groups; each actionStatus call accepts at most 10,000 items.
    for (let i = 0; i < error.prepared.length; i += 10000) {
      const keys = error.prepared.slice(i, i + 10000)
        .map(p => ({ account: p.account, nonce: p.nonce }));
      console.log(await exchange.info.actionStatus(keys));
    }
  } else if (error instanceof ExchangeTrackingError) {
    console.log(error.response.statuses);
  } else {
    throw error;
  }
}
```

The SDK never resends Submit automatically, nor does it place the order again with a new nonce. A recovery flow should first verify the original request; when a batch partially succeeds, act only on items that clearly need follow-up, to avoid duplicate trades.
