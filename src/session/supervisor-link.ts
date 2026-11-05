import { Effect, Schema } from "effect";
import type { Port } from "../places/place.js";
import { FromSupervisor, type ToSupervisorMessage } from "../../protocol/supervisor.js";

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

  constructor(private readonly consume: (input: SocketInput) => Effect.Effect<void>) {}

  send(message: ToSupervisorMessage): void {
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
    // The replaced socket is no longer current, so its close is not reported.
    const setSocket = (socket: WebSocket) => {
      const old = this.socket;
      this.socket = socket;
      old?.close();
    };
    const isCurrent = (socket: WebSocket) => this.socket === socket;
    return Effect.gen(function* () {
      // A refused connection rejects; a container still booting refuses, and the caller
      // retries a DialError. A dial abandoned by its attempt's timeout aborts `signal`.
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
        enqueue(() => {
          if (!isCurrent(candidate)) return Effect.void;
          const raw = typeof event.data === "string" ? event.data : "";
          return Schema.decodeUnknownEffect(Incoming)(raw).pipe(
            Effect.flatMap((value) => consume({ kind: "message", value })),
          );
        });
      });
      candidate.addEventListener("close", () => {
        if (isCurrent(candidate)) enqueue(() => consume({ kind: "closed", gen }));
      });
      candidate.addEventListener("error", () => {
        if (isCurrent(candidate)) enqueue(() => consume({ kind: "closed", gen }));
      });
    });
  }

  // A failed input (an undecodable message, a defect in `consume`) closes the socket.
  private enqueue(operation: () => Effect.Effect<void, unknown>): void {
    this.tail = this.tail
      .then(() => Effect.runPromise(operation()))
      .catch(() => {
        this.socket?.close();
      });
  }
}
