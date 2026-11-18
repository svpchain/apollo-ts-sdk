import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import { encodeAuth, signWithAgent, createAgentSigner } from '../src/auth.js';
import { type Action, encodeAction } from '../src/codec.js';
import {
  ActionState,
  type GetActionStatusRequest,
  GetActionStatusResponseSchema,
  type SubmitRequest,
  SubmitResponseSchema,
  SubmitStatus,
} from '../src/gen/apollo/v1/tx_pb.js';
import {
  classifyRpcError,
  getActionOutcomes,
  interpretSubmitResponse,
  submitActions,
  waitForAction,
} from '../src/transport.js';

const place: Action = {
  type: 'Place',
  account: 7,
  market: 0,
  side: 'Bid',
  price: 100n,
  size: 10n,
  tif: 'Gtc',
  position: 'Long',
  isCross: true,
};

describe('submitActions', () => {
  it('把编码后的 action/auth 放进请求并解读状态', async () => {
    const genesis = new Uint8Array(32).fill(3);
    const signer = createAgentSigner(new Uint8Array(32).fill(1), 1, 0);
    const auth = signWithAgent(signer, genesis, place, 42n);
    let seen: SubmitRequest | undefined;
    const tx = {
      submit: async (req: SubmitRequest) => {
        seen = req;
        return create(SubmitResponseSchema, {
          id: req.id,
          statuses: [SubmitStatus.ACCEPTED],
        });
      },
    };
    const result = await submitActions({ tx } as never, [{ action: place, auth }]);
    expect(result.ok).toBe(true);
    expect(result.outcomes).toEqual([{ kind: 'accepted' }]);
    expect(seen?.actions).toHaveLength(1);
    expect(seen?.actions[0].action).toEqual(encodeAction(place));
    expect(seen?.actions[0].auth).toEqual(encodeAuth(auth));
    expect(result.id).toBe(seen?.id);
  });

  it('非 accepted 的状态带上 detail', () => {
    const result = interpretSubmitResponse(
      create(SubmitResponseSchema, {
        id: 1n,
        statuses: [
          SubmitStatus.ACCEPTED,
          SubmitStatus.BAD_SIGNATURE,
          SubmitStatus.UNAVAILABLE,
          SubmitStatus.MALFORMED,
        ],
        detail: 'why',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.outcomes.map((o) => o.kind)).toEqual([
      'accepted',
      'bad_signature',
      'unavailable',
      'malformed',
    ]);
    expect(interpretSubmitResponse(create(SubmitResponseSchema, { id: 1n, statuses: [] })).ok).toBe(false);
  });
});

describe('执行结果', () => {
  it('把 ActionStatus 映射成 outcome', async () => {
    const tx = {
      getActionStatus: async (req: GetActionStatusRequest) =>
        create(GetActionStatusResponseSchema, {
          at: { executedHeight: 99n },
          statuses: [
            { key: req.keys[0], state: ActionState.EXECUTED, height: 98n, ok: true, orderId: 42n, fills: 2 },
            {
              key: req.keys[1],
              state: ActionState.EXECUTED,
              height: 98n,
              ok: false,
              reject: 'InsufficientMargin',
            },
            { key: req.keys[2], state: ActionState.NOT_FOUND },
            { key: req.keys[3], state: ActionState.NONCE_USED },
          ],
        }),
    };
    const { executedHeight, outcomes } = await getActionOutcomes({ tx } as never, [
      { account: 7, nonce: 42n },
      { account: 7, nonce: 43n },
      { account: 7, nonce: 44n },
      { account: 7, nonce: 1n },
    ]);
    expect(executedHeight).toBe(99n);
    expect(outcomes[0]).toEqual({
      kind: 'executed',
      height: 98n,
      ok: true,
      reject: undefined,
      orderId: 42n,
      fills: 2,
    });
    expect(outcomes[1]).toMatchObject({ kind: 'executed', ok: false, reject: 'InsufficientMargin' });
    expect(outcomes[2]).toEqual({ kind: 'pending' });
    expect(outcomes[3]).toEqual({ kind: 'nonce_used' });
  });

  it('waitForAction 轮询到执行或超时', async () => {
    let calls = 0;
    const tx = {
      getActionStatus: async (req: GetActionStatusRequest) => {
        calls += 1;
        return create(GetActionStatusResponseSchema, {
          statuses: [
            calls < 3
              ? { key: req.keys[0], state: ActionState.NOT_FOUND }
              : { key: req.keys[0], state: ActionState.EXECUTED, height: 5n, ok: true, orderId: 42n },
          ],
        });
      },
    };
    const outcome = await waitForAction({ tx } as never, { account: 7, nonce: 42n }, { intervalMs: 1 });
    expect(outcome).toMatchObject({ kind: 'executed', orderId: 42n });
    expect(calls).toBe(3);

    const never = {
      getActionStatus: async (req: GetActionStatusRequest) =>
        create(GetActionStatusResponseSchema, {
          statuses: [{ key: req.keys[0], state: ActionState.NOT_FOUND }],
        }),
    };
    const pending = await waitForAction(
      { tx: never } as never,
      { account: 7, nonce: 1n },
      { intervalMs: 1, timeoutMs: 5 },
    );
    expect(pending).toEqual({ kind: 'pending' });
  });
});

describe('classifyRpcError', () => {
  it('按 connect 错误码归类，其他错误视为不可用', () => {
    expect(classifyRpcError(new ConnectError('x', Code.Unavailable)).kind).toBe('unavailable');
    expect(classifyRpcError(new ConnectError('x', Code.NotFound)).kind).toBe('not_found');
    expect(classifyRpcError(new ConnectError('x', Code.ResourceExhausted)).kind).toBe('rate_limited');
    expect(classifyRpcError(new ConnectError('x', Code.FailedPrecondition)).kind).toBe('unsupported_here');
    expect(classifyRpcError(new ConnectError('x', Code.Unimplemented)).kind).toBe('unsupported_here');
    expect(classifyRpcError(new ConnectError('x', Code.DeadlineExceeded)).kind).toBe('timeout');
    expect(classifyRpcError(new TypeError('Failed to fetch'))).toEqual({
      kind: 'unavailable',
      message: 'Failed to fetch',
    });
  });
});
