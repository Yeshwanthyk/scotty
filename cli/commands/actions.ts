import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Log, Reply, View, failure } from "../client.js";
import { output, sessionPath, turnFrom, url, withClient } from "./common.js";

const id = Argument.String("id");
const req = Flag.String("req").pipe(Flag.optional);
export const steer = Command.make(
  "steer",
  { url, id, text: Argument.String("text"), req },
  ({ url: target, id: value, text, req: retry }) =>
    Effect.gen(function* () {
      if (!text.trim())
        return yield* failure("usage", "Steer text cannot be empty", "scotty steer --help", 2);
      const path = sessionPath(value);
      const api = yield* withClient(target);
      const events = yield* api(`${path}/log`, Log);
      const body = {
        text,
        turn: turnFrom(events),
        ...(Option.isSome(retry) ? { req: retry.value } : {}),
      };
      return yield* output(yield* api(`${path}/steer`, Reply, { method: "POST", body }));
    }),
).pipe(Command.withDescription("Send text to a session"));

export const interrupt = Command.make(
  "interrupt",
  { url, id, req },
  ({ url: target, id: value, req: retry }) =>
    Effect.gen(function* () {
      const path = sessionPath(value);
      const api = yield* withClient(target);
      const events = yield* api(`${path}/log`, Log);
      const body = {
        turn: turnFrom(events),
        ...(Option.isSome(retry) ? { req: retry.value } : {}),
      };
      return yield* output(yield* api(`${path}/interrupt`, Reply, { method: "POST", body }));
    }),
).pipe(Command.withDescription("Interrupt the current turn"));

export const stop = Command.make("stop", { url, id }, ({ url: target, id: value }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    return yield* output(yield* api(`${sessionPath(value)}/stop`, View, { method: "POST" }));
  }),
).pipe(Command.withDescription("Stop a session's container"));
