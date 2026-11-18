// 仅提供 HTTP JSON-RPC 传输。
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient, type Client, type Transport } from '@connectrpc/connect';
import { type Action, encodeAction } from './codec.js';
import { type Auth, encodeAuth } from './auth.js';
import { AccountService } from './gen/apollo/v1/account_pb.js';
import { ChainService } from './gen/apollo/v1/chain_pb.js';
import { HistoryService } from './gen/apollo/v1/history_pb.js';
import { MarketService } from './gen/apollo/v1/market_pb.js';
import {
  ActionState,
  SubmitRequestSchema,
  SubmitStatus,
  type SubmitResponse,
  TxService,
} from './gen/apollo/v1/tx_pb.js';
import { createApolloJsonRpcTransport, type JsonRpcTransportOptions } from './jsonrpc.js';

export interface ApolloClients {
  transport: Transport;
  tx: Client<typeof TxService>;
  account: Client<typeof AccountService>;
  market: Client<typeof MarketService>;
  chain: Client<typeof ChainService>;
  history: Client<typeof HistoryService>;
}
export interface ApolloTransportOptions extends JsonRpcTransportOptions {
  protocol?: 'jsonrpc';
}
/** 本 SDK 仅连接节点 HTTP(S) JSON-RPC。 */
export function inferApolloRpcProtocol(_baseUrl: string): 'jsonrpc' {
  return 'jsonrpc';
}
export function createApolloTransport(options: ApolloTransportOptions): Transport {
  if (options.protocol !== undefined && options.protocol !== 'jsonrpc') {
    throw new TypeError('This SDK only supports HTTP JSON-RPC');
  }
  return createApolloJsonRpcTransport(options);
}
export function createApolloClients(options: ApolloTransportOptions): ApolloClients {
  const transport = createApolloTransport(options);
  return {
    transport,
    tx: createClient(TxService, transport),
    account: createClient(AccountService, transport),
    market: createClient(MarketService, transport),
    chain: createClient(ChainService, transport),
    history: createClient(HistoryService, transport),
  };
}

// ───────────────────────── 提交 ─────────────────────────

export interface SignedAction {
  action: Action;
  auth: Auth;
}

export type SubmitOutcome =
  /** 已接收，将被执行；执行结果另查 GetActionStatus。 */
  | { kind: 'accepted' }
  /** action 或 auth 字节无法解码——客户端编码错误，不可重试。 */
  | { kind: 'malformed'; detail: string }
  /** 签名对不上账户的 key：owner 不符、agent 槽位 / seq 过期、nonce 已用等。 */
  | { kind: 'bad_signature'; detail: string }
  /** 暂时无法接收：可重试。 */
  | { kind: 'unavailable'; detail: string };

export interface SubmitResult {
  id: bigint;
  outcomes: SubmitOutcome[];
  /** 全部 accepted 时为 true。 */
  ok: boolean;
  /** 每个请求项对应一个哈希；未接入项为空，绝不将哈希当成执行成功。 */
  transactionHashes: Uint8Array[];
}

let submitSequence = 0n;

/**
 * 提交一批已签名 action（单批上限 20,000 条）。
 * 返回时 action 已被接收或被拒；执行是否成功要等区块，用 `waitForActions`。
 */
export async function submitActions(
  clients: Pick<ApolloClients, 'tx'>,
  signed: readonly SignedAction[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SubmitResult> {
  if (signed.length === 0 || signed.length > 20_000)
    throw new RangeError('submitActions requires 1..20000 signed actions');
  submitSequence += 1n;
  const request = create(SubmitRequestSchema, {
    id: submitSequence,
    actions: signed.map(({ action, auth }) => ({
      action: encodeAction(action),
      auth: encodeAuth(auth),
    })),
  });
  const response = await clients.tx.submit(request, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (response.id !== request.id || response.statuses.length !== signed.length) {
    throw new ConnectError(
      'Submit response id or item count mismatch; execution outcome is unknown',
      Code.Internal,
    );
  }
  if (response.transactionHashes.length !== 0 && response.transactionHashes.length !== signed.length) {
    throw new ConnectError('Submit transaction hash count mismatch', Code.Internal);
  }
  return interpretSubmitResponse(response);
}

export function interpretSubmitResponse(response: SubmitResponse): SubmitResult {
  const outcomes = response.statuses.map((status): SubmitOutcome => {
    switch (status) {
      case SubmitStatus.ACCEPTED:
        return { kind: 'accepted' };
      case SubmitStatus.MALFORMED:
        return { kind: 'malformed', detail: response.detail };
      case SubmitStatus.BAD_SIGNATURE:
        return { kind: 'bad_signature', detail: response.detail };
      case SubmitStatus.UNAVAILABLE:
        return { kind: 'unavailable', detail: response.detail };
      default:
        throw new ConnectError('Unknown Submit status; execution outcome is unknown', Code.Internal);
    }
  });
  return {
    id: response.id,
    outcomes,
    transactionHashes: response.transactionHashes.map((hash) => Uint8Array.from(hash)),
    ok: outcomes.length > 0 && outcomes.every((o) => o.kind === 'accepted'),
  };
}

// ───────────────────────── 执行结果 ─────────────────────────

export type ActionOutcome =
  /** 该节点尚未执行到它：还在路上，或根本没发出。 */
  | { kind: 'pending' }
  | {
      kind: 'executed';
      height: bigint;
      ok: boolean;
      /** 失败原因，如 InsufficientMargin、BadNonce。 */
      reject?: string;
      /** Place / Modify 创建的订单 id（即 nonce）。 */
      orderId?: bigint;
      fills: number;
    }
  /** nonce 已被用过，但节点不再保留结果（超出 action_index 窗口）。 */
  | { kind: 'nonce_used' };

export async function getActionOutcomes(
  clients: Pick<ApolloClients, 'tx'>,
  keys: readonly { account: number; nonce: bigint }[],
  options: { signal?: AbortSignal } = {},
): Promise<{ executedHeight: bigint; outcomes: ActionOutcome[] }> {
  const response = await clients.tx.getActionStatus(
    { keys: keys.map((k) => ({ account: BigInt(k.account), nonce: k.nonce })) },
    { signal: options.signal },
  );
  if (
    response.statuses.length !== keys.length ||
    response.statuses.some(
      (s, i) => s.key?.account !== BigInt(keys[i].account) || s.key.nonce !== keys[i].nonce,
    )
  ) {
    throw new ConnectError('Action status response keys do not match the request', Code.Internal);
  }
  const outcomes = response.statuses.map((s): ActionOutcome => {
    switch (s.state) {
      case ActionState.EXECUTED:
        return {
          kind: 'executed',
          height: s.height,
          ok: s.ok,
          reject: s.ok ? undefined : s.reject,
          orderId: s.orderId,
          fills: s.fills,
        };
      case ActionState.NONCE_USED:
        return { kind: 'nonce_used' };
      case ActionState.NOT_FOUND:
        return { kind: 'pending' };
      default:
        throw new ConnectError('Unknown action execution state', Code.Internal);
    }
  });
  return { executedHeight: response.at?.executedHeight ?? 0n, outcomes };
}

export interface WaitForActionOptions {
  /** 轮询间隔（毫秒）；块时间量级即可。 */
  intervalMs?: number;
  /** 总等待上限（毫秒）；超时返回 pending，由调用方决定是保留乐观状态还是提示。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 轮询一个 action 的执行结果直到不再 pending 或超时。Submit 返回 accepted 只保证会被排序，
 * 真正的成功 / Reject 要在这里拿到；订单 id 等于 nonce，提交前就已知。
 */
export async function waitForAction(
  clients: Pick<ApolloClients, 'tx'>,
  key: { account: number; nonce: bigint },
  options: WaitForActionOptions = {},
): Promise<ActionOutcome> {
  const intervalMs = options.intervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > 2_147_483_647 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new RangeError('intervalMs and timeoutMs must be positive');
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new ConnectError('Execution wait deadline exceeded', Code.DeadlineExceeded));
  }, timeoutMs);
  try {
    for (;;) {
      const { outcomes } = await getActionOutcomes(clients, [key], { signal: controller.signal });
      const outcome = outcomes[0];
      if (outcome.kind !== 'pending') return outcome;
      await sleep(intervalMs, controller.signal);
    }
  } catch (error) {
    if (expired && !options.signal?.aborted) return { kind: 'pending' };
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ───────────────────────── 错误归类 ─────────────────────────

export type ApolloRpcErrorKind =
  | 'unavailable'
  | 'not_found'
  | 'invalid_argument'
  | 'rate_limited'
  | 'unsupported_here'
  | 'timeout'
  | 'canceled'
  | 'unknown';

/** connect-web 把 fetch 的网络失败包成 Code.Unknown；按浏览器的几种措辞识别出来。 */
const NETWORK_FAILURE = /failed to fetch|networkerror|network error|load failed|network request failed/i;

/** 把 connect 的错误码归为 UI 能处理的几类；非 ConnectError（断网等）归为 unavailable。 */
export function classifyRpcError(error: unknown): { kind: ApolloRpcErrorKind; message: string } {
  if (error instanceof ConnectError) {
    switch (error.code) {
      case Code.Unavailable:
        return { kind: 'unavailable', message: error.rawMessage };
      case Code.Unknown:
        if (NETWORK_FAILURE.test(error.rawMessage)) {
          return { kind: 'unavailable', message: error.rawMessage };
        }
        return { kind: 'unknown', message: error.rawMessage };
      case Code.NotFound:
        return { kind: 'not_found', message: error.rawMessage };
      case Code.InvalidArgument:
      case Code.OutOfRange:
        return { kind: 'invalid_argument', message: error.rawMessage };
      case Code.ResourceExhausted:
        return { kind: 'rate_limited', message: error.rawMessage };
      // 历史服务只在归档节点上有；未启用的服务返回 Unimplemented。
      case Code.FailedPrecondition:
      case Code.Unimplemented:
        return { kind: 'unsupported_here', message: error.rawMessage };
      case Code.DeadlineExceeded:
        return { kind: 'timeout', message: error.rawMessage };
      case Code.Canceled:
        return { kind: 'canceled', message: error.rawMessage };
      default:
        return { kind: 'unknown', message: error.rawMessage };
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { kind: 'canceled', message: error.message };
  }
  return {
    kind: 'unavailable',
    message: error instanceof Error ? error.message : String(error),
  };
}
