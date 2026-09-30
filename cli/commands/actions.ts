import { Effect, Exit, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Log, Removed, Reply, View, failure } from "../client.js";
import { removeSkill } from "./push.js";
import { removeConnection } from "./connections.js";
import {
  dim,
  green,
  output,
  sessionIds,
  sessionPath,
  short,
  state,
  usage,
  withClient,
} from "./common.js";

const id = Argument.String("id");
const req = Flag.String("req").pipe(Flag.optional);

export const steer = Command.make(
  "steer",
  { id, text: Argument.String("text"), req },
  ({ id: value, text, req: retry }) =>
    Effect.gen(function* () {
      if (!text.trim()) return yield* usage("Steer text cannot be empty", "steer");
      const api = yield* withClient;
      const path = yield* sessionPath(api, value, "steer");
      const events = yield* api(`${path}/log`, Log);
      const body = {
        text,
        turn: turnFrom(events),
        ...(Option.isSome(retry) ? { req: retry.value } : {}),
      };
      const reply = yield* api(`${path}/steer`, Reply, { method: "POST", body });
      yield* output(reply, `${green("✓")} Sent ${dim(`(${reply.status})`)}`);
    }),
);

export const interrupt = Command.make("interrupt", { id, req }, ({ id: value, req: retry }) =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const path = yield* sessionPath(api, value, "interrupt");
    const events = yield* api(`${path}/log`, Log);
    const body = {
      turn: turnFrom(events),
      ...(Option.isSome(retry) ? { req: retry.value } : {}),
    };
    const reply = yield* api(`${path}/interrupt`, Reply, { method: "POST", body });
    yield* output(reply, `${green("✓")} Interrupted ${dim(`(${reply.status})`)}`);
  }),
);

const lifecycle = (name: "stop" | "resume", past: string) =>
  Command.make(name, { id }, ({ id: value }) =>
    Effect.gen(function* () {
      const api = yield* withClient;
      const path = yield* sessionPath(api, value, name);
      const view = yield* api(`${path}/${name}`, View, { method: "POST" });
      yield* output(
        view,
        `${green("✓")} ${past} ${short(view.session.identity.id)} ${dim(`(${state(view.session)})`)}`,
      );
    }),
  );
export const stop = lifecycle("stop", "Stopping");
export const resume = lifecycle("resume", "Resuming");

// `rm <id…>` deletes sessions; `rm skill <name>` and `rm connection <name>` delete those.
// Every id is resolved before anything is deleted.
export const rm = Command.make(
  "rm",
  { ids: Argument.String("id").pipe(Argument.atLeast(1)) },
  ({ ids }) =>
    Effect.gen(function* () {
      if (ids[0] === "skill") {
        const [, name, ...rest] = ids;
        if (name === undefined || rest.length > 0)
          return yield* usage("Name one skill: scotty rm skill <name>", "rm");
        return yield* removeSkill(yield* withClient, name);
      }
      if (ids[0] === "connection") {
        const [, name, ...rest] = ids;
        if (name === undefined || rest.length > 0)
          return yield* usage("Name one connection: scotty rm connection <name>", "rm");
        return yield* removeConnection(yield* withClient, name);
      }
      const api = yield* withClient;
      // Two prefixes of one id would delete it twice.
      const full = [...new Set(yield* sessionIds(api, ids, "rm"))];
      const removed: (typeof Removed.Type)[] = [];
      for (const id of full) {
        const result = yield* Effect.exit(
          api(`/api/sessions/${id}`, Removed, { method: "DELETE" }),
        );
        if (Exit.isFailure(result)) {
          if (removed.length === 0) return yield* result;
          // One error, naming what was already removed, so --json prints one document.
          const error = Option.getOrUndefined(Exit.findErrorOption(result));
          return yield* failure(
            error?.code ?? "request_failed",
            `Removed ${removed.map((entry) => short(entry.id)).join(", ")}, then ${short(id)} failed: ${error?.message ?? "unknown error"}`,
            error?.hint ?? "scotty ls",
            error?.exit ?? 1,
          );
        }
        removed.push(result.value);
      }
      yield* output(
        removed,
        removed.map((entry) => `${green("✓")} Removed ${short(entry.id)}`).join("\n"),
      );
    }),
);

const Hatch = Schema.Struct({ url: Schema.String });
export const hatch = Command.make(
  "hatch",
  { id, port: Argument.Int("port") },
  ({ id: value, port }) =>
    Effect.gen(function* () {
      const api = yield* withClient;
      const path = yield* sessionPath(api, value, "hatch");
      const preview = yield* api(`${path}/hatch/${port}`, Hatch);
      yield* output(preview, preview.url);
    }),
);

// The turn the next steer or interrupt is aimed at: one past the last ended turn.
const turnFrom = (log: readonly { kind: string }[]) =>
  String(log.filter((event) => event.kind === "turn.ended").length);
