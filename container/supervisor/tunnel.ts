import {
  Credit,
  decodeCredit,
  decodeFrame,
  decodeHead,
  encodeCredit,
  encodeFrame,
  encodeHead,
  FrameKind,
  inbox,
  type Inbox,
  tunnelChunk,
  TunnelResponse,
} from "../../protocol/tunnel.js";
import { Option } from "effect";

type Send = (frame: Uint8Array) => boolean;
interface Waiting {
  readonly answer: (response: Response) => void;
  readonly fail: () => void;
  readonly credit: Credit;
  body?: Inbox;
}

const target = /^\/([a-z0-9.-]{1,253})(\/.*)?$/;
const local = new Set(["127.0.0.1", "localhost"]);
const unavailable = () => new Response("Scotty tunnel is not connected\n", { status: 502 });

const destination = (request: Request) => {
  const url = new URL(request.url);
  const named = request.headers.get("host")?.replace(/:\d+$/, "").toLowerCase() ?? url.hostname;
  if (!local.has(named) && /^[a-z0-9.-]{1,253}$/.test(named))
    return { host: named, path: `${url.pathname}${url.search}` };
  const [, host, path] = target.exec(url.pathname) ?? [];
  return host === undefined ? undefined : { host, path: `${path ?? "/"}${url.search}` };
};

export class Tunnel {
  private send: Send | undefined;
  private next = 0;
  private readonly waiting = new Map<number, Waiting>();

  attach(send: Send | undefined) {
    for (const id of Array.from(this.waiting.keys())) this.drop(id);
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
        const body = inbox(
          (bytes) => this.send?.(encodeCredit(frame.id, bytes)),
          () => {
            this.forget(frame.id);
            this.send?.(encodeFrame(frame.id, FrameKind.abort));
          },
        );
        entry.body = body;
        entry.answer(
          new Response(
            head.value.status === 204 || head.value.status === 304 ? null : body.stream,
            {
              status: head.value.status,
              headers: head.value.headers.map(([name, value]) => [name, value]),
            },
          ),
        );
        return;
      }
      case FrameKind.body:
        entry.body?.push(frame.payload);
        return;
      case FrameKind.end:
        this.forget(frame.id);
        entry.body?.end();
        return;
      case FrameKind.credit:
        entry.credit.grant(decodeCredit(frame.payload));
        return;
      case FrameKind.abort:
        return this.drop(frame.id);
    }
  }

  private forget(id: number) {
    this.waiting.get(id)?.credit.close();
    this.waiting.delete(id);
  }

  private drop(id: number) {
    const entry = this.waiting.get(id);
    this.forget(id);
    entry?.fail();
  }

  fetch(request: Request) {
    const where = destination(request);
    if (where === undefined) return Promise.resolve(new Response("not found\n", { status: 404 }));
    const send = this.send;
    if (send === undefined) return Promise.resolve(unavailable());
    this.next = (this.next + 1) % 0xffffffff;
    const id = this.next;
    return new Promise<Response>((resolve) => {
      const entry: Waiting = {
        credit: new Credit(),
        answer: resolve,
        fail: () => {
          if (entry.body !== undefined) entry.body.fail(new Error("tunnel closed"));
          else resolve(unavailable());
        },
      };
      this.waiting.set(id, entry);
      const head = {
        method: request.method,
        host: where.host,
        path: where.path,
        headers: Array.from(request.headers),
      };
      if (!send(encodeHead(id, head))) return this.drop(id);
      void this.upload(id, send, entry.credit, request.body);
    });
  }

  private async upload(
    id: number,
    send: Send,
    credit: Credit,
    body: ReadableStream<Uint8Array> | null,
  ) {
    try {
      if (body !== null)
        for await (const chunk of body)
          for (let at = 0; at < chunk.byteLength; at += tunnelChunk) {
            const piece = chunk.subarray(at, at + tunnelChunk);
            if (!(await credit.reserve(piece.byteLength))) return;
            if (!send(encodeFrame(id, FrameKind.body, piece))) return this.drop(id);
          }
      send(encodeFrame(id, FrameKind.end));
    } catch {
      send(encodeFrame(id, FrameKind.abort));
      this.drop(id);
    }
  }
}
