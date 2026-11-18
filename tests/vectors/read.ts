// 把协议向量文件里的 action 描述转成 codec 的
// `Action`。64 位值在 JSON 里是十进制字符串。只给测试用。
import { hexToBytes } from '@noble/hashes/utils.js';

import type {
  Action,
  OrderOpts,
  PositionSide,
  ScaledProfile,
  ScaledSpacing,
  Side,
  Tif,
  TriggerKind,
} from '../../src/codec.js';

export interface VectorOpts {
  reduce_only: boolean;
  good_til_block: string;
  trigger: { kind: TriggerKind; price: string } | null;
  builder: { account: number; fee_ppm: number } | null;
  position: PositionSide;
  is_cross: boolean;
}

export type VectorAction = { type: string } & Record<string, unknown>;

export interface Vector {
  name: string;
  action: VectorAction;
  encoded: string;
  nonce: string;
  owner: { digest: string; auth: string };
  agent?: { slot: number; seq: number; message: string; auth: string };
}

export interface VectorFile {
  version: number;
  description: string;
  sizes: { action: number; auth: number; agent_message: number };
  context: string;
  genesis_hash: string;
  eip712: {
    name: string;
    version: string;
    domain_type: string;
    action_type: string;
    domain_separator: string;
  };
  keys: {
    agent_seed: string;
    agent_public: string;
    owner_secret: string;
    owner_address: string;
  };
  actions: Vector[];
  /** 系统签名的 action：Deposit。`key: 0, seq: 0`，消息与 agent 相同。 */
  operator: {
    seed: string;
    public: string;
    actions: OperatorVector[];
  };
}

export interface OperatorVector {
  name: string;
  action: VectorAction;
  encoded: string;
  nonce: string;
  message: string;
  auth: string;
}

function big(value: unknown): bigint {
  if (typeof value !== 'string') throw new Error(`期望十进制字符串，收到 ${String(value)}`);
  return BigInt(value);
}

function num(value: unknown): number {
  if (typeof value !== 'number') throw new Error(`期望数字，收到 ${String(value)}`);
  return value;
}

function str<T extends string>(value: unknown): T {
  if (typeof value !== 'string') throw new Error(`期望字符串，收到 ${String(value)}`);
  return value as T;
}

function opts(value: unknown): OrderOpts {
  const o = value as VectorOpts;
  return {
    reduceOnly: o.reduce_only,
    goodTilBlock: BigInt(o.good_til_block),
    trigger: o.trigger ? { kind: o.trigger.kind, price: BigInt(o.trigger.price) } : undefined,
    builder: o.builder ? { account: o.builder.account, feePpm: o.builder.fee_ppm } : undefined,
    position: o.position,
    isCross: o.is_cross,
  };
}

export function actionFromVector(v: VectorAction): Action {
  if (v.type === 'Deposit') {
    return { type: 'Deposit', address: hexToBytes(str(v.address)), amount: big(v.amount) };
  }
  const account = num(v.account);
  switch (v.type) {
    case 'Withdraw':
      return { type: 'Withdraw', account, amount: big(v.amount) };
    case 'Place':
      return {
        type: 'Place',
        account,
        market: num(v.market),
        side: str<Side>(v.side),
        price: big(v.price),
        size: big(v.size),
        tif: str<Tif>(v.tif),
        position: str<PositionSide>(v.position),
        isCross: v.is_cross === true,
      };
    case 'Cancel':
      return { type: 'Cancel', account, market: num(v.market), orderId: big(v.order_id) };
    case 'Modify':
      return {
        type: 'Modify',
        account,
        market: num(v.market),
        orderId: big(v.order_id),
        price: big(v.price),
        size: big(v.size),
      };
    case 'Stake':
    case 'Unstake':
      return { type: v.type, account, validator: num(v.validator), amount: big(v.amount) };
    case 'ApproveAgent':
      return {
        type: 'ApproveAgent',
        account,
        slot: num(v.slot),
        key: hexToBytes(str(v.key)),
        expiry: big(v.expiry),
      };
    case 'RevokeAgent':
      return { type: 'RevokeAgent', account, slot: num(v.slot) };
    case 'PlaceWith':
      return {
        type: 'PlaceWith',
        account,
        market: num(v.market),
        side: str<Side>(v.side),
        price: big(v.price),
        size: big(v.size),
        tif: str<Tif>(v.tif),
        opts: opts(v.opts),
      };
    case 'CancelAll':
      return { type: 'CancelAll', account, market: num(v.market) };
    case 'SetLeverage':
      return { type: 'SetLeverage', account, market: num(v.market), imfPpm: num(v.imf_ppm) };
    case 'UpdateIsolatedMargin':
      return {
        type: 'UpdateIsolatedMargin',
        account,
        market: num(v.market),
        position: str<PositionSide>(v.position),
        amount: big(v.amount),
      };
    case 'PlaceTwap':
      return {
        type: 'PlaceTwap',
        account,
        market: num(v.market),
        side: str<Side>(v.side),
        price: big(v.price),
        size: big(v.size),
        durationS: num(v.duration_s),
        intervalS: num(v.interval_s),
        tolerancePpm: num(v.tolerance_ppm),
        position: str<PositionSide>(v.position),
        isCross: v.is_cross === true,
      };
    case 'PlaceScaled': {
      const p = v.params as Record<string, unknown>;
      return {
        type: 'PlaceScaled',
        account,
        market: num(v.market),
        side: str<Side>(v.side),
        size: big(v.size),
        tif: str<Tif>(v.tif),
        opts: opts(v.opts),
        params: {
          lowestPrice: big(p.lowest_price),
          highestPrice: big(p.highest_price),
          numOrders: num(p.num_orders),
          profile: str<ScaledProfile>(p.profile),
          spacing: str<ScaledSpacing>(p.spacing),
          magnitudePpm: num(p.magnitude_ppm),
        },
      };
    }
    default:
      throw new Error(`向量里有未知 action 类型 ${v.type}`);
  }
}
