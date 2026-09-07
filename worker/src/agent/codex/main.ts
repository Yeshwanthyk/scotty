import { NodeRuntime, NodeServices, NodeSink, NodeStream } from "@effect/platform-node";
import { Deferred, Effect, Schema, Scope, Stream } from "effect";
import { CodexHostError } from "./errors";
import { limits, makeFramer } from "./framing";
import { startCodexSession } from "./session";
import { CodexLaunch } from "./process";

const decodeLaunchJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexLaunch), {
  onExcessProperty: "error",
});

const Command = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("prompt"),
    text: Schema.String.check(Schema.isMaxLength(65536)),
  }),
  Schema.Struct({ method: Schema.Literal("interrupt") }),
  Schema.Struct({ method: Schema.Literal("stop") }),
]);
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(Command), {
  onExcessProperty: "error",
});

export const program = Effect.fnUntraced(function* (argv: ReadonlyArray<string>) {
  if (argv.length !== 1 || (argv[0]?.length ?? 0) > 16384)
    return yield* new CodexHostError({ code: "invalid_launch_selection" });
  const selection = yield* decodeLaunchJson(argv[0]).pipe(
    Effect.mapError(() => new CodexHostError({ code: "invalid_launch_selection" })),
  );
  const scope = yield* Scope.Scope;
  const fatal = yield* Deferred.make<never, CodexHostError>();
  let outputBytes = 0;
  const sink = NodeSink.fromWritable({
    evaluate: () => process.stdout,
    endOnDone: false,
    onError: () => new CodexHostError({ code: "transport_failed" }),
  });
  const send = Effect.fnUntraced(function* (value: unknown) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    outputBytes += bytes.length;
    if (outputBytes > limits.output) return yield* new CodexHostError({ code: "output_budget" });
    yield* Stream.run(Stream.make(bytes), sink).pipe(
      Effect.timeoutOrElse({
        duration: 2000,
        orElse: () => Effect.fail(new CodexHostError({ code: "transport_failed" })),
      }),
    );
  });
  const host = yield* startCodexSession(selection, (event) => send({ type: "event", event }));
  yield* Effect.addFinalizer(() =>
    host.stop.pipe(
      Effect.flatMap((receipt) => send({ type: "stopped", ...receipt })),
      Effect.catch(() =>
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  );
  yield* send({ type: "ready", ...host.inspect() });
  const framer = makeFramer(limits.input);
  let commands = 0;
  const receive = Effect.fnUntraced(function* (line: string) {
    if (++commands > limits.events) return yield* new CodexHostError({ code: "event_budget" });
    const command = yield* decodeCommand(line).pipe(
      Effect.mapError(() => new CodexHostError({ code: "invalid_message" })),
    );
    if (command.method === "stop") {
      yield* host.stop;
      return;
    }
    const operation =
      command.method === "interrupt"
        ? host.interrupt.pipe(Effect.flatMap((turn) => send({ type: "interrupt_terminal", turn })))
        : host.prompt(command.text).pipe(
            Effect.flatMap((accepted) =>
              Effect.gen(function* () {
                yield* send({ type: "accepted", turnId: accepted.turnId });
                const turn = yield* accepted.completed;
                yield* send({ type: "terminal", turn });
              }),
            ),
          );
    yield* operation.pipe(
      Effect.tapError((error) =>
        send({ type: "failure", code: error.code }).pipe(Effect.catch(() => Effect.void)),
      ),
      Effect.catchCause((cause) => Deferred.failCause(fatal, cause)),
      Effect.forkIn(scope),
    );
  });
  const input = NodeStream.fromReadable({
    evaluate: () => process.stdin,
    onError: () => new CodexHostError({ code: "transport_failed" }),
  }).pipe(
    Stream.runForEach((chunk: Uint8Array) => framer.push(chunk, receive)),
    Effect.andThen(framer.end),
  );
  yield* Effect.raceFirst(
    Effect.raceFirst(input, Deferred.await(fatal)),
    host.closed.pipe(
      Effect.flatMap((receipt) =>
        receipt.failure === null
          ? Effect.void
          : Effect.fail(new CodexHostError({ code: "transport_failed" })),
      ),
    ),
  );
});

// boundary: standalone Node executable owns one runtime, signals and scope via public runMain.
export const run = (argv: ReadonlyArray<string>) =>
  NodeRuntime.runMain(program(argv).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), {
    disableErrorReporting: true,
  });
