import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Conversation, View, failure } from "../client.js";
import { output, sessionPath, url, usage, withClient } from "./common.js";

export const watch = Command.make(
  "watch",
  {
    url,
    id: Argument.String("id"),
    until: Flag.Literals("until", ["idle", "turn-end"]).pipe(Flag.optional),
    timeout: Flag.String("timeout").pipe(Flag.optional),
  },
  ({ url: target, id, until, timeout }) =>
    Effect.gen(function* () {
      const path = sessionPath(id);
      const seconds = Option.getOrElse(timeout, () => "0");
      const duration = Number(seconds);
      if (!Number.isFinite(duration) || duration < 0)
        return yield* usage("--timeout must be a nonnegative number of seconds", "watch");
      const api = yield* withClient(target);
      const deadline = duration ? Date.now() + duration * 1000 : Infinity;
      let previous = "";
      let initialTurn: string | undefined;
      while (Date.now() < deadline) {
        const view = yield* api(path, View);
        const json = JSON.stringify(view);
        if (json !== previous) {
          yield* output(view);
          previous = json;
        }
        if (Option.isSome(until)) {
          const conversation = yield* api(`${path}/conversation`, Conversation);
          const streaming = conversation.turns.find((turn) => turn.state !== "completed");
          if (initialTurn === undefined && streaming) initialTurn = streaming.id;
          if (
            view.session.authority.kind === "stable" &&
            view.session.authority.lifecycle === "failed"
          )
            return yield* failure("agent_failed", "Session failed", `scotty log ${id}`);
          if (until.value === "idle" && view.session.authority.kind === "stable" && !streaming)
            return;
          if (
            until.value === "turn-end" &&
            initialTurn === undefined &&
            view.session.authority.kind === "stable" &&
            !streaming
          )
            return;
          if (
            until.value === "turn-end" &&
            initialTurn !== undefined &&
            conversation.turns.some((turn) => turn.id === initialTurn && turn.state === "completed")
          )
            return;
        }
        yield* Effect.sleep("1 second");
      }
      return yield* failure(
        "timeout",
        `Watch timed out after ${seconds} seconds`,
        `scotty show ${id}`,
      );
    }),
).pipe(Command.withDescription("Stream session view changes as JSON lines"));
