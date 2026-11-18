import {
  decodeFrame,
  decodeHead,
  encodeFrame,
  encodeHead,
  FrameKind,
  tunnelChunk,
  TunnelResponse,
} from "../../protocol/tunnel.js";
import { Option } from "effect";

type Send = (frame: Uint8Array) => boolean;
interface Waiting {
  readonly answer: (response: Response) => void;
  readonly fail: () => void;
  body?: ReadableStreamDefaultController<Uint8Array>;
}

const target = /^\/([a-z0-9.-]{1,253})(\/.*)?$/;
const unavailable = () => new Response("Scotty tunnel is not connected\n", { status: 502 });

export class Tunnel {
  private send: Send | undefined;
  private next = 0;
  private readonly waiting = new Map<number, Waiting>();

  attach(send: Send | undefined) {
    for (const [id, entry] of this.waiting) {
      this.waiting.delete(id);
      entry.fail();
    }
    this.send = send;
  }

  receive(bytes: Uint8Array) {
    const frame = decodeFrame(bytes);
    if (frame === undefined) return;
    const entry = this.waiting.get(frame.id);
    if (entry === undefined) return;
    switch (frame.kind) {
      case FrameKind.head: {
        const head = decodeHead(TunnelResponse, frame.payload);
        if (Option.isNone(head)) return this.drop(frame.id);
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            entry.body = controller;
          },
          cancel: () => {
            this.waiting.delete(frame.id);
            this.send?.(encodeFrame(frame.id, FrameKind.abort));
          },
        });
        entry.answer(
          new Response(head.value.status === 204 || head.value.status === 304 ? null : body, {
            status: head.value.status,
            headers: head.value.headers.map(([name, value]) => [name, value]),
          }),
        );
        return;
      }
      case FrameKind.body:
        entry.body?.enqueue(frame.payload.slice());
        return;
      case FrameKind.end:
        this.waiting.delete(frame.id);
        entry.body?.close();
        return;
      case FrameKind.abort:
        return this.drop(frame.id);
    }
  }

  private drop(id: number) {
    const entry = this.waiting.get(id);
    this.waiting.delete(id);
    entry?.fail();
  }

  fetch(request: Request) {
    const url = new URL(request.url);
    const [, host, path] = target.exec(url.pathname) ?? [];
    if (host === undefined) return Promise.resolve(new Response("not found\n", { status: 404 }));
    const send = this.send;
    if (send === undefined) return Promise.resolve(unavailable());
    this.next = (this.next + 1) % 0xffffffff;
    const id = this.next;
    return new Promise<Response>((resolve) => {
      const entry: Waiting = {
        answer: resolve,
        fail: () => {
          if (entry.body !== undefined) entry.body.error(new Error("tunnel closed"));
          else resolve(unavailable());
        },
      };
      this.waiting.set(id, entry);
      const head = {
        method: request.method,
        host,
        path: `${path ?? "/"}${url.search}`,
        headers: Array.from(request.headers),
      };
      if (!send(encodeHead(id, head))) return this.drop(id);
      void this.upload(id, send, request.body);
    });
  }

  private async upload(id: number, send: Send, body: ReadableStream<Uint8Array> | null) {
    try {
      if (body !== null)
        for await (const chunk of body)
          for (let at = 0; at < chunk.byteLength; at += tunnelChunk)
            if (!send(encodeFrame(id, FrameKind.body, chunk.subarray(at, at + tunnelChunk))))
              return this.drop(id);
      send(encodeFrame(id, FrameKind.end));
    } catch {
      send(encodeFrame(id, FrameKind.abort));
      this.drop(id);
    }
  }
}
