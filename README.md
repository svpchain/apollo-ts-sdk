# Apollo TypeScript SDK

English | [简体中文](README_zh-CN.md)

`@svpchain/trading-sdk` is Apollo's HTTP JSON-RPC trading SDK for web apps, Node.js services, and trading bots.

The API is organized into `Info` and `Exchange`: `Info` queries markets and accounts, while `Exchange` handles signing, order placement, and account operations. Prices and sizes are decimal strings, and trading results are returned per item.

| Client | Common methods |
| --- | --- |
| `Info` | `meta`, `l2Snapshot`, `userState`, `openOrders`, `userFills`, `userFees` |
| `Exchange` | `order`, `bulkOrders`, `bulkModify`, `cancelTwap`, `marketOpen`, `marketClose` |

See the [feature overview](docs/FEATURES.md) for the supported trading and query APIs. Each group of APIs is documented by purpose, parameters, examples, and return values.

## Installation

```bash
npm install @svpchain/trading-sdk
```

This installs the latest stable release and records the exact version in your project's `package.json` and lock file. To pin a version, specify it explicitly, e.g. `npm install @svpchain/trading-sdk@1.0.0`. See the [changelog](CHANGELOG.md) for changes in each version.

Requires Node.js 22+, or a modern browser that supports `fetch`, `AbortController`, and `BigInt`. The SDK is ESM, ships TypeScript type declarations, and does not depend on React.

## Query markets and accounts

```ts
import { Info } from '@svpchain/trading-sdk';

const info = new Info({ baseUrl: 'https://rpc.example.com' });
const { markets } = await info.meta();
const market = markets.find(m => m.ticker === 'BTC-USD');
if (!market) throw new Error('Market not found');

const book = await info.l2Snapshot(market.id, 20);
const account = await info.userState('0xYourOwnerAddress');
console.log(book.bids, book.asks, account.account);
```

`baseUrl` is the HTTP(S) JSON-RPC endpoint of an Apollo node. `coin` is the full `ticker` from the market list, such as `BTC-USD`; do not pass `BTC` alone. Trading uses the account's numeric on-chain ID, which you can look up from the owner address first.

Queries return typed on-chain data, with 64-bit integers as `bigint`. To display prices and sizes, use the SDK's conversion helpers; see [API](docs/API.md).

## Place orders with an approved agent

`seed`, `account`, and `expectedGenesisHash` below should all come from your environment. The agent public key must be approved by the account owner beforehand.

```ts
import { Exchange, hexToBytes32 } from '@svpchain/trading-sdk';

const exchange = new Exchange({
  baseUrl: 'https://rpc.example.com',
  expectedGenesisHash, // genesis hash of the target chain, 0x hex or 32 bytes
  account,            // numeric on-chain account ID
  signer: { type: 'agent', seed: hexToBytes32(agentSeedHex), slot: 1 },
});

const response = await exchange.order({
  coin: 'BTC-USD',
  isBuy: true,
  price: '65000',
  size: '0.001',
  orderType: { limit: { tif: 'Gtc' } },
});

for (const status of response.statuses) {
  console.log(status.prepared.transactionHash, status.submitStatus, status.outcome);
}
if (!response.successful()) {
  // Handle rejected, pending, or nonce-used results item by item.
  console.log(response.statuses);
}
```

By default the SDK waits up to 15 seconds for execution. `successful()` means every action executed successfully; **it does not mean the order was filled**. Query open orders and fills separately. Node acceptance and execution failures are also returned per item; see [handling results](docs/USAGE.md).

## Common trading operations

```ts
// Bulk orders: one submit request, results returned per item.
const batch = await exchange.bulkOrders([
  { coin: 'BTC-USD', isBuy: true, price: '64000', size: '0.001' },
  { coin: 'BTC-USD', isBuy: false, price: '66000', size: '0.001', position: 'Short' },
]);

// Market intents are converted to IOC orders with slippage protection; default slippage is 1%.
const opened = await exchange.marketOpen({
  coin: 'BTC-USD', isBuy: true, size: '0.001', slippage: '0.01',
});

const cancelled = await exchange.cancel({ coin: 'BTC-USD', orderId });
const allCancelled = await exchange.cancelAll('BTC-USD'); // '' means all markets
const modified = await exchange.modifyOrder({
  coin: 'BTC-USD', orderId, price: '65100', size: '0.001',
});
const closed = await exchange.marketClose({
  coin: 'BTC-USD', position: 'Long', size: '0.001', slippage: '0.01',
});
```

Each call executes the corresponding trade. The code above shows method signatures; in a real integration, choose the calls your application needs and check every result.

Apollo supports separate long and short position slots, so closing a position requires `Long` / `Short` and a size. Cross margin is the default; `isolated: true` selects isolated margin. Modifying an order cancels the old order and then creates a new one; if the new order fails, the old one may already be cancelled. Batch operations are not guaranteed to execute atomically.

## Bulk modify, TWAP cancellation, and fees

```ts
const modified = await exchange.bulkModify([
  { coin: 'BTC-USD', orderId: firstOrderId, price: '65100', size: '0.001' },
  { coin: 'BTC-USD', orderId: secondOrderId, price: '65200', size: '0.002' },
]);
const cancelled = await exchange.cancelTwap({ coin: 'BTC-USD', orderId: twapParentId });
const fees = await info.userFees({ account, limit: 100 });
console.log(modified.statuses, cancelled.statuses);
console.log(fees.summary.feesPaid, fees.summary.rebates, fees.summary.netFees, fees.next);
```

TWAP cancellation uses the parent order ID and cancels both the parent plan and its current child order. Fees are computed from the makerFee / takerFee of fill records, in integer micro-USD. `feesPaid` and `rebates` are positive, and `netFees` is fees paid minus rebates. `userFees()` summarizes the current page of fills and keeps `next` and the index range; a full total requires paging through all results. See [trading APIs](docs/reference/EXCHANGE.md) and [fees](docs/reference/HISTORY.md#account-fees-and-fill-rebates-userfees).

## Owner wallet and agent approval

```ts
import { Exchange, createWalletSigner, createAgentSigner } from '@svpchain/trading-sdk';

if (!wallet.account) throw new Error('Connect the owner wallet first');
const walletAccount = wallet.account;
const owner = new Exchange({
  baseUrl, account, expectedGenesisHash,
  signer: createWalletSigner(data =>
    wallet.signTypedData({ ...data, account: walletAccount })),
});

const { publicKey } = createAgentSigner(agentSeed, 1, 0);
const approval = await owner.approveAgent(1, publicKey, 0n);
if (!approval.successful()) throw new Error('Agent approval is not confirmed');
// 0n means no expiry height. Trade with this agent only after the approval is confirmed.
```

Node.js services can also use `createOwnerKeySigner(ownerPrivateKey)`. Both the wallet signing callback and a local owner key verify the on-chain owner identity during the prepare step. Agent approval slots are 1–4, and an agent cannot approve or revoke other agents.

## Prepare without broadcasting

```ts
const prepared = await exchange.prepareOrder({
  coin: 'BTC-USD', isBuy: true, price: '65000', size: '0.001',
});
console.log(prepared.transactionHash, prepared.nonce);

// After your application confirms, explicitly submit the prepared transaction.
const response = await exchange.submitPrepared([prepared]);
```

The SDK never resends transactions automatically. If a submit times out or the response is lost, query the result using the original account / nonce instead of creating a second order. If the agent is revoked, its key is rotated, or the chain changes between prepare and submit, the submit is rejected.

## Concurrency and limits

- An Exchange instance shares a single nonce allocator. When multiple instances operate on the same account, pass the same `nonceManager` explicitly; multiple processes require external atomic coordination.
- Batches are limited to 20,000 items and are also subject to request byte size and server limits; not every 20,000-item batch can be submitted successfully.
- Pass prices, sizes, and margin as strings; limit prices or sizes that do not match tick / step throw an error.

## Docs and examples

- [Feature overview](docs/FEATURES.md)
- [API parameters and return values](docs/API.md)
- [Market and account queries](docs/reference/INFO.md)
- [Trading APIs](docs/reference/EXCHANGE.md)
- [Historical data](docs/reference/HISTORY.md)
- [Trading results and errors](docs/reference/RESULTS.md)
- [Integration, result handling, and concurrency](docs/USAGE.md)
- [Versions and runtime](PROVENANCE.md)
- [Changelog](CHANGELOG.md)
- [Command-line examples](examples/README.md): query open orders, prepare orders, modify and cancel orders.
- `examples/query.ts`: read-only queries.
- `examples/order.ts`: prepares only by default; broadcasts only with explicit `--submit`.
- `examples/wallet.ts`: approve an agent from a wallet.
- `examples/open-orders.ts`: query and format open orders, optionally filtered by order ID.
- `examples/cancel.ts`: prepare or submit cancellation of a given order, then verify open orders after cancellation.
- `examples/modify-order.ts`: prepare or submit a price and size change for a given order.
- `examples/trading.ts`: integrated trading and cancellation functions.

```bash
npm run check
npm test
npm run build
npm run examples:build
npm run test:examples
npm run test:package
```
