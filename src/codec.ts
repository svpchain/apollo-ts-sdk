// Apollo action 的 48 字节定长编码与解码。
//
// 这是签名与提交的字节真值：编码错一位，要么 BAD_SIGNATURE，要么签到另一个动作。
// 正确性由 `codec.test.ts` 用 `vectors/actions.json` 中的协议向量逐字节比对保证。
//
// 单位沿用链的整数口径：price 为 subticks、size 为 base quantums、金额为 micro-USD，
// 全部以 bigint 承载，不经 number 中转。

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const ACTION_BYTES = 48;
/** `CancelAll` 对所有市场生效时的 market 值（0xFFFF）。 */
export const ALL_MARKETS = 0xffff;
/** builder 费率上限，ppm。 */
export const MAX_BUILDER_FEE_PPM = 10_000;

export type Side = 'Bid' | 'Ask';
export type Tif = 'Gtc' | 'Ioc' | 'PostOnly';
/** 账户在每个市场有多空两个对冲槽位；`Both` 为系统保留，用户订单不得使用。 */
export type PositionSide = 'Both' | 'Long' | 'Short';
export type TriggerKind = 'StopLoss' | 'TakeProfit';
export type ScaledProfile = 'Equal' | 'IncRatio' | 'IncDiff' | 'DecRatio' | 'DecDiff';
export type ScaledSpacing = 'Linear' | 'Geometric';

export interface Trigger {
  kind: TriggerKind;
  /** subticks，与向下取整到 subticks 的 oracle 价比较。 */
  price: bigint;
}

export interface BuilderCode {
  account: number;
  /** 每笔成交额外支付给 builder 的费率，ppm，链侧上限 10_000。 */
  feePpm: number;
}

/** `PlaceWith` / `PlaceScaled` 的订单选项。 */
export interface OrderOpts {
  reduceOnly: boolean;
  /** 订单可挂在簿上的最后高度；0 表示不过期。 */
  goodTilBlock: bigint;
  trigger?: Trigger;
  builder?: BuilderCode;
  position: PositionSide;
  /** true 全仓，false 逐仓；市场空闲时写入账户的该市场设置。 */
  isCross: boolean;
}

export interface ScaledParams {
  lowestPrice: bigint;
  highestPrice: bigint;
  /** 子单数量，编码为 u8。 */
  numOrders: number;
  profile: ScaledProfile;
  spacing: ScaledSpacing;
  magnitudePpm: number;
}

/**
 * 可编码的 action。除 `Deposit` 外都是用户 action（owner 或 agent 签）；
 * `Deposit` 是入金记录，出现在历史中，用户不能签。
 */
export type Action =
  | { type: 'Deposit'; address: Uint8Array; amount: bigint }
  | { type: 'Withdraw'; account: number; amount: bigint }
  | {
      type: 'Place';
      account: number;
      market: number;
      side: Side;
      price: bigint;
      size: bigint;
      tif: Tif;
      position: PositionSide;
      isCross: boolean;
    }
  | { type: 'Cancel'; account: number; market: number; orderId: bigint }
  | { type: 'Modify'; account: number; market: number; orderId: bigint; price: bigint; size: bigint }
  | { type: 'Stake'; account: number; validator: number; amount: bigint }
  | { type: 'Unstake'; account: number; validator: number; amount: bigint }
  | { type: 'ApproveAgent'; account: number; slot: number; key: Uint8Array; expiry: bigint }
  | { type: 'RevokeAgent'; account: number; slot: number }
  | {
      type: 'PlaceWith';
      account: number;
      market: number;
      side: Side;
      price: bigint;
      size: bigint;
      tif: Tif;
      opts: OrderOpts;
    }
  | { type: 'CancelAll'; account: number; market: number }
  | { type: 'SetLeverage'; account: number; market: number; imfPpm: number }
  | {
      type: 'UpdateIsolatedMargin';
      account: number;
      market: number;
      position: PositionSide;
      /** 正数从全仓划入逐仓，负数划出。 */
      amount: bigint;
    }
  | {
      type: 'PlaceTwap';
      account: number;
      market: number;
      side: Side;
      /** 0 表示每条子单按 oracle 价加 tolerance 下单。 */
      price: bigint;
      size: bigint;
      durationS: number;
      intervalS: number;
      tolerancePpm: number;
      position: PositionSide;
      isCross: boolean;
    }
  | {
      type: 'PlaceScaled';
      account: number;
      market: number;
      side: Side;
      size: bigint;
      tif: Tif;
      opts: OrderOpts;
      params: ScaledParams;
    };

export type ActionType = Action['type'];

/** 允许 agent key 签名的 action；其余（提现、质押、密钥管理）只有 owner 可签。 */
export function agentMay(action: Action): boolean {
  switch (action.type) {
    case 'Place':
    case 'PlaceWith':
    case 'Cancel':
    case 'CancelAll':
    case 'Modify':
    case 'SetLeverage':
    case 'UpdateIsolatedMargin':
    case 'PlaceTwap':
    case 'PlaceScaled':
      return true;
    default:
      return false;
  }
}

const SIDE: Record<Side, number> = { Bid: 0, Ask: 1 };
const TIF: Record<Tif, number> = { Gtc: 0, Ioc: 1, PostOnly: 2 };
const POSITION: Record<PositionSide, number> = { Both: 0, Long: 1, Short: 2 };
const PROFILE: Record<ScaledProfile, number> = {
  Equal: 0,
  IncRatio: 1,
  IncDiff: 2,
  DecRatio: 3,
  DecDiff: 4,
};
const SPACING: Record<ScaledSpacing, number> = { Linear: 0, Geometric: 1 };

const SIDES: Side[] = ['Bid', 'Ask'];
const TIFS: Tif[] = ['Gtc', 'Ioc', 'PostOnly'];
const POSITIONS: PositionSide[] = ['Both', 'Long', 'Short'];
const PROFILES: ScaledProfile[] = ['Equal', 'IncRatio', 'IncDiff', 'DecRatio', 'DecDiff'];
const SPACINGS: ScaledSpacing[] = ['Linear', 'Geometric'];

const U8_MAX = 0xff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export class ActionEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionEncodeError';
  }
}

function checkUint(value: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ActionEncodeError(`${field} 必须是 0..${max} 的整数，收到 ${value}`);
  }
  return value;
}

function checkU64(value: bigint, field: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new ActionEncodeError(`${field} 必须是 u64 范围的 bigint，收到 ${String(value)}`);
  }
  return value;
}

function checkI64(value: bigint, field: string): bigint {
  if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) {
    throw new ActionEncodeError(`${field} 必须是 i64 范围的 bigint，收到 ${String(value)}`);
  }
  return value;
}

/** 小端写入 64 位整数；负数按补码。 */
function writeI64(view: DataView, offset: number, value: bigint): void {
  view.setBigInt64(offset, value, true);
}

function writeU64(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

function bool(value: boolean): number {
  if (typeof value !== 'boolean') throw new ActionEncodeError('flag must be a boolean');
  return value ? 1 : 0;
}

function enumValue<T extends string>(table: Record<T, number>, value: T): number {
  if (!Object.hasOwn(table, value)) throw new ActionEncodeError(`Unknown enum value: ${String(value)}`);
  return table[value];
}

function writeOrderOptsFlagsForPlaceWith(opts: OrderOpts): number {
  // b[3] = reduce_only | trigger(2 | take_profit << 2) | position << 3 | is_cross << 5
  let flags = bool(opts.reduceOnly);
  if (opts.trigger) {
    if (!['StopLoss', 'TakeProfit'].includes(opts.trigger.kind))
      throw new ActionEncodeError('Unknown trigger kind');
    flags |= 2 | (bool(opts.trigger.kind === 'TakeProfit') << 2);
  }
  flags |= enumValue(POSITION, opts.position) << 3;
  flags |= bool(opts.isCross) << 5;
  return flags;
}

/**
 * 把一个用户 action 编码为 48 字节。
 *
 * 字段范围越界直接抛 `ActionEncodeError`，而不是静默截断——截断后的字节仍能被链解码成
 * 另一笔合法 action，是最危险的失败方式。
 */
export function encodeAction(action: Action): Uint8Array {
  const b = new Uint8Array(ACTION_BYTES);
  const view = new DataView(b.buffer);
  const account = (id: number) => view.setUint32(4, checkUint(id, U32_MAX, 'account'), true);
  const market = (id: number) => view.setUint16(8, checkUint(id, U16_MAX, 'market'), true);
  const price = (v: bigint) => writeI64(view, 32, checkI64(v, 'price'));
  const size = (v: bigint) => writeI64(view, 40, checkI64(v, 'size'));

  switch (action.type) {
    case 'Deposit':
      b[0] = 1;
      if (action.address.length !== 20) {
        throw new ActionEncodeError(`address 必须是 20 字节，收到 ${action.address.length}`);
      }
      b.set(action.address, 16);
      writeI64(view, 40, checkI64(action.amount, 'amount'));
      break;
    case 'Withdraw':
      b[0] = 2;
      account(action.account);
      writeI64(view, 40, checkI64(action.amount, 'amount'));
      break;
    case 'Place':
      b[0] = 3;
      b[1] = enumValue(SIDE, action.side);
      b[2] = enumValue(TIF, action.tif);
      b[3] = enumValue(POSITION, action.position) | (bool(action.isCross) << 2);
      account(action.account);
      market(action.market);
      price(action.price);
      size(action.size);
      break;
    case 'Cancel':
      b[0] = 4;
      account(action.account);
      market(action.market);
      writeU64(view, 16, checkU64(action.orderId, 'orderId'));
      break;
    case 'Modify':
      b[0] = 5;
      account(action.account);
      market(action.market);
      writeU64(view, 16, checkU64(action.orderId, 'orderId'));
      price(action.price);
      size(action.size);
      break;
    case 'Stake':
    case 'Unstake':
      b[0] = action.type === 'Stake' ? 8 : 9;
      account(action.account);
      // validator id 占 market 的两个字节。
      view.setUint16(8, checkUint(action.validator, U16_MAX, 'validator'), true);
      writeI64(view, 40, checkI64(action.amount, 'amount'));
      break;
    case 'ApproveAgent':
      b[0] = 10;
      b[3] = checkUint(action.slot, U8_MAX, 'slot');
      account(action.account);
      writeU64(view, 8, checkU64(action.expiry, 'expiry'));
      if (action.key.length !== 32) {
        throw new ActionEncodeError(`agent key 必须是 32 字节，收到 ${action.key.length}`);
      }
      b.set(action.key, 16);
      break;
    case 'RevokeAgent':
      b[0] = 11;
      b[3] = checkUint(action.slot, U8_MAX, 'slot');
      account(action.account);
      break;
    case 'UpdateIsolatedMargin':
      b[0] = 18;
      b[3] = enumValue(POSITION, action.position);
      account(action.account);
      market(action.market);
      writeI64(view, 40, checkI64(action.amount, 'amount'));
      break;
    case 'PlaceWith': {
      const { opts } = action;
      b[0] = 19;
      b[1] = enumValue(SIDE, action.side);
      b[2] = enumValue(TIF, action.tif);
      b[3] = writeOrderOptsFlagsForPlaceWith(opts);
      account(action.account);
      market(action.market);
      if (opts.builder) {
        // fee_ppm == 0 表示「没有 builder」，此时 account 必须为 0；上限 MAX_BUILDER_FEE_PPM。
        if (opts.builder.feePpm < 1 || opts.builder.feePpm > MAX_BUILDER_FEE_PPM) {
          throw new ActionEncodeError(
            `builder.feePpm 必须在 1..${MAX_BUILDER_FEE_PPM}，收到 ${opts.builder.feePpm}`,
          );
        }
        view.setUint32(10, checkUint(opts.builder.account, U32_MAX, 'builder.account'), true);
        view.setUint16(14, checkUint(opts.builder.feePpm, MAX_BUILDER_FEE_PPM, 'builder.feePpm'), true);
      }
      writeU64(view, 16, checkU64(opts.goodTilBlock, 'goodTilBlock'));
      writeI64(view, 24, opts.trigger ? checkI64(opts.trigger.price, 'trigger.price') : 0n);
      price(action.price);
      size(action.size);
      break;
    }
    case 'CancelAll':
      b[0] = 20;
      account(action.account);
      market(action.market);
      break;
    case 'SetLeverage':
      b[0] = 21;
      account(action.account);
      market(action.market);
      view.setUint32(16, checkUint(action.imfPpm, U32_MAX, 'imfPpm'), true);
      break;
    case 'PlaceTwap':
      b[0] = 22;
      b[1] = enumValue(SIDE, action.side);
      b[3] = enumValue(POSITION, action.position) | (bool(action.isCross) << 2);
      account(action.account);
      market(action.market);
      view.setUint32(16, checkUint(action.durationS, U32_MAX, 'durationS'), true);
      view.setUint32(20, checkUint(action.intervalS, U32_MAX, 'intervalS'), true);
      view.setUint32(24, checkUint(action.tolerancePpm, U32_MAX, 'tolerancePpm'), true);
      price(action.price);
      size(action.size);
      break;
    case 'PlaceScaled': {
      const { opts, params } = action;
      if (opts.trigger || opts.builder)
        throw new ActionEncodeError('Scaled orders cannot encode trigger or builder options');
      b[0] = 23;
      b[1] = enumValue(SIDE, action.side);
      b[2] = enumValue(TIF, action.tif);
      // b[3] = profile | spacing << 3 | reduce_only << 4 | position << 5 | is_cross << 7
      b[3] =
        enumValue(PROFILE, params.profile) |
        (enumValue(SPACING, params.spacing) << 3) |
        (bool(opts.reduceOnly) << 4) |
        (enumValue(POSITION, opts.position) << 5) |
        (bool(opts.isCross) << 7);
      account(action.account);
      market(action.market);
      b[10] = checkUint(params.numOrders, U8_MAX, 'numOrders');
      view.setUint32(12, checkUint(params.magnitudePpm, U32_MAX, 'magnitudePpm'), true);
      writeU64(view, 16, checkU64(opts.goodTilBlock, 'goodTilBlock'));
      writeI64(view, 24, checkI64(params.lowestPrice, 'lowestPrice'));
      writeI64(view, 32, checkI64(params.highestPrice, 'highestPrice'));
      size(action.size);
      break;
    }
    default: {
      const never: never = action;
      throw new ActionEncodeError(`未知 action: ${JSON.stringify(never)}`);
    }
  }
  return b;
}

export class ActionDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionDecodeError';
  }
}

function enumAt<T>(table: T[], value: number, field: string): T {
  const item = table[value];
  if (item === undefined) throw new ActionDecodeError(`${field} 值 ${value} 不合法`);
  return item;
}

/**
 * 解码链上（如 `HistoricAction.action`）的 48 字节 action。
 * 用户 action 与 `Deposit` 解出结构；其余系统 action 返回 `undefined`，由调用方按 kind 处理。
 */
export function decodeAction(bytes: Uint8Array): Action | undefined {
  if (bytes.length < ACTION_BYTES) {
    throw new ActionDecodeError(`action 至少 ${ACTION_BYTES} 字节，收到 ${bytes.length}`);
  }
  const b = bytes.subarray(0, ACTION_BYTES);
  const view = new DataView(b.buffer, b.byteOffset, ACTION_BYTES);
  const account = view.getUint32(4, true);
  const market = view.getUint16(8, true);
  const i64 = (offset: number) => view.getBigInt64(offset, true);
  const u64 = (offset: number) => view.getBigUint64(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const side = () => enumAt(SIDES, b[1], 'side');
  const tif = () => enumAt(TIFS, b[2], 'tif');
  const position = (v: number) => enumAt(POSITIONS, v, 'position');

  switch (b[0]) {
    case 1:
      return { type: 'Deposit', address: b.slice(16, 36), amount: i64(40) };
    case 2:
      return { type: 'Withdraw', account, amount: i64(40) };
    case 3:
      if ((b[3] & ~0x7) !== 0) throw new ActionDecodeError('Place 标志位有保留位被置位');
      return {
        type: 'Place',
        account,
        market,
        side: side(),
        price: i64(32),
        size: i64(40),
        tif: tif(),
        position: position(b[3] & 0b11),
        isCross: ((b[3] >> 2) & 1) === 1,
      };
    case 4:
      return { type: 'Cancel', account, market, orderId: u64(16) };
    case 5:
      return { type: 'Modify', account, market, orderId: u64(16), price: i64(32), size: i64(40) };
    case 8:
      return { type: 'Stake', account, validator: market, amount: i64(40) };
    case 9:
      return { type: 'Unstake', account, validator: market, amount: i64(40) };
    case 10:
      return {
        type: 'ApproveAgent',
        account,
        slot: b[3],
        key: b.slice(16, 48),
        expiry: u64(8),
      };
    case 11:
      return { type: 'RevokeAgent', account, slot: b[3] };
    case 18:
      return {
        type: 'UpdateIsolatedMargin',
        account,
        market,
        position: position(b[3]),
        amount: i64(40),
      };
    case 19: {
      const flags = b[3];
      const hasTrigger = (flags & 2) !== 0;
      const triggerPrice = i64(24);
      // 保留位、无触发却带触发信息、有 builder 账户却无费率，都是坏编码。
      if ((flags & ~0x3f) !== 0 || (!hasTrigger && (((flags >> 2) & 1) === 1 || triggerPrice !== 0n))) {
        throw new ActionDecodeError('PlaceWith 标志位或触发价不合法');
      }
      const builderAccount = u32(10);
      const builderFee = view.getUint16(14, true);
      if (builderFee === 0 && builderAccount !== 0) {
        throw new ActionDecodeError('PlaceWith 的 builder 费率为 0 但账户非 0');
      }
      return {
        type: 'PlaceWith',
        account,
        market,
        side: side(),
        price: i64(32),
        size: i64(40),
        tif: tif(),
        opts: {
          reduceOnly: (flags & 1) === 1,
          goodTilBlock: u64(16),
          trigger: hasTrigger
            ? { kind: ((flags >> 2) & 1) === 1 ? 'TakeProfit' : 'StopLoss', price: triggerPrice }
            : undefined,
          builder: builderFee !== 0 ? { account: builderAccount, feePpm: builderFee } : undefined,
          position: position((flags >> 3) & 0b11),
          isCross: ((flags >> 5) & 1) === 1,
        },
      };
    }
    case 20:
      return { type: 'CancelAll', account, market };
    case 21:
      if (u32(20) !== 0) throw new ActionDecodeError('SetLeverage 保留字节非零');
      return { type: 'SetLeverage', account, market, imfPpm: u32(16) };
    case 22:
      if ((b[3] & ~0x7) !== 0) throw new ActionDecodeError('PlaceTwap 标志位有保留位被置位');
      return {
        type: 'PlaceTwap',
        account,
        market,
        side: side(),
        price: i64(32),
        size: i64(40),
        durationS: u32(16),
        intervalS: u32(20),
        tolerancePpm: u32(24),
        position: position(b[3] & 0b11),
        isCross: ((b[3] >> 2) & 1) === 1,
      };
    case 23: {
      const flags = b[3];
      if (b[11] !== 0) throw new ActionDecodeError('PlaceScaled 保留字节非零');
      return {
        type: 'PlaceScaled',
        account,
        market,
        side: side(),
        size: i64(40),
        tif: tif(),
        opts: {
          reduceOnly: ((flags >> 4) & 1) === 1,
          goodTilBlock: u64(16),
          position: position((flags >> 5) & 0b11),
          isCross: ((flags >> 7) & 1) === 1,
        },
        params: {
          lowestPrice: i64(24),
          highestPrice: i64(32),
          numOrders: b[10],
          profile: enumAt(PROFILES, flags & 0b111, 'profile'),
          spacing: enumAt(SPACINGS, (flags >> 3) & 1, 'spacing'),
          magnitudePpm: u32(12),
        },
      };
    }
    default:
      return undefined;
  }
}

export function actionToHex(action: Action): string {
  return bytesToHex(encodeAction(action));
}

export function actionFromHex(hex: string): Action | undefined {
  return decodeAction(hexToBytes(hex.startsWith('0x') ? hex.slice(2) : hex));
}
