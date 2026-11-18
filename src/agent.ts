// agent 密钥派生工具：onboarding EIP-712 签名 → Ed25519 种子。
// 只有相同签名字节才产生同一把 key，不应假设所有钱包都会确定性地产生相同签名。
// 调用方负责保存派生结果与授权；也可直接使用随机种子。

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { type AgentSigner, EIP712_NAME, EIP712_VERSION, createAgentSigner, strip0x } from './auth.js';

/** 确定性派生的 key 固定使用的槽位。 */
export const DEFAULT_AGENT_SLOT = 1;
/** 过期高度 0：不过期。 */
export const NO_EXPIRY = 0n;

const ONBOARDING_STATEMENT =
  'Authorize this browser to trade on Apollo with a derived key. ' +
  'Signing this message does not move funds; only you can withdraw.';

/**
 * 派生用的 onboarding 消息（wagmi / viem `signTypedData` 形状）。domain 与 action 签名相同，
 * 钱包里显示为 Apollo 的请求；`statement` 固定，`genesis` 让签名（因此 key）按链隔离。
 */
export function agentOnboardingTypedData(genesisHash: Uint8Array) {
  if (genesisHash.length !== 32) throw new Error('创世哈希必须是 32 字节');
  return {
    domain: {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      salt: `0x${bytesToHex(genesisHash)}` as `0x${string}`,
    },
    types: {
      AgentOnboarding: [
        { name: 'statement', type: 'string' },
        { name: 'genesis', type: 'bytes32' },
      ],
    },
    primaryType: 'AgentOnboarding' as const,
    message: {
      statement: ONBOARDING_STATEMENT,
      genesis: `0x${bytesToHex(genesisHash)}` as `0x${string}`,
    },
  } as const;
}

/**
 * 签名（65 字节 r ‖ s ‖ v）→ ed25519 种子。只取 r ‖ s：钱包对 v 的归一化（0/1 与 27/28）不同，
 * 不能让它影响熵。keccak256 把 64 字节压成 32 字节种子。
 */
export function agentSeedFromSignature(signature: Uint8Array | string): Uint8Array {
  const raw = typeof signature === 'string' ? hexToBytes(strip0x(signature)) : signature;
  if (raw.length !== 65) throw new Error(`签名长度应为 65 字节，收到 ${raw.length}`);
  return keccak_256(raw.subarray(0, 64));
}

export interface DerivedAgent {
  seed: Uint8Array;
  publicKey: Uint8Array;
  slot: number;
}

/** 由 onboarding 签名得到 agent 密钥对；`seq` 要等查过链上槽位后才知道，由调用方补。 */
export function deriveAgent(signature: Uint8Array | string): DerivedAgent {
  const seed = agentSeedFromSignature(signature);
  const { publicKey } = createAgentSigner(seed, DEFAULT_AGENT_SLOT, 0);
  return { seed, publicKey, slot: DEFAULT_AGENT_SLOT };
}

/** 槽位状态（AccountService.GetAgents 的一项）。 */
export interface AgentSlotState {
  slot: number;
  key: Uint8Array;
  seq: number;
  expiry: bigint;
}

export type AgentReadiness =
  | { kind: 'ready'; signer: AgentSigner }
  /** 槽位空或装着别的 key：要 owner 签 ApproveAgent{slot, key, expiry}。 */
  | { kind: 'needs_approval'; slot: number; key: Uint8Array }
  /** 槽位里是这把 key 但已过期：同样走 ApproveAgent 续期（seq 会 +1）。 */
  | { kind: 'expired'; slot: number; key: Uint8Array; expiredAt: bigint };

/**
 * 对照链上槽位判断派生 key 能否直接交易。`executedHeight` 用于过期判断（expiry 0 不过期）。
 */
export function agentReadiness(
  derived: DerivedAgent,
  slots: readonly AgentSlotState[],
  executedHeight: bigint,
): AgentReadiness {
  const slot = slots.find((s) => s.slot === derived.slot);
  if (!slot || !bytesEqual(slot.key, derived.publicKey)) {
    return { kind: 'needs_approval', slot: derived.slot, key: derived.publicKey };
  }
  if (slot.expiry !== 0n && slot.expiry < executedHeight) {
    return { kind: 'expired', slot: derived.slot, key: derived.publicKey, expiredAt: slot.expiry };
  }
  return { kind: 'ready', signer: createAgentSigner(derived.seed, slot.slot, slot.seq) };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
