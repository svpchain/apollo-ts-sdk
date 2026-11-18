// 节点 HTTP JSON-RPC 2.0 的 connect `Transport`。
//
// 节点在一个 POST 端点上提供 `proto/apollo/v1` 的一元方法：
//   - 请求 `{"jsonrpc":"2.0","id":…,"method":"MarketService.ListMarkets","params":{…}}`，
//     `method` 是 `Service.Method`（带不带 `apollo.v1.` 前缀都行）；
//   - 参数 / 结果是 proto3 JSON（字段 camelCase、64 位整数为十进制字符串、枚举为名字），
//     只有 `bytes` 字段不同：是 `0x` 十六进制而不是 base64，这里按消息描述符来回改写；
//   - 错误 `{"code","message"}`，code 按 JSON-RPC 约定加节点自定义的 -3200x，映射回 connect 的 Code，
//     上层的 classifyRpcError / NotFound 判断不用改；
//   - JSON-RPC 不提供流式方法，这里直接给 Unimplemented。
// 请求头只带 content-type，以满足节点的 CORS 设置。
//
// 浏览器和 Node.js 都能用：只依赖 fetch。

import {
  type DescField,
  type DescMessage,
  type DescMethodStreaming,
  type DescMethodUnary,
  type JsonValue,
  type MessageInitShape,
  ScalarType,
  create,
  fromJson,
  toJson,
} from '@bufbuild/protobuf';
import { base64Decode, base64Encode } from '@bufbuild/protobuf/wire';
import {
  Code,
  ConnectError,
  type StreamResponse,
  type Transport,
  type UnaryResponse,
} from '@connectrpc/connect';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export interface JsonRpcTransportOptions {
  /** 节点 JSON-RPC 地址，如 `https://rpc.example.com`（POST 到这个地址本身）。 */
  baseUrl: string;
  /** 一元调用的默认超时（毫秒）。 */
  defaultTimeoutMs?: number;
  /** 单次请求/响应的 UTF-8 字节上限，默认 8 MiB / 16 MiB。 */
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** 可注入的 fetch（测试用）。 */
  fetch?: typeof globalThis.fetch;
}

// JSON-RPC 标准码与节点自定义码（-32000 起）到 connect Code 的映射。
const JSON_RPC_CODES: Record<number, Code> = {
  [-32700]: Code.Internal,
  [-32600]: Code.Internal,
  [-32601]: Code.Unimplemented,
  [-32602]: Code.InvalidArgument,
  [-32603]: Code.Internal,
  [-32000]: Code.Unknown,
  [-32002]: Code.FailedPrecondition,
  [-32003]: Code.Unavailable,
  [-32004]: Code.NotFound,
  [-32005]: Code.ResourceExhausted,
};

export function connectCodeFromJsonRpc(code: unknown): Code {
  return (typeof code === 'number' && JSON_RPC_CODES[code]) || Code.Unknown;
}

/** 非 200 只会来自节点前面的 nginx（节点自己的错误都是 200 + error）。 */
function connectCodeFromHttpStatus(status: number): Code {
  if (status === 429) return Code.ResourceExhausted;
  if (status === 401 || status === 403) return Code.PermissionDenied;
  if (status === 404 || status === 405 || status === 501) return Code.Unimplemented;
  if (status === 408 || status === 504) return Code.DeadlineExceeded;
  if (status >= 500) return Code.Unavailable;
  return Code.Unknown;
}

export function createApolloJsonRpcTransport(options: JsonRpcTransportOptions): Transport {
  let endpoint: URL;
  try {
    endpoint = new URL(options.baseUrl);
  } catch {
    throw new TypeError('baseUrl must be an absolute HTTP(S) node endpoint');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new TypeError('baseUrl must be an HTTP(S) endpoint without embedded credentials or a fragment');
  }
  const url = options.baseUrl;
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  const maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
  for (const value of [defaultTimeoutMs, maxRequestBytes, maxResponseBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
      throw new RangeError('Timeout/size limits must be positive integers <= 2147483647');
  }
  let nextId = 0;

  return {
    async unary<I extends DescMessage, O extends DescMessage>(
      method: DescMethodUnary<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      _header: HeadersInit | undefined,
      input: MessageInitShape<I>,
    ): Promise<UnaryResponse<I, O>> {
      const params = toJson(method.input, create(method.input, input)) as JsonValue;
      rewriteBytes(method.input, params, base64ToHex);
      nextId += 1;
      const id = nextId;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: `${method.parent.typeName}.${method.name}`,
        params,
      });

      if (new TextEncoder().encode(body).length > maxRequestBytes)
        throw new ConnectError('JSON-RPC request exceeds maxRequestBytes', Code.ResourceExhausted);
      if (
        timeoutMs !== undefined &&
        (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
      )
        throw new RangeError('timeoutMs must be positive and <= 2147483647');
      const controller = new AbortController();
      const budget = timeoutMs ?? defaultTimeoutMs;
      const timer =
        budget > 0
          ? setTimeout(
              () =>
                controller.abort(
                  new ConnectError(`${method.name} 超时（${budget}ms）`, Code.DeadlineExceeded),
                ),
              budget,
            )
          : undefined;
      const onAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });

      let response: Response;
      let text: string;
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        text = await readResponse(response, maxResponseBytes);
      } catch (error) {
        throw abortOrNetworkError(error, controller.signal);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      if (!response.ok) {
        throw new ConnectError(
          `节点 JSON-RPC 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`,
          connectCodeFromHttpStatus(response.status),
        );
      }
      let envelope: JsonRpcEnvelope;
      try {
        envelope = JSON.parse(text) as JsonRpcEnvelope;
      } catch {
        throw new ConnectError(`节点 JSON-RPC 响应不是 JSON：${text.slice(0, 200)}`, Code.Internal);
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new ConnectError('节点 JSON-RPC 响应不是对象', Code.Internal);
      }
      if (envelope.jsonrpc !== '2.0' || envelope.id !== id) {
        throw new ConnectError('Invalid JSON-RPC response version or id', Code.Internal);
      }
      if (Object.hasOwn(envelope, 'error') && Object.hasOwn(envelope, 'result'))
        throw new ConnectError('JSON-RPC response contains both result and error', Code.Internal);
      if (envelope.error) {
        const { code, message } = envelope.error;
        throw new ConnectError(
          typeof message === 'string' ? message : `JSON-RPC 错误 ${String(code)}`,
          connectCodeFromJsonRpc(code),
        );
      }
      if (
        envelope.jsonrpc !== '2.0' ||
        !Object.hasOwn(envelope, 'result') ||
        !envelope.result ||
        typeof envelope.result !== 'object' ||
        Array.isArray(envelope.result)
      ) {
        throw new ConnectError('Invalid JSON-RPC result envelope', Code.Internal);
      }
      const result = envelope.result as JsonValue;
      rewriteBytes(method.output, result, hexToBase64);
      let message;
      try {
        message = fromJson(method.output, result, { ignoreUnknownFields: true });
      } catch (error) {
        throw new ConnectError(
          `无法解析 ${method.output.typeName}：${error instanceof Error ? error.message : String(error)}`,
          Code.Internal,
        );
      }
      return {
        stream: false,
        service: method.parent,
        method,
        header: new Headers(response.headers),
        message,
        trailer: new Headers(),
      };
    },

    async stream<I extends DescMessage, O extends DescMessage>(
      method: DescMethodStreaming<I, O>,
    ): Promise<StreamResponse<I, O>> {
      throw new ConnectError(
        `${method.parent.typeName}.${method.name} 是流式方法，HTTP JSON-RPC 不支持`,
        Code.Unimplemented,
      );
    },
  };
}

async function readResponse(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new ConnectError('JSON-RPC response exceeds maxResponseBytes', Code.ResourceExhausted);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ConnectError('JSON-RPC response exceeds maxResponseBytes', Code.ResourceExhausted);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function abortOrNetworkError(error: unknown, signal: AbortSignal): ConnectError {
  if (error instanceof ConnectError) return error;
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof ConnectError) return reason;
    return new ConnectError(reason instanceof Error ? reason.message : 'aborted', Code.Canceled);
  }
  return new ConnectError(
    `节点 JSON-RPC 不可达：${error instanceof Error ? error.message : String(error)}`,
    Code.Unavailable,
  );
}

// ───────────────────────── bytes：0x 十六进制 ⇄ base64 ─────────────────────────

function hexToBase64(value: string): string {
  if (!/^0x([0-9a-f]{2})*$/i.test(value)) return value;
  return base64Encode(hexToBytes(value.slice(2)));
}

function base64ToHex(value: string): string {
  return `0x${bytesToHex(base64Decode(value))}`;
}

/** 按消息描述符遍历 JSON，对每个 bytes 字段（含嵌套、列表、map 值）应用 `convert`。 */
export function rewriteBytes(desc: DescMessage, value: JsonValue, convert: (text: string) => string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const object = value as Record<string, JsonValue>;
  for (const field of desc.fields) {
    const key = field.jsonName in object ? field.jsonName : field.name in object ? field.name : undefined;
    if (key === undefined) continue;
    const slot = object[key];
    if (slot === null || slot === undefined) continue;
    rewriteField(field, slot, convert, (next) => {
      object[key] = next;
    });
  }
}

function rewriteField(
  field: DescField,
  slot: JsonValue,
  convert: (text: string) => string,
  replace: (next: JsonValue) => void,
): void {
  switch (field.fieldKind) {
    case 'scalar':
      if (field.scalar === ScalarType.BYTES && typeof slot === 'string') replace(convert(slot));
      return;
    case 'message':
      rewriteBytes(field.message, slot, convert);
      return;
    case 'list':
      if (!Array.isArray(slot)) return;
      if (field.listKind === 'scalar' && field.scalar === ScalarType.BYTES) {
        replace(slot.map((item) => (typeof item === 'string' ? convert(item) : item)));
      } else if (field.listKind === 'message') {
        for (const item of slot) rewriteBytes(field.message, item, convert);
      }
      return;
    case 'map': {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return;
      const entries = slot as Record<string, JsonValue>;
      if (field.mapKind === 'scalar' && field.scalar === ScalarType.BYTES) {
        for (const [k, v] of Object.entries(entries)) if (typeof v === 'string') entries[k] = convert(v);
      } else if (field.mapKind === 'message') {
        for (const v of Object.values(entries)) rewriteBytes(field.message, v, convert);
      }
      return;
    }
    default:
      return;
  }
}
