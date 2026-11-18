import {
  Exchange,
  createWalletSigner,
  createAgentSigner,
  type ApolloClientOptions,
} from '@svpchain/trading-sdk';
import type { WalletClient } from 'viem';

/** Calling explicitly submits agent approval. Only defines the integration on import. */
export async function approveTradingAgent(
  options: ApolloClientOptions,
  wallet: WalletClient,
  account: number,
  seed: Uint8Array,
) {
  if (!wallet.account) throw new Error('Connect the owner wallet first');
  const walletAccount = wallet.account;
  const owner = new Exchange({
    ...options,
    account,
    signer: createWalletSigner((data) => wallet.signTypedData({ ...data, account: walletAccount })),
  });
  const { publicKey } = createAgentSigner(seed, 1, 0);
  const approval = await owner.approveAgent(1, publicKey);
  if (!approval.successful()) throw new Error('Agent approval has not been confirmed successful');
  return new Exchange({ ...options, account, signer: { type: 'agent', seed, slot: 1 } });
}
