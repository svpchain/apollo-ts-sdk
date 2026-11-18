import { Info, marketUnits, priceUnitsToPrice } from '@svpchain/trading-sdk';

const baseUrl = process.env.APOLLO_RPC_URL;
if (!baseUrl) throw new Error('Set APOLLO_RPC_URL to your Apollo HTTP JSON-RPC endpoint');
const info = new Info({ baseUrl });
const chain = await info.chainInfo();
console.log('chain:', chain.chainId, 'genesis:', chain.genesisHash, 'height:', chain.executedHeight);
const { markets } = await info.meta();
for (const market of markets) {
  console.log(market.id, market.ticker, 'mark:', priceUnitsToPrice(market.mark, marketUnits(market)));
}
// Read only. No signing or submission.
