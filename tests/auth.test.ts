// 签名与 Auth 编码按协议向量逐字节比对；owner 的 EIP-712 摘要再用 viem 的 hashTypedData
// 交叉验证，保证交给钱包的 typedData 与协议摘要一致。
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { hashTypedData } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  AGENT_MESSAGE_BYTES,
  AUTH_BYTES,
  AuthError,
  addressOfPublicKey,
  agentMessage,
  createAgentSigner,
  decodeAuth,
  eip712DomainSeparator,
  encodeAuth,
  ownerAuthFromSignature,
  ownerDigest,
  ownerTypedData,
  recoverOwner,
  signWithAgent,
  signWithOwnerKey,
  verifyAgentSignature,
} from '../src/auth.js';
import {
  agentOnboardingTypedData,
  agentReadiness,
  agentSeedFromSignature,
  deriveAgent,
} from '../src/agent.js';
import vectors from './vectors/actions.json' with { type: 'json' };
import { actionFromVector, type VectorFile } from './vectors/read.js';

const file = vectors as VectorFile;
const genesis = hexToBytes(file.genesis_hash);
const agentSeed = hexToBytes(file.keys.agent_seed);
const ownerSecret = hexToBytes(file.keys.owner_secret);

describe('常量与密钥', () => {
  it('尺寸与链一致', () => {
    expect(AUTH_BYTES).toBe(file.sizes.auth);
    expect(AGENT_MESSAGE_BYTES).toBe(file.sizes.agent_message);
    expect(file.context).toBe('apollo-action-v3');
  });

  it('ed25519 公钥与 owner 地址由同一密钥推出', () => {
    expect(bytesToHex(ed25519.getPublicKey(agentSeed))).toBe(file.keys.agent_public);
    const pub = secp256k1.getPublicKey(ownerSecret, false);
    expect(bytesToHex(addressOfPublicKey(pub))).toBe(file.keys.owner_address);
    expect(bytesToHex(addressOfPublicKey(secp256k1.getPublicKey(ownerSecret, true)))).toBe(
      file.keys.owner_address,
    );
  });

  it('EIP-712 domain separator 与链一致', () => {
    expect(file.eip712.name).toBe('Apollo');
    expect(file.eip712.version).toBe('1');
    expect(bytesToHex(eip712DomainSeparator(genesis))).toBe(file.eip712.domain_separator);
  });
});

describe('agent 签名向量', () => {
  for (const vector of file.actions.filter((v) => v.agent)) {
    const agent = vector.agent!;
    it(`${vector.name} 的消息、签名与 Auth 字节一致`, () => {
      const action = actionFromVector(vector.action);
      const nonce = BigInt(vector.nonce);
      expect(bytesToHex(agentMessage(genesis, action, nonce, agent.slot, agent.seq))).toBe(agent.message);
      const signer = createAgentSigner(agentSeed, agent.slot, agent.seq);
      const auth = signWithAgent(signer, genesis, action, nonce);
      expect(bytesToHex(encodeAuth(auth))).toBe(agent.auth);
      expect(verifyAgentSignature(signer.publicKey, genesis, action, auth)).toBe(true);
      // 解码回同一结构。
      const decoded = decodeAuth(hexToBytes(agent.auth));
      expect(decoded.nonce).toBe(nonce);
      expect(decoded.key).toBe(agent.slot);
      expect(decoded.seq).toBe(agent.seq);
      expect(decoded.sig[64]).toBe(0);
    });
  }

  it('agent 不能签只属于 owner 的 action', () => {
    const withdraw = actionFromVector(file.actions.find((v) => v.name === 'withdraw')!.action);
    const signer = createAgentSigner(agentSeed, 1, 7);
    expect(() => signWithAgent(signer, genesis, withdraw, 1n)).toThrow(AuthError);
  });

  it('换了 seq 或创世哈希签名就不再匹配', () => {
    const vector = file.actions.find((v) => v.agent)!;
    const action = actionFromVector(vector.action);
    const nonce = BigInt(vector.nonce);
    const other = signWithAgent(
      createAgentSigner(agentSeed, 1, vector.agent!.seq + 1),
      genesis,
      action,
      nonce,
    );
    expect(bytesToHex(encodeAuth(other))).not.toBe(vector.agent!.auth);
    const otherGenesis = new Uint8Array(32).fill(9);
    const acrossChains = signWithAgent(
      createAgentSigner(agentSeed, 1, vector.agent!.seq),
      otherGenesis,
      action,
      nonce,
    );
    expect(verifyAgentSignature(ed25519.getPublicKey(agentSeed), genesis, action, acrossChains)).toBe(false);
  });
});

describe('owner 签名向量', () => {
  for (const vector of file.actions) {
    it(`${vector.name} 的摘要、签名与地址恢复一致`, () => {
      const action = actionFromVector(vector.action);
      const nonce = BigInt(vector.nonce);
      const digest = ownerDigest(genesis, action, nonce);
      expect(bytesToHex(digest)).toBe(vector.owner.digest);

      // 钱包会算的 EIP-712 哈希与协议摘要相同。
      expect(hashTypedData(ownerTypedData(genesis, action, nonce))).toBe(`0x${vector.owner.digest}`);

      const auth = signWithOwnerKey(ownerSecret, genesis, action, nonce);
      expect(bytesToHex(encodeAuth(auth))).toBe(vector.owner.auth);
      expect(bytesToHex(recoverOwner(digest, auth.sig)!)).toBe(file.keys.owner_address);

      // 钱包返回的签名装进 Auth 走同一条路。
      const fromWallet = ownerAuthFromSignature(nonce, `0x${bytesToHex(auth.sig)}`);
      expect(bytesToHex(encodeAuth(fromWallet))).toBe(vector.owner.auth);
    });
  }

  it('高 s 或坏恢复位被拒绝', () => {
    const vector = file.actions[0];
    const auth = signWithOwnerKey(
      ownerSecret,
      genesis,
      actionFromVector(vector.action),
      BigInt(vector.nonce),
    );
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const s = BigInt(`0x${bytesToHex(auth.sig.subarray(32, 64))}`);
    const highS = n - s;
    const bad = new Uint8Array(auth.sig);
    bad.set(hexToBytes(highS.toString(16).padStart(64, '0')), 32);
    expect(() => ownerAuthFromSignature(1n, bad)).toThrow(AuthError);
    expect(
      recoverOwner(ownerDigest(genesis, actionFromVector(vector.action), BigInt(vector.nonce)), bad),
    ).toBeUndefined();
    const badV = new Uint8Array(auth.sig);
    badV[64] = 5;
    expect(() => ownerAuthFromSignature(1n, badV)).toThrow(AuthError);
  });
});

describe('agent 派生', () => {
  it('同一签名派生同一 key，恢复位不影响熵', () => {
    const sig = new Uint8Array(65).fill(0x33);
    sig[64] = 27;
    const a = deriveAgent(sig);
    sig[64] = 0;
    const b = deriveAgent(sig);
    expect(bytesToHex(a.seed)).toBe(bytesToHex(b.seed));
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(ed25519.getPublicKey(a.seed)));
    expect(a.slot).toBe(1);
    expect(() => agentSeedFromSignature(new Uint8Array(64))).toThrow();
  });

  it('onboarding 消息按创世哈希隔离链', () => {
    const typed = agentOnboardingTypedData(genesis);
    expect(typed.domain.name).toBe('Apollo');
    expect(typed.message.genesis).toBe(`0x${file.genesis_hash}`);
    expect(hashTypedData(typed)).not.toBe(
      hashTypedData(agentOnboardingTypedData(new Uint8Array(32).fill(1))),
    );
  });

  it('对照链上槽位判断是否需要授权', () => {
    const derived = deriveAgent(new Uint8Array(65).fill(0x44));
    expect(agentReadiness(derived, [], 100n).kind).toBe('needs_approval');
    const otherKey = { slot: 1, key: new Uint8Array(32).fill(1), seq: 3, expiry: 0n };
    expect(agentReadiness(derived, [otherKey], 100n).kind).toBe('needs_approval');
    const mine = { slot: 1, key: derived.publicKey, seq: 3, expiry: 0n };
    const ready = agentReadiness(derived, [mine], 100n);
    expect(ready.kind).toBe('ready');
    if (ready.kind === 'ready') {
      expect(ready.signer.seq).toBe(3);
      expect(ready.signer.slot).toBe(1);
    }
    expect(agentReadiness(derived, [{ ...mine, expiry: 50n }], 100n).kind).toBe('expired');
    expect(agentReadiness(derived, [{ ...mine, expiry: 100n }], 100n).kind).toBe('ready');
  });
});
