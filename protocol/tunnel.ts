import { Option, Schema } from "effect";

export const tunnelPort = 7001;
export const tunnelChunk = 65_536;

export const FrameKind = { head: 1, body: 2, end: 3, abort: 4 } as const;
type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

const HeaderList = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
export const TunnelRequest = Schema.Struct({
  method: Schema.String,
  host: Schema.String.check(Schema.isPattern(/^[a-z0-9.-]{1,253}$/)),
  path: Schema.String.check(Schema.isPattern(/^\//)),
  headers: HeaderList,
});
export const TunnelResponse = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 })),
  headers: HeaderList,
});

export interface Frame {
  readonly id: number;
  readonly kind: FrameKind;
  readonly payload: Uint8Array;
}

export const encodeFrame: (
  id: number,
  kind: FrameKind,
  payload?: Uint8Array,
) => Uint8Array<ArrayBuffer> = (id, kind, payload) => {
  const frame = new Uint8Array(5 + (payload?.byteLength ?? 0));
  new DataView(frame.buffer).setUint32(0, id);
  frame[4] = kind;
  if (payload !== undefined) frame.set(payload, 5);
  return frame;
};

export const encodeHead: (
  id: number,
  head: typeof TunnelRequest.Type | typeof TunnelResponse.Type,
) => Uint8Array<ArrayBuffer> = (id, head) =>
  encodeFrame(id, FrameKind.head, new TextEncoder().encode(JSON.stringify(head)));

const kinds: ReadonlyArray<number> = Object.values(FrameKind);
const isKind = (value: number): value is FrameKind => kinds.includes(value);

export const decodeFrame: (bytes: Uint8Array) => Frame | undefined = (bytes) => {
  if (bytes.byteLength < 5) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint8(4);
  if (!isKind(kind)) return undefined;
  return { id: view.getUint32(0), kind, payload: bytes.subarray(5) };
};

export const decodeHead = <S extends typeof TunnelRequest | typeof TunnelResponse>(
  schema: S,
  payload: Uint8Array,
) =>
  Option.flatMap(
    Option.liftThrowable(() => new TextDecoder("utf-8", { fatal: true }).decode(payload))(),
    Schema.decodeUnknownOption(Schema.fromJsonString(schema)),
  );

export const hopHeaders = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "authorization",
  "x-forwarded-for",
  "x-real-ip",
]);
