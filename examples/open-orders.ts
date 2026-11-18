import { parseArgs } from 'node:util';
import { Info, marketUnits, quantumsToSize, subticksToPrice } from '@svpchain/trading-sdk';
import { common } from '@svpchain/trading-sdk/protocol';
import { accountId, infoOptions, orderId, run } from './cli.js';

// Read only. An agent seed is not required.
await run(async () => {
  const { values } = parseArgs({
    options: {
      coin: { type: 'string' },
      'order-id': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('Usage: node .examples-dist/open-orders.js [--coin BTC-PERP] [--order-id ID]');
    console.log(
      'Requires APOLLO_RPC_URL and APOLLO_ACCOUNT; optional APOLLO_COIN / APOLLO_ORDER_ID filters.',
    );
    return;
  }
  const account = accountId();
  const filterId = values['order-id'] ?? (process.env.APOLLO_ORDER_ID?.trim() || undefined);
  const id = filterId === undefined ? undefined : orderId(filterId);
  const ticker = values.coin ?? process.env.APOLLO_COIN;
  const info = new Info(infoOptions());
  await info.client.connect();
  const { markets } = await info.meta();
  const market = ticker ? markets.find((m) => m.ticker === ticker) : undefined;
  if (ticker && !market) throw new Error(`Market not found: ${ticker}`);
  const result = await info.openOrders(account, market?.id);
  const orders = result.orders.filter((o) => id === undefined || o.orderId === id);
  console.log('Account:', account, 'height:', result.at?.executedHeight.toString());
  console.table(
    orders.map((o) => {
      const m = markets.find((item) => item.id === o.market);
      if (!m) throw new Error(`Missing metadata for market ${o.market}`);
      const units = marketUnits(m);
      return {
        orderId: o.orderId.toString(),
        coin: m.ticker,
        side: o.side === common.Side.BID ? 'buy' : o.side === common.Side.ASK ? 'sell' : 'unknown',
        price: subticksToPrice(o.price, units),
        remaining: quantumsToSize(o.remaining, units),
        position:
          o.position === common.PositionSide.LONG
            ? 'Long'
            : o.position === common.PositionSide.SHORT
              ? 'Short'
              : 'Both',
      };
    }),
  );
  if (!orders.length)
    console.log('No matching open orders. Check execution and fills if the final order state is unknown.');
});
