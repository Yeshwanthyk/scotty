import { Option } from "effect";
import {
  Credit,
  decodeCredit,
  decodeFrame,
  decodeHead,
  encodeCredit,
  encodeFrame,
  encodeHead,
  FrameKind,
  hopHeaders,
  inbox,
  type Inbox,
  tunnelChunk,
  TunnelRequest,
} from "../../protocol/tunnel.js";

declare const FixedLengthStream: new (length: number) => TransformStream<Uint8Array, Uint8Array>;

type Send = (frame: Uint8Array<ArrayBuffer>) => void;
export type Serve = (
  head: typeof TunnelRequest.Type,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
) => Promise<Response | undefined>;

interface Open {
  readonly abort: AbortController;
  readonly credit: Credit;
  readonly body: Inbox | undefined;
}

const bodiless = new Set(["GET", "HEAD"]);
const droppedReply = new Set(["content-encoding", "content-length", "transfer-encoding"]);

export class TunnelServer {
  private readonly open = new Map<number, Open>();

  constructor(private readonly serve: Serve) {}

  reset() {
    for (const id of Array.from(this.open.keys())) this.close(id);
  }

  receive(bytes: Uint8Array, send: Send) {
    const frame = decodeFrame(bytes);
    if (frame === undefined) return;
    const entry = this.open.get(frame.id);
    switch (frame.kind) {
      case FrameKind.head:
        if (entry === undefined) this.start(frame.id, frame.payload, send);
        return;
      case FrameKind.body:
        entry?.body?.push(frame.payload);
        return;
      case FrameKind.end:
        entry?.body?.end();
        return;
      case FrameKind.credit:
        entry?.credit.grant(decodeCredit(frame.payload));
        return;
      case FrameKind.abort:
        return this.close(frame.id);
    }
  }

  private close(id: number) {
    const entry = this.open.get(id);
    this.open.delete(id);
    entry?.abort.abort();
    entry?.credit.close();
    entry?.body?.fail(new Error("tunnel closed"));
  }

  private start(id: number, payload: Uint8Array, send: Send) {
    const head = decodeHead(TunnelRequest, payload);
    if (Option.isNone(head)) return send(encodeFrame(id, FrameKind.abort));
    const abort = new AbortController();
    const body = bodiless.has(head.value.method.toUpperCase())
      ? undefined
      : inbox(
          (bytes) => {
            if (this.open.has(id)) send(encodeCredit(id, bytes));
          },
          () => undefined,
        );
    const credit = new Credit();
    this.open.set(id, { abort, credit, body });
    const headers = head.value.headers.filter(
      ([name]) => !hopHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith("cf-"),
    );
    const length = head.value.headers.find(
      ([name]) => name.toLowerCase() === "content-length",
    )?.[1];
    const stream =
      body !== undefined && length !== undefined && /^\d{1,15}$/.test(length)
        ? body.stream.pipeThrough(new FixedLengthStream(Number(length)))
        : (body?.stream ?? null);
    void this.relay(
      id,
      this.serve({ ...head.value, headers }, stream, abort.signal),
      send,
      credit,
      abort.signal,
    );
  }

  private async relay(
    id: number,
    answered: Promise<Response | undefined>,
    send: Send,
    credit: Credit,
    signal: AbortSignal,
  ) {
    try {
      const response = (await answered) ?? new Response("Not found\n", { status: 404 });
      if (signal.aborted) return;
      send(
        encodeHead(id, {
          status: response.status,
          headers: Array.from(response.headers).filter(
            ([name]) => !droppedReply.has(name.toLowerCase()),
          ),
        }),
      );
      if (response.body !== null)
        for await (const chunk of response.body)
          for (let at = 0; at < chunk.byteLength; at += tunnelChunk) {
            const piece = chunk.subarray(at, at + tunnelChunk);
            if (!(await credit.reserve(piece.byteLength)) || signal.aborted) return;
            send(encodeFrame(id, FrameKind.body, piece));
          }
      send(encodeFrame(id, FrameKind.end));
    } catch {
      if (!signal.aborted) send(encodeFrame(id, FrameKind.abort));
    } finally {
      this.open.get(id)?.body?.end();
      this.open.delete(id);
    }
  }
}
