import { Exchange, hexToBytes32 } from '@svpchain/trading-sdk';

// Only runs when this example is launched. Default: query and sign without broadcasting.
const baseUrl = process.env.APOLLO_RPC_URL;
const seed = process.env.APOLLO_AGENT_SEED;
const expectedGenesisHash = process.env.APOLLO_GENESIS_HASH as `0x${string}` | undefined;
const account = Number(process.env.APOLLO_ACCOUNT);
const coin = process.env.APOLLO_COIN;
const price = process.env.APOLLO_PRICE;
const size = process.env.APOLLO_SIZE;
if (!baseUrl || !seed || !expectedGenesisHash || !coin || !price || !size || !account) {
  throw new Error(
    'Set APOLLO_RPC_URL, APOLLO_AGENT_SEED, APOLLO_GENESIS_HASH, APOLLO_ACCOUNT, APOLLO_COIN, APOLLO_PRICE, APOLLO_SIZE',
  );
}
const exchange = new Exchange({
  baseUrl,
  expectedGenesisHash,
  account,
  signer: { type: 'agent', seed: hexToBytes32(seed), slot: 1 },
});
const prepared = await exchange.prepareOrder({
  coin,
  isBuy: true,
  price,
  size,
  orderType: { limit: { tif: 'Gtc' } },
});
console.log('prepared hash:', prepared.transactionHash, 'nonce:', prepared.nonce);
if (process.argv.includes('--submit')) {
  const response = await exchange.submitPrepared([prepared]);
  console.log(response.statuses);
} else console.log('Not broadcast. Add --submit only when you intend to place this order.');
