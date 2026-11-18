import {
  Exchange,
  waitForAction,
  type ApolloClientOptions,
  type CreateOrderRequest,
} from '@svpchain/trading-sdk';

/** Calling explicitly submits an order; importing this file does not run any trade. */
export async function placeAndConfirm(
  options: ApolloClientOptions,
  account: number,
  seed: Uint8Array,
  request: CreateOrderRequest,
  slot = 1,
) {
  const exchange = new Exchange({ ...options, account, signer: { type: 'agent', seed, slot } });
  const response = await exchange.order(request);
  const item = response.statuses[0];
  console.log('transaction hash:', item.prepared.transactionHash);
  const outcome =
    item.submitStatus === 'accepted' && item.outcome.kind === 'pending'
      ? await waitForAction(exchange.info.rpc, item.prepared, { timeoutMs: 30_000 })
      : item.outcome;
  return { exchange, response, outcome };
}

/** Calling explicitly cancels the chosen resting order. */
export async function cancelExistingOrder(
  options: ApolloClientOptions,
  account: number,
  seed: Uint8Array,
  coin: string,
  orderId: bigint,
  slot = 1,
) {
  const exchange = new Exchange({ ...options, account, signer: { type: 'agent', seed, slot } });
  return exchange.cancel({ coin, orderId });
}
