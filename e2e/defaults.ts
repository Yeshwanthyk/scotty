import { writeFile } from "node:fs/promises";
import { Effect } from "effect";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  target,
  View,
} from "../cli/client.js";
import { AgentDefaults } from "../src/session/agents/agent-settings.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { real } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";

const program = Effect.gen(function* () {
  const request = client({
    url: yield* target(process.env.SCOTTY_URL),
    token: yield* access(yield* target(process.env.SCOTTY_URL)),
  });
  const path = "/api/settings/agents";
  const original = yield* request(path, AgentDefaults);
  const save = (value: typeof AgentDefaults.Type) =>
    request(path, AgentDefaults, { method: "PUT", body: value });
  const check = (ok: boolean, why: string) =>
    ok ? Effect.void : Effect.fail(failure("defaults", why, "scotty doctor"));
  const chosen = {
    ...original,
    agent: "claude" as const,
    codex: { model: "gpt-6.1-sol", effort: "high" as const },
  };
  yield* Effect.gen(function* () {
    yield* save(chosen);
    yield* check(
      JSON.stringify(yield* request(path, AgentDefaults)) === JSON.stringify(chosen),
      "Defaults did not persist",
    );
    for (const bad of [
      { ...chosen, agent: "other" },
      { ...chosen, codex: { ...chosen.codex, model: "" } },
      { ...chosen, claude: { ...chosen.claude, effort: "other" } },
    ]) {
      const rejected = yield* request(path, AgentDefaults, { method: "PUT", body: bad }).pipe(
        Effect.flip,
      );
      yield* check(
        rejected.code === "bad_request",
        `Invalid defaults were not rejected: ${rejected.code}`,
      );
    }
    for (const explicit of [false, true]) {
      const session = yield* request("/api/sessions", Created, {
        method: "POST",
        key: crypto.randomUUID(),
        body: {
          title: "e2e defaults",
          repo: fixtureRepo,
          provider: "cloudflare",
          ...(explicit ? { agent: "codex" } : {}),
          ...(explicit && real ? {} : { scripted: true }),
          prompt:
            explicit && real
              ? "Run grep -E '^model =|^model_reasoning_effort =' /home/scotty/.codex/config.toml. Report those two exact lines only; read no other config fields."
              : "say defaults-ready",
        },
      });
      console.log(`Session ${session.id}`);
      const prefix = `/api/sessions/${session.id}`;
      yield* Effect.gen(function* () {
        yield* check(
          (yield* request(prefix, View)).session.display.agentKind ===
            (explicit ? "codex" : "claude"),
          "Default or explicit agent was lost",
        );
        yield* waiter(request, prefix)(
          () => request(`${prefix}/log`, Log),
          (log) => log.some((event) => event.kind === "turn.ended" && event.turn === "0"),
        );
        if (explicit && real) {
          const answer =
            (yield* request(`${prefix}/conversation`, Conversation)).turns[0]?.assistant ?? "";
          yield* check(
            answer.includes('model = "gpt-6.1-sol"') &&
              answer.includes('model_reasoning_effort = "high"'),
            "Next start did not use saved model and effort",
          );
        }
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const log = yield* request(`${prefix}/log`, Log);
            yield* Effect.promise(() =>
              writeFile(`work/defaults-${session.id}.json`, JSON.stringify(log)),
            );
            yield* request(`${prefix}/stop`, View, { method: "POST" });
          }).pipe(Effect.orDie),
        ),
      );
    }
    console.log(
      `Defaults: save/readback, invalid values, default and explicit agent${real ? ", real next-start model/effort" : ""} verified`,
    );
  }).pipe(Effect.ensuring(save(original).pipe(Effect.asVoid, Effect.orDie)));
});
Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Defaults e2e failed");
  process.exitCode = 1;
});
