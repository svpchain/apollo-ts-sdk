import {
  Exchange,
  ExchangeSubmissionUnknownError,
  ExchangeTrackingError,
  hexToBytes32,
  type Hex,
  type InfoOptions,
  type OrderResponse,
  type PreparedAction,
} from '@svpchain/trading-sdk';

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

export function infoOptions(): InfoOptions {
  const expected = process.env.APOLLO_GENESIS_HASH?.trim();
  return {
    baseUrl: requiredEnv('APOLLO_RPC_URL'),
    ...(expected
      ? { expectedGenesisHash: `0x${Buffer.from(hexToBytes32(expected)).toString('hex')}` as Hex }
      : {}),
  };
}

export function accountId(): number {
  const value = requiredEnv('APOLLO_ACCOUNT');
  if (!/^\d+$/.test(value) || BigInt(value) < 1n || BigInt(value) > 0xffff_ffffn)
    throw new Error('APOLLO_ACCOUNT must be a nonzero uint32');
  return Number(value);
}

export function orderId(value = process.env.APOLLO_ORDER_ID): bigint {
  if (!value || !/^\d+$/.test(value) || BigInt(value) < 1n || BigInt(value) > 0xffff_ffff_ffff_ffffn)
    throw new Error('Pass --order-id or set APOLLO_ORDER_ID to a nonzero uint64 (digits only, without n)');
  return BigInt(value);
}

export function coin(value?: string): string {
  const ticker = value?.trim() || process.env.APOLLO_COIN?.trim();
  if (!ticker) throw new Error('Pass --coin or set APOLLO_COIN');
  return ticker;
}

export function exchange(): Exchange {
  // A trusted chain identity is required before preparing any signed transaction.
  const genesis = requiredEnv('APOLLO_GENESIS_HASH');
  const slotText = process.env.APOLLO_AGENT_SLOT ?? '1';
  if (!/^[1-4]$/.test(slotText)) throw new Error('APOLLO_AGENT_SLOT must be 1..4');
  return new Exchange({
    ...infoOptions(),
    expectedGenesisHash: hexToBytes32(genesis),
    account: accountId(),
    signer: { type: 'agent', seed: hexToBytes32(requiredEnv('APOLLO_AGENT_SEED')), slot: Number(slotText) },
  });
}

export function printPrepared(prepared: PreparedAction): void {
  console.log('prepared hash:', prepared.transactionHash, 'nonce:', prepared.nonce.toString());
  console.log('Not broadcast. Add --submit to execute this action.');
}

export function printResponse(response: OrderResponse): void {
  console.table(
    response.statuses.map((item) => ({
      nonce: item.prepared.nonce.toString(),
      transactionHash: item.prepared.transactionHash,
      submit: item.submitStatus,
      execution: item.outcome.kind,
      ok: item.outcome.kind === 'executed' ? item.outcome.ok : undefined,
      orderId: item.outcome.kind === 'executed' ? item.outcome.orderId?.toString() : undefined,
      error: item.error,
    })),
  );
  if (!response.successful()) {
    console.error('Action not confirmed successful. Reconcile the original account/nonce before retrying.');
    process.exitCode = 1;
  }
}

export async function run(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof ExchangeSubmissionUnknownError) {
      console.table(
        error.prepared.map((p) => ({
          account: p.account,
          nonce: p.nonce.toString(),
          hash: p.transactionHash,
        })),
      );
    } else if (error instanceof ExchangeTrackingError) {
      printResponse(error.response);
    }
    process.exitCode = 1;
  }
}
