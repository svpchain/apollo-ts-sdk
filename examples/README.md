# Command-Line Examples

English | [简体中文](README.zh-CN.md)

The examples call the SDK directly. First install dependencies and build in the SDK repository:

```bash
npm ci
npm run build
npm run examples:build
```

Use Node.js 22 or later. Environment variables are provided by the caller via the shell or a local config file; the scripts never load or print keys automatically.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `APOLLO_RPC_URL` | Apollo HTTP(S) JSON-RPC endpoint |
| `APOLLO_ACCOUNT` | Non-zero numeric account ID, used for account queries and trading |
| `APOLLO_GENESIS_HASH` | Trusted genesis hash; required for signed transactions, and can also be set for queries to verify the target chain |
| `APOLLO_AGENT_SEED` | Hex-encoded 32-byte agent seed, already approved by the account owner |
| `APOLLO_AGENT_SLOT` | Agent slot for the cancel / modify tools, default 1; the basic order.js example always uses slot 1 |
| `APOLLO_COIN` | Full market ticker; when omitted, open-order queries cover all markets |
| `APOLLO_PRICE` / `APOLLO_SIZE` | Price and base-asset size as decimal strings |
| `APOLLO_ORDER_ID` | Target order ID as a decimal digit string, without a trailing n |

Prices and sizes must match the target market's tick / step. Keep config files that contain keys local only; the repository ignores `.env.*` files.

## Query the chain and markets

```bash
node .examples-dist/query.js
```

Requires only APOLLO_RPC_URL. Returns the chain identity and the market list.

## Place an order

```bash
# Prepare and sign, without broadcasting
node .examples-dist/order.js

# Actually submit a Gtc limit buy order
node .examples-dist/order.js --submit
```

Set the RPC endpoint, account, trusted genesis hash, agent seed, market, price, and size. The example always uses slot 1. Each run prepares a new transaction and allocates a new nonce; save the order ID and transaction hash printed by the run that actually submitted.

## Query open orders

```bash
npm run example:orders
npm run example:orders -- --coin BTC-USD
npm run example:orders -- --order-id "$APOLLO_ORDER_ID"
```

Requires the RPC endpoint and account ID, but no agent seed. You can filter by full ticker and order ID; command-line arguments take precedence over the matching environment settings. Results show the order ID, market, side, price, remaining size, and position slot.

If an order is not found among open orders, determine its final status from action execution and fill records.

## Cancel a specific order

```bash
# Only prepare the cancellation signature
npm run example:cancel -- --order-id "$APOLLO_ORDER_ID"

# Actually send the cancellation
npm run example:cancel -- --order-id "$APOLLO_ORDER_ID" --submit
```

The market comes from APOLLO_COIN, or you can pass --coin. The script only acts on the specified account, market, and order ID, and does not broadcast by default. A valid agent and genesis hash are required.

After successful execution it queries open orders again and prints `Still open after cancellation: false`. The separate nonce in the output belongs to the cancel action; the target order ID stays the same.

## Modify a specific order

```bash
# Prepare the modified price and size
npm run example:modify -- --order-id "$APOLLO_ORDER_ID" --price 65100 --size 0.001

# Actually submit the modification
npm run example:modify -- --order-id "$APOLLO_ORDER_ID" --price 65100 --size 0.001 --submit
```

Price / Size can also come from environment variables; the command line takes precedence. Modifying cancels the old order and then creates a new one; after a successful replacement, use the new order ID. Even if the replacement fails, the old order may already be cancelled.

## Results and errors

Acceptance, execution, and fills are checked separately. accepted means the node accepted the item; executed with ok=true means the action executed successfully, and actual fills still need to be queried.

If success is not confirmed, the cancel / modify scripts exit with a non-zero status and keep the reconciliation identifiers. If the submit result is uncertain or a query is interrupted, first check the original account / nonce instead of resending directly. The scripts never retry submits automatically.

## Help and verification

```bash
npm run example:orders -- --help
npm run example:cancel -- --help
npm run example:modify -- --help

# Verify against a local mock node, without using a real account or sending on-chain transactions
npm run test:examples
```
