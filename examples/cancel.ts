import { parseArgs } from 'node:util';
import { coin, exchange, orderId, printPrepared, printResponse, run } from './cli.js';

// Default: prepare only. --submit explicitly cancels the specified order.
await run(async () => {
  const { values } = parseArgs({
    options: {
      coin: { type: 'string' },
      'order-id': { type: 'string' },
      submit: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('Usage: node .examples-dist/cancel.js --order-id ID [--coin BTC-PERP] [--submit]');
    console.log(
      'Uses APOLLO_RPC_URL, APOLLO_ACCOUNT, APOLLO_GENESIS_HASH, APOLLO_AGENT_SEED and optional APOLLO_AGENT_SLOT (default 1).',
    );
    console.log('Coin/order ID can also be set with APOLLO_COIN / APOLLO_ORDER_ID.');
    return;
  }
  const ticker = coin(values.coin);
  const id = orderId(values['order-id']);
  const trader = exchange();
  console.log('Cancel target:', ticker, 'order ID:', id.toString(), 'account:', trader.account);
  if (values.submit) {
    const response = await trader.cancel({ coin: ticker, orderId: id });
    printResponse(response);
    if (response.successful()) {
      const market = await trader.info.market(ticker);
      const after = await trader.info.openOrders(trader.account, market.id);
      const stillOpen = after.orders.some((o) => o.orderId === id);
      console.log('Still open after cancellation:', stillOpen);
      if (stillOpen) process.exitCode = 1;
    }
  } else {
    const market = await trader.info.market(ticker);
    printPrepared(
      await trader.prepare({ type: 'Cancel', account: trader.account, market: market.id, orderId: id }),
    );
  }
});
