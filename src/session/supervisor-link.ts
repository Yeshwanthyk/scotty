import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { FromSupervisor, type ToSupervisorMessage } from "../../protocol/supervisor.js";

const Incoming = Schema.fromJsonString(FromSupervisor);
export class DialError extends Schema.TaggedError<DialError>()("DialError", {
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
  dial(port: Cloudflare.Fetcher, gen: number, after: number, stillWanted: () => boolean) {
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
      const response = yield* port.fetch(
        HttpServerRequest.fromWeb(
          new Request(`http://container/?gen=${gen}&after=${after}`, {
            headers: { Upgrade: "websocket" },
          }),
        ),
      );
      const web = HttpServerResponse.toWeb(response);
      const candidate: unknown = Reflect.get(web, "webSocket");
      if (
        !(candidate instanceof WebSocket) ||
        !("accept" in candidate) ||
        typeof candidate.accept !== "function"
      ) {
        return yield* new DialError({ message: "Supervisor websocket upgrade failed" });
      }
      candidate.accept();
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
