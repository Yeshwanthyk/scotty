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

/** Socket data and close enter the same serialized queue. */
export class SupervisorLink {
  private socket: WebSocket | undefined;
  private tail: Promise<void> = Promise.resolve();
  private outgoing = 0;

  constructor(private readonly consume: (input: SocketInput) => Promise<void>) {}

  send(message: ToSupervisorMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ ...message, n: ++this.outgoing }));
  }

  /** `stillWanted` is checked once the socket opens; a stale dial closes it and changes nothing. */
  dial(port: Port, gen: number, after: number, stillWanted: () => boolean) {
    const enqueue = (operation: () => Promise<void>) => this.enqueue(operation);
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
      // retries a DialError.
      const web = yield* Effect.tryPromise({
        // A dial abandoned by its attempt's timeout still resolves later; close that socket.
        try: (signal) => {
          const pending = port.fetch(`http://container/?gen=${gen}&after=${after}`, {
            headers: { Upgrade: "websocket" },
          });
          signal.addEventListener("abort", () =>
            pending.then(
              (late) => {
                accepted(late)?.close();
              },
              () => undefined,
            ),
          );
          return pending;
        },
        catch: () => new DialError({ message: "Supervisor not reachable" }),
      });
      const candidate = accepted(web);
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
        enqueue(async () => {
          if (!isCurrent(candidate)) return;
          const raw = typeof event.data === "string" ? event.data : "";
          const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(Incoming)(raw));
          await consume({ kind: "message", value: decoded });
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

  private enqueue(operation: () => Promise<void>): void {
    this.tail = this.tail.then(operation).catch(() => {
      this.socket?.close();
    });
  }
}

// Accepts and returns the upgraded socket on a response, if the supervisor accepted the upgrade.
function accepted(response: object): WebSocket | undefined {
  const candidate: unknown = Reflect.get(response, "webSocket");
  if (
    !(candidate instanceof WebSocket) ||
    !("accept" in candidate) ||
    typeof candidate.accept !== "function"
  )
    return undefined;
  candidate.accept();
  return candidate;
}
