import { Option, Schema } from "effect";

export const tunnelPort = 7001;
export const tunnelSocket = "/tmp/scotty-tunnel.sock";
export const tunnelChunk = 65_536;
/** Bytes of body either end may send on one stream before the reader grants more. */
export const tunnelWindow = 1_048_576;

export const FrameKind = { head: 1, body: 2, end: 3, abort: 4, credit: 5 } as const;
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

export const encodeCredit: (id: number, bytes: number) => Uint8Array<ArrayBuffer> = (id, bytes) => {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes);
  return encodeFrame(id, FrameKind.credit, payload);
};
export const decodeCredit: (payload: Uint8Array) => number = (payload) =>
  payload.byteLength === 4
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0)
    : 0;

/** The sending side of one stream: `reserve` waits until the reader has granted room. */
export class Credit {
  private room = tunnelWindow;
  private closed = false;
  private wake: (() => void) | undefined;

  grant(bytes: number) {
    this.room += bytes;
    this.signal();
  }

  close() {
    this.closed = true;
    this.signal();
  }

  async reserve(bytes: number) {
    while (!this.closed && this.room < bytes)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    this.room -= bytes;
    return !this.closed;
  }

  private signal() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

/**
 * The receiving side of one stream: a body that hands out one queued chunk per read and grants
 * its bytes back only then, so a slow reader holds the sender to one window.
 */
export const inbox = (granted: (bytes: number) => void, cancelled: () => void) => {
  const queue: Uint8Array[] = [];
  let ended = false;
  let failed: Error | undefined;
  let waiting: (() => void) | undefined;
  const wake = () => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.();
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        while (queue.length === 0 && !ended && failed === undefined)
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
        const chunk = queue.shift();
        if (chunk !== undefined) {
          controller.enqueue(chunk);
          granted(chunk.byteLength);
        } else if (failed !== undefined) controller.error(failed);
        else controller.close();
      },
      cancel: () => {
        ended = true;
        queue.length = 0;
        cancelled();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    push: (chunk: Uint8Array) => {
      if (ended || failed !== undefined) return;
      queue.push(chunk.slice());
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
    fail: (error: Error) => {
      failed = error;
      wake();
    },
  };
};
export type Inbox = ReturnType<typeof inbox>;

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
