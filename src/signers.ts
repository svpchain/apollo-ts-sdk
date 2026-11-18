import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { signWithOwnerKey, strip0x } from './auth.js';
import { decodeAction } from './codec.js';
import type { SignTypedData } from './account.js';

export type ExchangeSigner =
  | { type: 'agent'; seed: Uint8Array; slot?: number }
  | { type: 'owner'; signTypedData: SignTypedData };

/** A wallet callback; no private key is needed by the SDK. */
export function createWalletSigner(signTypedData: SignTypedData): ExchangeSigner {
  if (typeof signTypedData !== 'function') throw new TypeError('signTypedData callback is required');
  return Object.freeze({ type: 'owner' as const, signTypedData });
}
/** Local EIP-712 owner signing for Node/services. The private key stays in a closure. */
export function createOwnerKeySigner(privateKey: Uint8Array | `0x${string}`): ExchangeSigner {
  const key = typeof privateKey === 'string' ? hexToBytes(strip0x(privateKey)) : Uint8Array.from(privateKey);
  if (key.length !== 32) throw new RangeError('owner private key must be 32 bytes');
  // Validate the scalar before constructing a callable signer.
  const probe = { type: 'CancelAll', account: 1, market: 0xffff } as const;
  signWithOwnerKey(key, new Uint8Array(32), probe, 1n);
  return createWalletSigner(async (data) => {
    const action = decodeAction(hexToBytes(strip0x(data.message.action)));
    if (!action) throw new TypeError('Unsupported action in owner typed data');
    const auth = signWithOwnerKey(
      key,
      hexToBytes(strip0x(data.domain.salt)),
      action,
      BigInt(data.message.nonce),
    );
    return `0x${bytesToHex(auth.sig)}`;
  });
}
