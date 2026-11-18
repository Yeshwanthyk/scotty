import { Option } from "effect";
import {
  decodeFrame,
  decodeHead,
  encodeFrame,
  encodeHead,
  FrameKind,
  hopHeaders,
  tunnelChunk,
  TunnelRequest,
} from "../../protocol/tunnel.js";

type Send = (frame: Uint8Array<ArrayBuffer>) => void;
export type Serve = (
  head: typeof TunnelRequest.Type,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
) => Promise<Response | undefined>;

interface Open {
  readonly abort: AbortController;
  readonly body: ReadableStreamDefaultController<Uint8Array> | undefined;
}

const bodiless = new Set(["GET", "HEAD"]);
const droppedReply = new Set(["content-encoding", "content-length", "transfer-encoding"]);

export class TunnelServer {
  private readonly open = new Map<number, Open>();

  constructor(private readonly serve: Serve) {}

  reset() {
    for (const entry of this.open.values()) entry.abort.abort();
    this.open.clear();
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
        entry?.body?.enqueue(frame.payload.slice());
        return;
      case FrameKind.end:
        entry?.body?.close();
        return;
      case FrameKind.abort:
        entry?.abort.abort();
        this.open.delete(frame.id);
        return;
    }
  }

  private start(id: number, payload: Uint8Array, send: Send) {
    const head = decodeHead(TunnelRequest, payload);
    if (Option.isNone(head)) return send(encodeFrame(id, FrameKind.abort));
    const abort = new AbortController();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = bodiless.has(head.value.method.toUpperCase())
      ? null
      : new ReadableStream<Uint8Array>({
          start: (opened) => {
            controller = opened;
          },
        });
    this.open.set(id, { abort, body: controller });
    const headers = head.value.headers.filter(
      ([name]) => !hopHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith("cf-"),
    );
    void this.relay(
      id,
      this.serve({ ...head.value, headers }, body, abort.signal),
      send,
      abort.signal,
    );
  }

  private async relay(
    id: number,
    answered: Promise<Response | undefined>,
    send: Send,
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
        for await (const chunk of response.body) {
          if (signal.aborted) return;
          for (let at = 0; at < chunk.byteLength; at += tunnelChunk)
            send(encodeFrame(id, FrameKind.body, chunk.subarray(at, at + tunnelChunk)));
        }
      send(encodeFrame(id, FrameKind.end));
    } catch {
      if (!signal.aborted) send(encodeFrame(id, FrameKind.abort));
    } finally {
      this.open.delete(id);
    }
  }
}
