# Integration Guide

English | [简体中文](zh-CN/USAGE.md)

## 1. Choose query and trading clients

`Info` requires no private key and can query directly; `Exchange` is bound to one account and one signer and handles trading for that account.

```ts
import { Info, Exchange } from '@svpchain/trading-sdk';

const info = new Info({ baseUrl });
const chain = await info.chainInfo();
const state = await info.userState(ownerAddress);
const account = Number(state.account);
const markets = await info.meta();
console.log(chain.chainId, chain.genesisHash, markets.markets);

const exchange = new Exchange({
  baseUrl, account, expectedGenesisHash,
  signer: { type: 'agent', seed: agentSeed, slot: 1 },
});
```

Before trading, confirm that the account exists, has enough collateral, the market is ACTIVE, and the agent is approved. Provide `expectedGenesisHash` from independent, trusted environment configuration so you never connect to another chain or a pre-redeployment environment.

## 2. Pass prices and sizes as strings

```ts
const prepared = await exchange.prepareOrder({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  orderType: { limit: { tif: 'Gtc' } },
});
```

The high-level API accepts neither JS numbers nor scientific notation. After querying market precision, make sure the price matches tick and the size matches step; mismatches throw before broadcasting and are never silently rounded up to the minimum size. After rounding user input with your own rules, have the user or strategy confirm the final price and size again.

`prepareOrder()` only queries and signs; it does not broadcast. Prepared data contains no private key, but it does contain a signed, submittable transaction, so store it as your application requires.

## 3. Check every trading result

```ts
const response = await exchange.submitPrepared([prepared]);
for (const item of response.statuses) {
  switch (item.outcome.kind) {
    case 'executed':
      if (item.outcome.ok) {
        console.log('Action executed; next, query open orders and fills');
      } else {
        console.log('Execution rejected:', item.outcome.reject);
      }
      break;
    case 'pending':
      console.log('Keep querying the original nonce:', item.prepared.nonce);
      break;
    case 'nonce_used':
      console.log('Query archive transactions and action history to verify the final result');
      break;
    case 'not_submitted':
      console.log('Not accepted:', item.submitStatus, item.error);
      break;
  }
}
```

Distinguish three things: node acceptance, action execution, and order fills. A successfully executed limit order may only be resting on the order book; an IOC may not fill, and a TWAP may only have created its plan. `response.successful()` only checks whether all actions executed successfully.

Batch results are returned in input order; when some items are rejected, others may still execute. Reconcile item by item first, then decide whether to take further action on items that clearly failed.

## 4. Uncertain submits and failed queries

```ts
import {
  ExchangeSubmissionUnknownError, ExchangeTrackingError,
  ActionAllowanceError,
} from '@svpchain/trading-sdk';

try {
  const response = await exchange.order({
    coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
  });
  console.log(response.statuses);
} catch (error) {
  if (error instanceof ExchangeSubmissionUnknownError) {
    // The request may already have reached the node. Query using the original transactions; do not re-place with a new nonce.
    const statuses = await exchange.info.actionStatus(
      error.prepared.map(p => ({ account: p.account, nonce: p.nonce })),
    );
    console.log(statuses);
  } else if (error instanceof ExchangeTrackingError) {
    // error.response keeps the acceptance evidence and any partially confirmed results.
    console.log(error.response.statuses);
  } else if (error instanceof ActionAllowanceError) {
    console.log('Insufficient account action allowance:', error.used, error.limit, error.required);
  } else {
    throw error;
  }
}
```

Recovery queries accept at most 10,000 keys per call; split larger batches into groups. `NOT_FOUND` only means nothing was found right now; it does not prove the original transaction was never accepted, since execution delay, result-cache range, or index lag may be involved. Likewise, `nonce_used` must not be treated as success; check archive transactions and action history.

The SDK never resends Submit automatically. Nor does it create another transaction with a new nonce after a lost response. Prepared signatures are available to your recovery flow, and account, current signing authorization, and chain identity are still checked before submit.

## 5. Timeouts and cancellation

```ts
const controller = new AbortController();
const response = await exchange.order(
  { coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001' },
  {
    signal: controller.signal,
    timeoutMs: 30000,
    intervalMs: 500,
  },
);
```

A single RPC times out after 10 seconds by default, and the execution wait after acceptance defaults to 15 seconds. An explicit `timeoutMs` also applies to the submit request; the execution wait then gets a separate total deadline of the same length. Internal polling groups share the execution wait deadline.

When the execution wait expires normally, items still `pending` are returned and confirmed items are kept; if a query after acceptance fails or the caller cancels, `ExchangeTrackingError` is thrown. Cancelling the local wait does not withdraw the on-chain transaction.

To skip waiting for execution, pass `{ waitForExecution: false }`; `accepted` items then have a `pending` outcome, and your application needs to confirm them with later queries.

## 6. Sharing nonces across instances

```ts
import { NonceAllocator, Exchange } from '@svpchain/trading-sdk';

const shared = new NonceAllocator({ namespace: 'my-app' });
const options = { baseUrl, account, expectedGenesisHash, nonceManager: shared };
const first = new Exchange({ ...options, signer: { type: 'agent', seed: firstSeed, slot: 1 } });
const second = new Exchange({ ...options, signer: { type: 'agent', seed: secondSeed, slot: 2 } });
```

On the same network, the owner and all agents of an account share a single nonce space. A single instance reuses its allocator; multiple instances must share one explicitly. Do not switch to an uncoordinated set of nonces just because you switch agents.

The default allocator only coordinates within the current JS instance and provides no mutual exclusion across processes or browser tabs. Multi-process deployments should implement `next(account)` and `syncFromChain(account, lastNonce)` of `NonceManager` with external atomic coordination, and use different namespaces for different networks.

The chain's out-of-order nonce window is 16, so unique allocation alone cannot guarantee that unlimited concurrent out-of-order submissions are accepted. For flows such as approving before placing orders, or modifying an order and then depending on the new order, wait for the previous step to be confirmed before continuing. Limit concurrency per account, and prefer spreading throughput across different accounts.

## 7. Batch size and allowance

`bulkOrders()`, `bulkCancel()`, and `executeActions()` accept at most 20,000 items per call. Before submitting, they validate the whole batch and prepare all signatures, then send a single submit request; batches are not guaranteed to execute atomically.

Requests also have a byte limit. The SDK defaults to 8 MiB, and nodes and proxies may be stricter. Set `maxRequestBytes` for your actual environment and control batch size; do not treat 20,000 items as a recommended batch size. Pre-queries, signing, and execution waits for large batches also take time.

`userRateLimit(account)` returns the account's cumulative action allowance; this is distinct from HTTP per-second rate limits, gas, and wallet SVP balance. The owner and agents share the allowance, and neither deposits nor signing key rotation reset it. Cancel / CancelAll are exempt; a new Exchange checks the remaining allowance before preparing other actions. Concurrent submits may still exhaust it after the check, so handle final on-chain rejections.

## 8. Wallets and keys

Web apps should create the owner signer via a wallet callback and approve a dedicated agent; never put the owner private key in a frontend bundle. Agent seeds also carry trading authority and must not be written into source code, logs, or committed to a repository.

`createOwnerKeySigner()` is suited to controlled Node.js services. The SDK copies the key / seed you pass in, so later changes to the original array do not switch the signing identity. After an agent's key is rotated, revoked, or expires, re-confirm the authorization; prepared transactions may no longer be valid.

## 9. Minimal integration check

First, in a test environment with a dedicated account, complete approval, placing an order, querying open orders, cancelling, and checking fills and positions, before moving on to continuous trading. The repository's automated tests use a mock chain service and cannot replace verification against your target environment.

See [Info methods](API.md) for query methods.
