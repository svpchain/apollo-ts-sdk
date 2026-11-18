// 账户编排：owner 地址 → 链上账户 → agent 就绪 → 签名提交。
//
// 这一层不依赖 React，所有外部 IO 通过 `ApolloClients` 与两个回调注入（钱包签 typedData、
// 当前时间），因此可以用假客户端完整测试。React 侧（ApolloAccountContext）只负责把状态
// 搬进组件树。
//
// 登录流程（决策：确定性派生，一次授权多端通用）：
//   1. 钱包连接 → GetAccount(owner)。地址没入过金就没有账户，一切交易入口禁用，引导入金。
//   2. 本地有会话种子则直接用；没有则请钱包签 onboarding 消息派生。
//   3. GetAgents 看槽位 1：是这把 key 且未过期 → ready；否则 owner 签 ApproveAgent 一次。
//   4. 之后所有交易动作由 agent 静默签名，经 Submit 提交，GetActionStatus 拿结果。

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import {
  type AgentReadiness,
  type AgentSlotState,
  type DerivedAgent,
  NO_EXPIRY,
  agentReadiness,
  deriveAgent,
} from './agent.js';
import {
  type AgentSigner,
  type Auth,
  ownerAuthFromSignature,
  ownerTypedData,
  signWithAgent,
  strip0x,
} from './auth.js';
import { type Action, agentMay } from './codec.js';
import { NonceAllocator } from './nonce.js';
import {
  type ActionOutcome,
  type ApolloClients,
  type SubmitResult,
  type WaitForActionOptions,
  classifyRpcError,
  submitActions,
  waitForAction,
} from './transport.js';

export interface ChainIdentity {
  chainId: string;
  genesisHash: Uint8Array;
  executedHeight: bigint;
  blockTimeMs: bigint;
}

/** 链身份：创世哈希进签名域，必须来自节点而不是配置文件。 */
export async function fetchChainIdentity(
  clients: Pick<ApolloClients, 'chain'>,
  signal?: AbortSignal,
): Promise<ChainIdentity> {
  const info = await clients.chain.getChainInfo({}, { signal });
  if (info.genesisHash.length !== 32) {
    throw new Error(`节点返回的创世哈希长度为 ${info.genesisHash.length}，应为 32`);
  }
  return {
    chainId: info.chainId,
    genesisHash: info.genesisHash,
    executedHeight: info.executedHeight,
    blockTimeMs: info.blockTimeMs,
  };
}

/** 账户在某市场的设置：自选 IMF（0 = 市场默认）与是否逐仓。 */
export interface MarketSettingSnapshot {
  market: number;
  imfPpm: number;
  isolated: boolean;
}

/** 链上仓位。size / entry 带符号：多为正，空为负。 */
export interface PositionSnapshot {
  market: number;
  side: 'Long' | 'Short' | 'Both';
  size: bigint;
  entry: bigint;
  openBids: bigint;
  openAsks: bigint;
  fundingIndex: bigint;
  /** micro-USD；全仓为 0。 */
  isolatedMargin: bigint;
}

export interface AccountSnapshot {
  accountId: number;
  owner: Uint8Array;
  /** micro-USD。 */
  collateral: bigint;
  equity: bigint;
  marginHeadroom: bigint;
  belowMaintenance: boolean;
  actionsUsed: bigint;
  volumeUsd: bigint;
  lastNonce: bigint;
  openOrders: number;
  executedHeight: bigint;
  settings: MarketSettingSnapshot[];
  positions: PositionSnapshot[];
}

function positionSide(code: number): PositionSnapshot['side'] {
  if (code === 1) return 'Long';
  if (code === 2) return 'Short';
  return 'Both';
}

export function ownerBytes(address: string): Uint8Array {
  const bytes = hexToBytes(strip0x(address));
  if (bytes.length !== 20) throw new Error(`EVM 地址应为 20 字节，收到 ${bytes.length}`);
  return bytes;
}

/** 按 owner 地址查账户；地址从未入金返回 `undefined`。 */
export async function lookupAccountByOwner(
  clients: Pick<ApolloClients, 'account'>,
  owner: string,
  signal?: AbortSignal,
): Promise<AccountSnapshot | undefined> {
  try {
    const r = await clients.account.getAccount(
      { by: { case: 'owner', value: ownerBytes(owner) } },
      { signal },
    );
    return {
      accountId: Number(r.account),
      owner: r.owner,
      collateral: r.collateral,
      equity: r.equity,
      marginHeadroom: r.marginHeadroom,
      belowMaintenance: r.belowMaintenance,
      actionsUsed: r.actionsUsed,
      volumeUsd: r.volumeUsd,
      lastNonce: r.lastNonce,
      openOrders: r.openOrders,
      executedHeight: r.at?.executedHeight ?? 0n,
      settings: r.settings.map((s) => ({ market: s.market, imfPpm: s.imfPpm, isolated: s.isolated })),
      positions: r.positions.map((p) => ({
        market: p.market,
        side: positionSide(p.side),
        size: p.size,
        entry: p.entry,
        openBids: p.openBids,
        openAsks: p.openAsks,
        fundingIndex: p.fundingIndex,
        isolatedMargin: p.isolatedMargin,
      })),
    };
  } catch (error) {
    if (classifyRpcError(error).kind === 'not_found') return undefined;
    throw error;
  }
}

export async function loadAgentSlots(
  clients: Pick<ApolloClients, 'account'>,
  accountId: number,
  signal?: AbortSignal,
): Promise<{ slots: AgentSlotState[]; executedHeight: bigint }> {
  const r = await clients.account.getAgents({ account: BigInt(accountId) }, { signal });
  return {
    slots: r.agents.map((a) => ({ slot: a.slot, key: a.key, seq: a.seq, expiry: a.expiry })),
    executedHeight: r.at?.executedHeight ?? 0n,
  };
}

/** 判断派生 key 的就绪状态（查链上槽位 + 当前高度）。 */
export async function checkAgentReadiness(
  clients: Pick<ApolloClients, 'account'>,
  accountId: number,
  derived: DerivedAgent,
  signal?: AbortSignal,
): Promise<AgentReadiness> {
  const { slots, executedHeight } = await loadAgentSlots(clients, accountId, signal);
  return agentReadiness(derived, slots, executedHeight);
}

/** 钱包的 EIP-712 签名回调（wagmi `signTypedDataAsync` 的形状）。 */
export type SignTypedData = (typedData: ReturnType<typeof ownerTypedData>) => Promise<string>;

export interface SubmitOutcomeDetail {
  nonce: bigint;
  submit: SubmitResult;
  outcome: ActionOutcome;
}

export class ActionRejectedError extends Error {
  constructor(
    public readonly stage: 'submit' | 'execute',
    public readonly detail: string,
    public readonly nonce: bigint,
  ) {
    super(`${stage === 'submit' ? '提交被拒' : '执行失败'}：${detail}`);
    this.name = 'ActionRejectedError';
  }
}

export interface Submitter {
  clients: Pick<ApolloClients, 'tx'>;
  genesisHash: Uint8Array;
  nonces: NonceAllocator;
}

/**
 * owner 签名并提交一个 action，等到执行结果。用于 ApproveAgent / Withdraw / Stake 等只有 owner
 * 能签的动作；每次都会弹钱包。
 */
export async function submitAsOwner(
  submitter: Submitter,
  signTypedData: SignTypedData,
  action: Action,
  options: WaitForActionOptions = {},
): Promise<SubmitOutcomeDetail> {
  const account = accountOf(action);
  const nonce = submitter.nonces.next(account);
  const signature = await signTypedData(ownerTypedData(submitter.genesisHash, action, nonce));
  const auth = ownerAuthFromSignature(nonce, signature);
  return submitSigned(submitter, action, auth, options);
}

/** agent 静默签名并提交；非交易类 action 直接拒绝。 */
export async function submitAsAgent(
  submitter: Submitter,
  signer: AgentSigner,
  action: Action,
  options: WaitForActionOptions = {},
): Promise<SubmitOutcomeDetail> {
  if (!agentMay(action)) {
    throw new ActionRejectedError('submit', `${action.type} 只能由 owner 签名`, 0n);
  }
  const nonce = submitter.nonces.next(accountOf(action));
  const auth = signWithAgent(signer, submitter.genesisHash, action, nonce);
  return submitSigned(submitter, action, auth, options);
}

async function submitSigned(
  submitter: Submitter,
  action: Action,
  auth: Auth,
  options: WaitForActionOptions,
): Promise<SubmitOutcomeDetail> {
  const submit = await submitActions(submitter.clients, [{ action, auth }], { signal: options.signal });
  if (!submit.ok) {
    const first = submit.outcomes[0];
    const detail = first && 'detail' in first ? `${first.kind}: ${first.detail}` : 'unknown';
    throw new ActionRejectedError('submit', detail, auth.nonce);
  }
  const outcome = await waitForAction(
    submitter.clients,
    { account: accountOf(action), nonce: auth.nonce },
    options,
  );
  if (outcome.kind === 'executed' && !outcome.ok) {
    throw new ActionRejectedError('execute', outcome.reject ?? 'Reject', auth.nonce);
  }
  return { nonce: auth.nonce, submit, outcome };
}

/** action 所属的账户；Deposit 是系统 action，不能走 owner / agent 提交。 */
export function accountOf(action: Action): number {
  if (action.type === 'Deposit') {
    throw new ActionRejectedError('submit', 'Deposit 是系统 action，不属于任何账户', 0n);
  }
  return action.account;
}

/** owner 签 ApproveAgent 把派生 key 放进槽位；成功后返回可直接用的 signer（seq 取链上新值）。 */
export async function approveDerivedAgent(
  submitter: Submitter & { clients: Pick<ApolloClients, 'tx' | 'account'> },
  signTypedData: SignTypedData,
  accountId: number,
  derived: DerivedAgent,
  options: WaitForActionOptions & { expiry?: bigint } = {},
): Promise<AgentSigner> {
  await submitAsOwner(
    submitter,
    signTypedData,
    {
      type: 'ApproveAgent',
      account: accountId,
      slot: derived.slot,
      key: derived.publicKey,
      expiry: options.expiry ?? NO_EXPIRY,
    },
    options,
  );
  const readiness = await checkAgentReadiness(submitter.clients, accountId, derived, options.signal);
  if (readiness.kind !== 'ready') {
    throw new Error(`ApproveAgent 已执行但槽位状态为 ${readiness.kind}`);
  }
  return readiness.signer;
}

/** 由 onboarding 签名派生 agent（纯函数包装，便于 React 侧统一入口）。 */
export function deriveAgentFromOnboarding(signature: string | Uint8Array): DerivedAgent {
  return deriveAgent(signature);
}

export function genesisHex(genesisHash: Uint8Array): string {
  return bytesToHex(genesisHash);
}
