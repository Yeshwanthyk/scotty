import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { FromSupervisor, type ToSupervisorMessage } from "../../protocol/supervisor.js";

const Incoming = Schema.fromJsonString(FromSupervisor);
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

  dial(port: Cloudflare.Fetcher, gen: number, after: number) {
    const enqueue = (operation: () => Promise<void>) => this.enqueue(operation);
    const consume = this.consume;
    const setSocket = (socket: WebSocket) => {
      this.socket = socket;
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
        throw new Error("Supervisor websocket upgrade failed");
      }
      candidate.accept();
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
