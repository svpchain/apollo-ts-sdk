// 账户编排用假客户端走完整流程：查账户 → 派生 → 槽位判断 → owner 授权 → agent 下单 → 结果。
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { hashTypedData, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, signTypedData as viemSignTypedData } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  ActionRejectedError,
  approveDerivedAgent,
  checkAgentReadiness,
  deriveAgentFromOnboarding,
  fetchChainIdentity,
  lookupAccountByOwner,
  submitAsAgent,
  submitAsOwner,
} from '../src/account.js';
import {
  addressOfPublicKey,
  decodeAuth,
  recoverOwner,
  verifyAgentSignature,
  ownerDigest,
} from '../src/auth.js';
import { type Action, decodeAction } from '../src/codec.js';
import { NonceAllocator } from '../src/nonce.js';
import {
  type GetAccountRequest,
  GetAccountResponseSchema,
  GetAgentsResponseSchema,
} from '../src/gen/apollo/v1/account_pb.js';
import { ChainInfoSchema } from '../src/gen/apollo/v1/chain_pb.js';
import {
  ActionState,
  type GetActionStatusRequest,
  GetActionStatusResponseSchema,
  type SubmitRequest,
  SubmitResponseSchema,
  SubmitStatus,
} from '../src/gen/apollo/v1/tx_pb.js';

import vectors from './vectors/actions.json' with { type: 'json' };
import type { VectorFile } from './vectors/read.js';

const genesis = hexToBytes((vectors as VectorFile).genesis_hash);
const ownerSecret = hexToBytes((vectors as VectorFile).keys.owner_secret);
const ownerAddress = `0x${bytesToHex(addressOfPublicKey(secp256k1.getPublicKey(ownerSecret, false)))}`;
const viemOwner = privateKeyToAccount(`0x${bytesToHex(ownerSecret)}`);

/** 一个会记账的假链：接受提交、记录 action/auth、按 nonce 回答执行结果、维护槽位。 */
function fakeChain(options: { accountId?: number; reject?: string } = {}) {
  const accountId = options.accountId ?? 70_001;
  const submitted: { action: Uint8Array; auth: Uint8Array }[] = [];
  const slots: { slot: number; key: Uint8Array; seq: number; expiry: bigint }[] = [];
  let height = 10n;
  const clients = {
    chain: {
      getChainInfo: async () =>
        create(ChainInfoSchema, {
          chainId: 'apollo-test',
          genesisHash: genesis,
          executedHeight: height,
          blockTimeMs: 200n,
        }),
    },
    account: {
      getAccount: async (req: GetAccountRequest) => {
        if (req.by.case === 'owner' && bytesToHex(req.by.value) !== ownerAddress.slice(2)) {
          throw new ConnectError('no account', Code.NotFound);
        }
        return create(GetAccountResponseSchema, {
          at: { executedHeight: height },
          account: BigInt(accountId),
          owner: hexToBytes(ownerAddress.slice(2)),
          collateral: 1_000_000_000n,
          equity: 1_000_500_000n,
          marginHeadroom: 900_000_000n,
          lastNonce: 5n,
          openOrders: 2,
        });
      },
      getAgents: async () =>
        create(GetAgentsResponseSchema, { at: { executedHeight: height }, agents: slots }),
    },
    tx: {
      submit: async (req: SubmitRequest) => {
        for (const a of req.actions) submitted.push({ action: a.action, auth: a.auth });
        // 模拟执行：ApproveAgent 写槽位。
        for (const a of req.actions) {
          const action = decodeAction(a.action);
          if (action?.type === 'ApproveAgent') {
            const existing = slots.find((s) => s.slot === action.slot);
            const seq = (existing?.seq ?? 0) + 1;
            const next = { slot: action.slot, key: action.key, seq, expiry: action.expiry };
            if (existing) Object.assign(existing, next);
            else slots.push(next);
          }
        }
        height += 1n;
        return create(SubmitResponseSchema, {
          id: req.id,
          statuses: req.actions.map(() => SubmitStatus.ACCEPTED),
        });
      },
      getActionStatus: async (req: GetActionStatusRequest) =>
        create(GetActionStatusResponseSchema, {
          at: { executedHeight: height },
          statuses: req.keys.map((key) => ({
            key,
            state: ActionState.EXECUTED,
            height,
            ok: !options.reject,
            reject: options.reject ?? '',
            orderId: key.nonce,
          })),
        }),
    },
  };
  return { clients, submitted, slots, accountId };
}

const walletSign = async (typed: TypedDataDefinition) =>
  viemSignTypedData({ ...typed, privateKey: `0x${bytesToHex(ownerSecret)}` });

describe('链身份与账户查找', () => {
  it('读创世哈希与高度', async () => {
    const { clients } = fakeChain();
    const id = await fetchChainIdentity(clients as never);
    expect(bytesToHex(id.genesisHash)).toBe((vectors as VectorFile).genesis_hash);
    expect(id.chainId).toBe('apollo-test');
  });

  it('owner 有账户返回快照，没有返回 undefined，其他错误抛出', async () => {
    const { clients } = fakeChain();
    const snap = await lookupAccountByOwner(clients as never, ownerAddress);
    expect(snap?.accountId).toBe(70_001);
    expect(snap?.equity).toBe(1_000_500_000n);
    expect(await lookupAccountByOwner(clients as never, `0x${'11'.repeat(20)}`)).toBeUndefined();
    const broken = {
      account: {
        getAccount: async () => {
          throw new ConnectError('down', Code.Unavailable);
        },
      },
    };
    await expect(lookupAccountByOwner(broken as never, ownerAddress)).rejects.toBeInstanceOf(ConnectError);
    // 19 字节地址在发请求前就被拒。
    await expect(
      lookupAccountByOwner(
        {
          account: {
            getAccount: async () => {
              throw new Error('unreachable');
            },
          },
        } as never,
        `0x${'11'.repeat(19)}`,
      ),
    ).rejects.toThrow('20 字节');
  });
});

describe('agent 授权与下单', () => {
  it('完整流程：派生 → 需授权 → owner 签 ApproveAgent → ready → agent 下单', async () => {
    const chain = fakeChain();
    const nonces = new NonceAllocator({ now: () => 1_700_000_000_000 });
    const submitter = { clients: chain.clients as never, genesisHash: genesis, nonces };

    // onboarding 签名由钱包产生；用 viem 签 agentOnboarding typedData 的任意 65 字节即可派生。
    const onboardingSig = await walletSign({
      domain: { name: 'Apollo', version: '1', salt: `0x${bytesToHex(genesis)}` },
      types: {
        AgentOnboarding: [
          { name: 'statement', type: 'string' },
          { name: 'genesis', type: 'bytes32' },
        ],
      },
      primaryType: 'AgentOnboarding',
      message: { statement: 'x', genesis: `0x${bytesToHex(genesis)}` },
    });
    const derived = deriveAgentFromOnboarding(onboardingSig);
    expect((await checkAgentReadiness(chain.clients as never, chain.accountId, derived)).kind).toBe(
      'needs_approval',
    );

    const signer = await approveDerivedAgent(submitter, walletSign, chain.accountId, derived, {
      intervalMs: 1,
    });
    expect(signer.slot).toBe(1);
    expect(signer.seq).toBe(1);
    expect(chain.slots).toHaveLength(1);

    // ApproveAgent 的 Auth 是 owner 签名：key 0，能恢复出 owner 地址，摘要与 viem 一致。
    const approve = chain.submitted[0];
    const approveAuth = decodeAuth(approve.auth);
    expect(approveAuth.key).toBe(0);
    const approveAction = decodeAction(approve.action)!;
    const digest = ownerDigest(genesis, approveAction, approveAuth.nonce);
    expect(`0x${bytesToHex(recoverOwner(digest, approveAuth.sig)!)}`).toBe(ownerAddress.toLowerCase());
    expect(viemOwner.address.toLowerCase()).toBe(ownerAddress.toLowerCase());
    expect(
      hashTypedData({
        domain: { name: 'Apollo', version: '1', salt: `0x${bytesToHex(genesis)}` },
        types: {
          Action: [
            { name: 'action', type: 'bytes' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
        primaryType: 'Action',
        message: { action: `0x${bytesToHex(approve.action)}`, nonce: approveAuth.nonce },
      }),
    ).toBe(`0x${bytesToHex(digest)}`);

    // agent 下单：静默签名，Auth 带槽位与 seq，链侧可验。
    const place: Action = {
      type: 'Place',
      account: chain.accountId,
      market: 0,
      side: 'Bid',
      price: 100n,
      size: 10n,
      tif: 'Gtc',
      position: 'Long',
      isCross: true,
    };
    const result = await submitAsAgent(submitter, signer, place, { intervalMs: 1 });
    expect(result.outcome).toMatchObject({ kind: 'executed', ok: true, orderId: result.nonce });
    const placed = chain.submitted[1];
    const placedAuth = decodeAuth(placed.auth);
    expect(placedAuth.key).toBe(1);
    expect(placedAuth.seq).toBe(1);
    expect(verifyAgentSignature(signer.publicKey, genesis, place, placedAuth)).toBe(true);
    // nonce 严格递增，且订单 id = nonce。
    expect(result.nonce).toBeGreaterThan(approveAuth.nonce);

    // 再次派生得到同一把 key，此时直接 ready（一次授权多端通用）。
    const again = deriveAgentFromOnboarding(onboardingSig);
    expect(bytesToHex(again.publicKey)).toBe(bytesToHex(derived.publicKey));
    expect((await checkAgentReadiness(chain.clients as never, chain.accountId, again)).kind).toBe('ready');
  });

  it('agent 不能提交 owner 专属动作；执行 Reject 抛 ActionRejectedError', async () => {
    const chain = fakeChain({ reject: 'InsufficientMargin' });
    const nonces = new NonceAllocator({ now: () => 1 });
    const submitter = { clients: chain.clients as never, genesisHash: genesis, nonces };
    const derived = deriveAgentFromOnboarding(new Uint8Array(65).fill(7));
    const signer = await approveDerivedAgent(submitter, walletSign, chain.accountId, derived, {
      intervalMs: 1,
    }).catch((e: unknown) => e);
    // 本假链对 ApproveAgent 也返回 reject，因此授权失败。
    expect(signer).toBeInstanceOf(ActionRejectedError);
    expect((signer as ActionRejectedError).stage).toBe('execute');
    expect((signer as ActionRejectedError).detail).toBe('InsufficientMargin');

    const ok = fakeChain();
    const okSubmitter = {
      clients: ok.clients as never,
      genesisHash: genesis,
      nonces: new NonceAllocator({ now: () => 1 }),
    };
    const ready = await approveDerivedAgent(okSubmitter, walletSign, ok.accountId, derived, {
      intervalMs: 1,
    });
    await expect(
      submitAsAgent(okSubmitter, ready, { type: 'Withdraw', account: ok.accountId, amount: 1n }),
    ).rejects.toBeInstanceOf(ActionRejectedError);
    // owner 可以。
    const w = await submitAsOwner(
      okSubmitter,
      walletSign,
      { type: 'Withdraw', account: ok.accountId, amount: 1n },
      { intervalMs: 1 },
    );
    expect(w.outcome.kind).toBe('executed');
  });

  it('提交层拒绝（如 BAD_SIGNATURE）作为 submit 阶段错误抛出', async () => {
    const tx = {
      submit: async (req: SubmitRequest) =>
        create(SubmitResponseSchema, {
          id: req.id,
          statuses: [SubmitStatus.BAD_SIGNATURE],
          detail: 'stale agent key',
        }),
      getActionStatus: async () => {
        throw new Error('unreachable');
      },
    };
    const submitter = {
      clients: { tx } as never,
      genesisHash: genesis,
      nonces: new NonceAllocator({ now: () => 1 }),
    };
    const derived = deriveAgentFromOnboarding(new Uint8Array(65).fill(9));
    const { createAgentSigner } = await import('../src/auth.js');
    const signer = createAgentSigner(derived.seed, 1, 1);
    const err = await submitAsAgent(submitter, signer, {
      type: 'Cancel',
      account: 1,
      market: 0,
      orderId: 5n,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionRejectedError);
    expect((err as ActionRejectedError).stage).toBe('submit');
    expect((err as ActionRejectedError).detail).toContain('bad_signature');
  });
});
