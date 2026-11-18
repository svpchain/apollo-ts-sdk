import { parseArgs } from 'node:util';
import { Decimal } from 'decimal.js';
import {
  buildModifyAction,
  isPriceOnTick,
  marketUnits,
  quantumsToSize,
  sizeToQuantums,
} from '@svpchain/trading-sdk';
import { market } from '@svpchain/trading-sdk/protocol';
import { coin, exchange, orderId, printPrepared, printResponse, run } from './cli.js';

// Default: prepare only. --submit explicitly replaces the specified order.
await run(async () => {
  const { values } = parseArgs({
    options: {
      coin: { type: 'string' },
      'order-id': { type: 'string' },
      price: { type: 'string' },
      size: { type: 'string' },
      submit: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node .examples-dist/modify-order.js --order-id ID --price PRICE --size SIZE [--coin BTC-PERP] [--submit]',
    );
    console.log(
      'Uses the same agent environment as cancel.js. Price/size can also come from APOLLO_PRICE / APOLLO_SIZE.',
    );
    console.log(
      'A successful replacement has a new order ID; the old order may be cancelled even if replacement fails.',
    );
    return;
  }
  const request = {
    coin: coin(values.coin),
    orderId: orderId(values['order-id']),
    price: values.price ?? process.env.APOLLO_PRICE ?? '',
    size: values.size ?? process.env.APOLLO_SIZE ?? '',
  };
  for (const [name, value] of [
    ['price', request.price],
    ['size', request.size],
  ]) {
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`${name} must be a decimal string`);
  }
  const trader = exchange();
  console.log(
    'Modify target:',
    request.coin,
    'order ID:',
    request.orderId.toString(),
    'price:',
    request.price,
    'size:',
    request.size,
  );
  if (values.submit) {
    printResponse(await trader.modifyOrder(request));
  } else {
    const m = await trader.info.market(request.coin);
    const units = marketUnits(m);
    if (m.status !== market.MarketStatus.ACTIVE) throw new Error('Market is not active');
    if (!isPriceOnTick(request.price, units)) throw new Error('Price is off tick');
    if (!new Decimal(quantumsToSize(sizeToQuantums(request.size, units), units)).equals(request.size))
      throw new Error('Size is off step');
    printPrepared(
      await trader.prepare(buildModifyAction({ ...request, account: trader.account, market: units })),
    );
  }
});
