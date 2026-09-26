import { Effect, Option, Queue, Result, Schema } from "effect";
import { ToSupervisor, type ToSupervisorMessage } from "../../protocol/supervisor.js";
import { processEnv } from "./runtime.js";
import { acknowledge, dial, emit, initialWire, type Output } from "./wire.js";

interface Peer {
  data: { gen: number; after: number };
  send(message: string): void;
  close(): void;
}
interface Server {
  upgrade(request: Request, options: { data: { gen: number; after: number } }): boolean;
}
declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request, server: Server): Response | undefined;
    websocket: {
      open(peer: Peer): void;
      message(peer: Peer, data: string | Uint8Array): void;
      close(peer: Peer): void;
    };
  }): Server;
};
export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  message: Schema.String,
}) {}
const positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const nonnegative = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Dial = Schema.Struct({ gen: positive, after: nonnegative });
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
type Event =
  | { type: "open"; peer: Peer }
  | { type: "close"; peer: Peer }
  | { type: "input"; peer: Peer; data: string | Uint8Array }
  | { type: "output"; output: Output; gen?: number };

export const serve = (receive: (message: ToSupervisorMessage) => Effect.Effect<void, Error>) => {
  const queue = Effect.runSync(Queue.unbounded<Event>());
  // The consumer alone owns wire state and the active peer; Bun callbacks only enqueue.
  let wire = initialWire(crypto.randomUUID());
  let peer: Peer | undefined;
  const enqueue = (event: Event) => {
    Queue.offerUnsafe(queue, event);
  };
  const transmit = (socket: Peer, frame: unknown) => {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      if (peer === socket) peer = undefined;
    }
  };
  const output = (value: Output, gen?: number) => {
    if (wire.gen === undefined || (gen !== undefined && gen !== wire.gen)) return;
    try {
      const encoded = JSON.stringify(value);
      const length = new TextEncoder().encode(encoded).length;
      const capped: Output =
        length <= 512 * 1024
          ? value
          : value.type === "agent"
            ? { type: "agent", kind: value.kind, event: { truncated: true, originalBytes: length } }
            : value.type === "error"
              ? { ...value, message: "outbound error message truncated" }
              : { type: "error", code: "protocol", message: "outbound frame exceeded limit" };
      const result = emit({ ...wire, gen: wire.gen }, capped);
      if (Result.isFailure(result)) {
        console.error(result.failure.message);
        return;
      }
      wire = result.success.wire;
      if (peer !== undefined) transmit(peer, result.success.message);
    } catch {
      console.error(new ProtocolError({ message: "supervisor output encoding failed" }).message);
    }
  };
  const processEvent = (event: Event): Effect.Effect<void> => {
    switch (event.type) {
      case "open": {
        const result = dial(wire, event.peer.data.gen, event.peer.data.after);
        if (result.conflict) {
          event.peer.close();
          return Effect.void;
        }
        peer?.close();
        peer = event.peer;
        wire = result.wire;
        for (const frame of result.messages) transmit(event.peer, frame);
        return Effect.void;
      }
      case "close":
        if (peer === event.peer) peer = undefined;
        return Effect.void;
      case "output":
        output(event.output, event.gen);
        return Effect.void;
      case "input":
        return Effect.gen(function* () {
          if (peer !== event.peer) return;
          if (
            (typeof event.data === "string"
              ? new TextEncoder().encode(event.data).length
              : event.data.byteLength) > 1_048_576
          ) {
            output({ type: "error", code: "protocol", message: "message too large" });
            return;
          }
          const raw = yield* Effect.try({
            try: (): unknown =>
              JSON.parse(
                typeof event.data === "string"
                  ? event.data
                  : new TextDecoder("utf-8", { fatal: true }).decode(event.data),
              ),
            catch: () => new ProtocolError({ message: "invalid JSON or UTF-8" }),
          }).pipe(Effect.option);
          if (Option.isNone(raw)) {
            output({ type: "error", code: "protocol", message: "invalid JSON or UTF-8" });
            return;
          }
          const parsed = yield* Schema.decodeUnknownEffect(ToSupervisor)(raw.value).pipe(
            Effect.option,
          );
          if (Option.isNone(parsed) || parsed.value.gen !== wire.gen) {
            output({ type: "error", code: "protocol", message: "invalid command" });
            return;
          }
          if (parsed.value.type === "ack") {
            wire = acknowledge(wire, parsed.value.ack);
            return;
          }
          // Actions run in child fibers: a stuck clone/turn cannot block an ack or interrupt.
          yield* receive(parsed.value).pipe(
            Effect.catchCause(() =>
              Effect.sync(() =>
                output({
                  type: "error",
                  code: "protocol",
                  message: "command failed",
                  ...("req" in parsed.value ? { req: parsed.value.req } : {}),
                }),
              ),
            ),
            Effect.forkChild({ startImmediately: true }),
          );
        });
    }
  };
  Effect.runFork(
    Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap(processEvent),
        Effect.catchCause(() => Effect.sync(() => console.error("supervisor event failed"))),
      ),
    ),
  );
  const rawPort = processEnv("SCOTTY_SUP_PORT") || "7000";
  const port = Schema.decodeUnknownResult(Port)(Number(rawPort));
  if (Result.isFailure(port)) throw new ProtocolError({ message: "invalid supervisor port" });
  Bun.serve({
    port: port.success,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== "/") return new Response("not found", { status: 404 });
      const rawGen = url.searchParams.get("gen") ?? "";
      const rawAfter = url.searchParams.get("after") ?? "";
      const decimal = /^(0|[1-9][0-9]*)$/;
      const parsed = Schema.decodeUnknownResult(Dial)({
        gen: Number(rawGen),
        after: Number(rawAfter),
      });
      if (
        url.searchParams.getAll("gen").length !== 1 ||
        url.searchParams.getAll("after").length !== 1 ||
        !decimal.test(rawGen) ||
        !decimal.test(rawAfter) ||
        Result.isFailure(parsed)
      )
        return new Response("invalid dial", { status: 400 });
      if (wire.gen !== undefined && wire.gen !== parsed.success.gen)
        return new Response("generation conflict", { status: 409 });
      if (server.upgrade(request, { data: parsed.success })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        enqueue({ type: "open", peer: socket });
      },
      message(socket, data) {
        enqueue({ type: "input", peer: socket, data });
      },
      close(socket) {
        enqueue({ type: "close", peer: socket });
      },
    },
  });
  return (value: Output, gen?: number) =>
    enqueue({ type: "output", output: value, ...(gen === undefined ? {} : { gen }) });
};
