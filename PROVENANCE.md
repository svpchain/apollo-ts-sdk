# Versions and Runtime

English | [简体中文](PROVENANCE.zh-CN.md)

## Versions

Package name: `@svpchain/trading-sdk`. It follows semantic versioning; see the [changelog](CHANGELOG.md) for changes in each version.

The SDK is ESM and ships TypeScript type declarations. See [quick start](README.md#installation) for installation.

## Runtime

- Node.js 22 or later.
- Modern browsers that support `fetch`, `AbortController`, `BigInt`, and `structuredClone`.
- TypeScript projects must use an ESM-compatible module configuration.

## Clients

- `Info`: markets, order book, accounts, positions, open orders, fills, fees, and historical queries.
- `Exchange`: place order, cancel order, modify order, leverage, isolated margin, TWAP, scaled orders, and agent approval.

## Configuration

Set `baseUrl` to the Apollo HTTP(S) JSON-RPC endpoint of the target environment. The trading client is configured with an account ID, a signer, and the target genesis hash. For historical queries, connect to a node that provides an archive index, and check the indexed height with `indexStatus()`.

See the [feature overview](docs/FEATURES.md) for the API catalog and [API](docs/API.md) for parameter and result types.
