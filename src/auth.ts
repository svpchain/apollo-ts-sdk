// Apollo action 的签名与授权编码。
//
// 两类签名者：
//   - owner：账户所属的 EVM 地址，用钱包 `eth_signTypedData_v4` 签 EIP-712 结构
//     `Action(bytes action,uint64 nonce)`，domain 为 `Apollo / 1 / salt = 创世哈希`。
//     可签该账户的任何 action，提现、质押、agent 管理只有它能签。
//   - agent：owner 用 ApproveAgent 放进 1..4 槽位的 ed25519 密钥，只能签交易类 action。
//     签的是 `"apollo-action-v3" ‖ 创世哈希 ‖ action(48) ‖ nonce ‖ key ‖ seq`，seq 是槽位序号，
//     每次授权 / 撤销 +1，所以被替换的 key 签出的 action 会被链拒绝（StaleKey）。
//
// 两者都装进 78 字节 Auth：nonce(8, LE) ‖ key(1：0 = owner，1..4 = 槽位) ‖ seq(4, LE) ‖ sig(65)。
// ed25519 签名占前 64 字节、末字节 0；secp256k1 为 r ‖ s ‖ v，v 取 27 / 28。
// 字节正确性由 `auth.test.ts` 用协议向量逐字节比对保证。

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { ACTION_BYTES, type Action, agentMay, encodeAction } from './codec.js';

export const AUTH_BYTES = 8 + 1 + 4 + 65;
export const AGENT_MESSAGE_BYTES = 16 + 32 + ACTION_BYTES + 8 + 1 + 4;
export const AGENT_SLOTS = 4;
/** agent 签名消息的上下文前缀，16 字节 ASCII。 */
export const AGENT_CONTEXT = 'apollo-action-v3';

export const EIP712_NAME = 'Apollo';
export const EIP712_VERSION = '1';
const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,bytes32 salt)';
const EIP712_ACTION_TYPE = 'Action(bytes action,uint64 nonce)';

/** 签名者的身份：0 为 owner，1..4 为 agent 槽位。 */
export type AuthKey = 0 | 1 | 2 | 3 | 4;

export interface Auth {
  nonce: bigint;
  key: AuthKey;
  /** agent 槽位签名时的序号；owner 为 0。 */
  seq: number;
  /** 65 字节：ed25519 为 sig(64) ‖ 0，secp256k1 为 r ‖ s ‖ v。 */
  sig: Uint8Array;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const U64_MAX = (1n << 64n) - 1n;

function checkNonce(nonce: bigint): bigint {
  if (typeof nonce !== 'bigint' || nonce < 0n || nonce > U64_MAX) {
    throw new AuthError(`nonce 必须是 u64 范围的 bigint，收到 ${String(nonce)}`);
  }
  return nonce;
}

function checkSlot(slot: number): AuthKey {
  if (!Number.isInteger(slot) || slot < 1 || slot > AGENT_SLOTS) {
    throw new AuthError(`agent 槽位必须在 1..${AGENT_SLOTS}，收到 ${slot}`);
  }
  return slot as AuthKey;
}

function checkSeq(seq: number): number {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff_ffff) {
    throw new AuthError(`seq 必须是 u32，收到 ${seq}`);
  }
  return seq;
}

export function encodeAuth(auth: Auth): Uint8Array {
  if (auth.sig.length !== 65) {
    throw new AuthError(`签名必须是 65 字节，收到 ${auth.sig.length}`);
  }
  const out = new Uint8Array(AUTH_BYTES);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, checkNonce(auth.nonce), true);
  if (!Number.isInteger(auth.key) || auth.key < 0 || auth.key > AGENT_SLOTS)
    throw new AuthError('Invalid auth key');
  out[8] = auth.key;
  view.setUint32(9, checkSeq(auth.seq), true);
  out.set(auth.sig, 13);
  return out;
}

export function decodeAuth(bytes: Uint8Array): Auth {
  if (bytes.length < AUTH_BYTES) {
    throw new AuthError(`auth 至少 ${AUTH_BYTES} 字节，收到 ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, AUTH_BYTES);
  const key = bytes[8];
  if (key > AGENT_SLOTS) throw new AuthError(`auth key ${key} 不合法`);
  return {
    nonce: view.getBigUint64(0, true),
    key: key as AuthKey,
    seq: view.getUint32(9, true),
    sig: bytes.slice(13, AUTH_BYTES),
  };
}

function genesis32(genesisHash: Uint8Array): Uint8Array {
  if (genesisHash.length !== 32) {
    throw new AuthError(`创世哈希必须是 32 字节，收到 ${genesisHash.length}`);
  }
  return genesisHash;
}

// ───────────────────────── agent（ed25519） ─────────────────────────

/** agent 密钥签名的消息：上下文 ‖ 创世哈希 ‖ action ‖ nonce ‖ key ‖ seq。 */
export function agentMessage(
  genesisHash: Uint8Array,
  action: Action,
  nonce: bigint,
  slot: number,
  seq: number,
): Uint8Array {
  return ed25519Message(genesisHash, action, nonce, checkSlot(slot), seq);
}

/**
 * ed25519 key 签名的消息。agent 走 `agentMessage` 以校验槽位。
 */
export function ed25519Message(
  genesisHash: Uint8Array,
  action: Action,
  nonce: bigint,
  key: AuthKey,
  seq: number,
): Uint8Array {
  const tail = new Uint8Array(8 + 1 + 4);
  const view = new DataView(tail.buffer);
  view.setBigUint64(0, checkNonce(nonce), true);
  tail[8] = key;
  view.setUint32(9, checkSeq(seq), true);
  const message = concatBytes(utf8ToBytes(AGENT_CONTEXT), genesis32(genesisHash), encodeAction(action), tail);
  if (message.length !== AGENT_MESSAGE_BYTES) {
    throw new AuthError(`agent 消息长度 ${message.length}，应为 ${AGENT_MESSAGE_BYTES}`);
  }
  return message;
}

export interface AgentSigner {
  /** 32 字节 ed25519 公钥，即 ApproveAgent 写入槽位的 key。 */
  publicKey: Uint8Array;
  slot: number;
  /** 链上该槽位当前的序号（GetAgents）；不一致链会拒绝为 StaleKey。 */
  seq: number;
  sign(message: Uint8Array): Uint8Array;
}

/** 由 32 字节 ed25519 种子构造 agent 签名者。种子的来源见 `agent.ts`。 */
export function createAgentSigner(seed: Uint8Array, slot: number, seq: number): AgentSigner {
  if (seed.length !== 32) throw new AuthError(`ed25519 种子必须是 32 字节，收到 ${seed.length}`);
  const privateSeed = Uint8Array.from(seed);
  return {
    publicKey: ed25519.getPublicKey(privateSeed),
    slot: checkSlot(slot),
    seq: checkSeq(seq),
    sign: (message) => ed25519.sign(message, privateSeed),
  };
}

/** 用 agent 密钥签一个 action；非交易类 action 直接拒绝，不浪费一次链上 NotPermitted。 */
export function signWithAgent(
  signer: AgentSigner,
  genesisHash: Uint8Array,
  action: Action,
  nonce: bigint,
): Auth {
  if (!agentMay(action)) {
    throw new AuthError(`${action.type} 只能由 owner 签名`);
  }
  const sig = new Uint8Array(65);
  sig.set(signer.sign(agentMessage(genesisHash, action, nonce, signer.slot, signer.seq)), 0);
  return { nonce, key: signer.slot as AuthKey, seq: signer.seq, sig };
}

export function verifyAgentSignature(
  publicKey: Uint8Array,
  genesisHash: Uint8Array,
  action: Action,
  auth: Auth,
): boolean {
  if (auth.key === 0) return false;
  const message = agentMessage(genesisHash, action, auth.nonce, auth.key, auth.seq);
  // 按 ZIP-215 规则验签（noble 默认）。
  return ed25519.verify(auth.sig.subarray(0, 64), message, publicKey);
}

// ───────────────────────── owner（EIP-712 / secp256k1） ─────────────────────────

function keccak(...parts: Uint8Array[]): Uint8Array {
  return keccak_256(concatBytes(...parts));
}

/** EIP-712 domain separator：name / version / salt(创世哈希)，没有 chainId 与合约地址。 */
export function eip712DomainSeparator(genesisHash: Uint8Array): Uint8Array {
  return keccak(
    keccak(utf8ToBytes(EIP712_DOMAIN_TYPE)),
    keccak(utf8ToBytes(EIP712_NAME)),
    keccak(utf8ToBytes(EIP712_VERSION)),
    genesis32(genesisHash),
  );
}

/** owner 要签的 32 字节摘要：`0x19 0x01 ‖ domainSeparator ‖ hashStruct(Action)`。 */
export function ownerDigest(genesisHash: Uint8Array, action: Action, nonce: bigint): Uint8Array {
  const n = new Uint8Array(32);
  new DataView(n.buffer).setBigUint64(24, checkNonce(nonce), false);
  const structHash = keccak(keccak(utf8ToBytes(EIP712_ACTION_TYPE)), keccak(encodeAction(action)), n);
  return keccak(Uint8Array.of(0x19, 0x01), eip712DomainSeparator(genesisHash), structHash);
}

/**
 * 交给钱包 `signTypedData` 的完整参数（wagmi / viem 形状）。钱包会对同一结构做 EIP-712 哈希，
 * 结果必须等于 `ownerDigest`——`auth.test.ts` 用 viem 的 `hashTypedData` 交叉验证这一点。
 */
export function ownerTypedData(genesisHash: Uint8Array, action: Action, nonce: bigint) {
  return {
    domain: {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      salt: `0x${bytesToHex(genesis32(genesisHash))}` as `0x${string}`,
    },
    types: {
      Action: [
        { name: 'action', type: 'bytes' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType: 'Action' as const,
    message: {
      action: `0x${bytesToHex(encodeAction(action))}` as `0x${string}`,
      nonce: checkNonce(nonce),
    },
  } as const;
}

/**
 * 把钱包返回的 65 字节签名（r ‖ s ‖ v，v 为 27/28 或 0/1）装进 owner 的 Auth。
 * 链只接受低 s；主流钱包都满足，这里再校验一次，避免提交后才收到 BAD_SIGNATURE。
 */
export function ownerAuthFromSignature(nonce: bigint, signature: Uint8Array | string): Auth {
  const sig = typeof signature === 'string' ? hexToBytes(strip0x(signature)) : signature;
  if (sig.length !== 65) throw new AuthError(`owner 签名必须是 65 字节，收到 ${sig.length}`);
  if (![0, 1, 27, 28].includes(sig[64])) throw new AuthError(`恢复位 ${sig[64]} 不合法`);
  const s = BigInt(`0x${bytesToHex(sig.subarray(32, 64))}`);
  if (s > secp256k1.Point.CURVE().n / 2n) throw new AuthError('owner 签名的 s 不是低 s');
  return { nonce: checkNonce(nonce), key: 0, seq: 0, sig: new Uint8Array(sig) };
}

/** 20 字节 EVM 地址：keccak(未压缩公钥去掉 0x04 前缀) 的末 20 字节。 */
export function addressOfPublicKey(publicKey: Uint8Array): Uint8Array {
  const uncompressed =
    publicKey.length === 65 ? publicKey : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return keccak(uncompressed.subarray(1)).subarray(12);
}

/** 从 owner 签名恢复地址；格式错误或高 s 返回 `undefined`。 */
export function recoverOwner(digest: Uint8Array, sig: Uint8Array): Uint8Array | undefined {
  if (sig.length !== 65) return undefined;
  const v = sig[64];
  const recovery = v === 0 || v === 27 ? 0 : v === 1 || v === 28 ? 1 : undefined;
  if (recovery === undefined) return undefined;
  try {
    const parsed = secp256k1.Signature.fromBytes(sig.subarray(0, 64), 'compact');
    if (parsed.hasHighS()) return undefined;
    const publicKey = parsed.addRecoveryBit(recovery).recoverPublicKey(digest).toBytes(false);
    return addressOfPublicKey(publicKey);
  } catch {
    return undefined;
  }
}

/**
 * 用本地 secp256k1 私钥以 owner 身份签名（RFC 6979 确定性 nonce、低 s）。
 * 浏览器场景建议使用钱包签名；本函数适合服务端、脚本和测试。
 */
export function signWithOwnerKey(
  secretKey: Uint8Array,
  genesisHash: Uint8Array,
  action: Action,
  nonce: bigint,
): Auth {
  const digest = ownerDigest(genesisHash, action, nonce);
  // noble 的 recovered 格式是 recid ‖ r ‖ s；Apollo 要 r ‖ s ‖ (27 + recid)。
  const recovered = secp256k1.sign(digest, secretKey, { prehash: false, format: 'recovered' });
  const sig = new Uint8Array(65);
  sig.set(recovered.subarray(1), 0);
  sig[64] = 27 + recovered[0];
  return { nonce: checkNonce(nonce), key: 0, seq: 0, sig };
}

export function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

export function hexToBytes32(hex: string): Uint8Array {
  const bytes = hexToBytes(strip0x(hex));
  if (bytes.length !== 32) throw new AuthError(`期望 32 字节 hex，收到 ${bytes.length} 字节`);
  return bytes;
}
