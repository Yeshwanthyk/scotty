import { Effect, Schema } from "effect";
import type { Port } from "../places/place.js";
import { FromSupervisor, type ToSupervisorMessage } from "../../protocol/supervisor.js";
import type { TunnelRequest } from "../../protocol/tunnel.js";
import { TunnelServer } from "./tunnel.js";

const Incoming = Schema.fromJsonString(FromSupervisor);
class DialError extends Schema.TaggedError<DialError>()("DialError", {
  message: Schema.String,
}) {}
export type SocketInput =
  | { readonly kind: "message"; readonly value: typeof FromSupervisor.Type }
  | { readonly kind: "closed"; readonly gen: number };

/**
 * Socket data and close enter the same serialized queue. The socket's listeners are the host
 * boundary: each input runs `consume` there, with its context already provided.
 */
export class SupervisorLink {
  private socket: WebSocket | undefined;
  private tail: Promise<void> = Promise.resolve();
  private outgoing = 0;

  private readonly tunnel: TunnelServer;

  constructor(
    private readonly consume: (input: SocketInput) => Effect.Effect<void>,
    serve: (
      head: typeof TunnelRequest.Type,
      body: ReadableStream<Uint8Array> | null,
      signal: AbortSignal,
    ) => Effect.Effect<Response | undefined>,
  ) {
    this.tunnel = new TunnelServer((head, body, signal) =>
      Effect.runPromise(serve(head, body, signal)),
    );
  }

  send(message: ToSupervisorMessage) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ ...message, n: ++this.outgoing }));
  }

  /**
   * `stillWanted` is checked once the socket opens; a stale dial closes it and changes nothing.
   * `port` is called on every attempt: a port handle whose lookup failed (no instance placed yet)
   * stays failed, and only a new one looks again. `headers` go with the upgrade.
   */
  dial(
    port: () => Port,
    gen: number,
    after: number,
    headers: Record<string, string>,
    stillWanted: () => boolean,
  ) {
    const enqueue = (operation: () => Effect.Effect<void, unknown>) => this.enqueue(operation);
    const consume = this.consume;
    const tunnel = this.tunnel;
    const setSocket = (socket: WebSocket) => {
      const old = this.socket;
      this.socket = socket;
      tunnel.reset();
      old?.close();
    };
    const isCurrent = (socket: WebSocket) => this.socket === socket;
    return Effect.gen(function* () {
      const candidate = yield* Effect.tryPromise({
        try: (signal) =>
          port().socket(`http://container/?gen=${gen}&after=${after}`, headers, signal),
        catch: () => new DialError({ message: "Supervisor not reachable" }),
      });
      if (candidate === undefined) {
        return yield* new DialError({ message: "Supervisor websocket upgrade failed" });
      }
      if (!stillWanted()) {
        candidate.close();
        return;
      }
      setSocket(candidate);
      candidate.addEventListener("message", (event: MessageEvent) => {
        if (!isCurrent(candidate)) return;
        if (event.data instanceof ArrayBuffer)
          return tunnel.receive(new Uint8Array(event.data), (frame) => {
            if (isCurrent(candidate)) candidate.send(frame);
          });
        enqueue(() => {
          if (!isCurrent(candidate)) return Effect.void;
          const raw = typeof event.data === "string" ? event.data : "";
          return Schema.decodeUnknownEffect(Incoming)(raw).pipe(
            Effect.flatMap((value) => consume({ kind: "message", value })),
          );
        });
      });
      candidate.addEventListener("close", () => {
        if (isCurrent(candidate)) tunnel.reset();
        if (isCurrent(candidate)) enqueue(() => consume({ kind: "closed", gen }));
      });
      candidate.addEventListener("error", () => {
        if (isCurrent(candidate)) enqueue(() => consume({ kind: "closed", gen }));
      });
    });
  }

  private enqueue(operation: () => Effect.Effect<void, unknown>) {
    this.tail = this.tail
      .then(() => Effect.runPromise(operation()))
      .catch(() => {
        this.socket?.close();
      });
  }
}
