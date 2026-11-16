import { writeFile } from "node:fs/promises";
import { Effect } from "effect";
import {
  access,
  client,
  target,
  Created,
  View,
  Conversation,
  CliFailure,
  failure,
} from "../cli/client.js";
import { real, sessionAgent, prompt } from "./lib/agent.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { Log, waiter } from "./lib/wait.js";
const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  for (let run = 1; run <= (real ? 1 : 5); run++) {
    const session = yield* request("/api/sessions", Created, {
      method: "POST",
      key: crypto.randomUUID(),
      body: {
        repo: fixtureRepo,
        ...sessionAgent,
        size: "standard-1",
        provider: "cloudflare",
        title: "e2e startup",
        prompt: prompt("Reply with exactly startup-ready.", "say startup-ready"),
      },
    });
    const prefix = `/api/sessions/${session.id}`;
    console.log(`created ${session.id}`);
    yield* Effect.gen(function* () {
      const log = yield* waiter(request, prefix)(
        () => request(`${prefix}/log`, Log),
        (log) => log.some((e) => e.kind === "turn.ended"),
      );
      const answer = yield* request(`${prefix}/conversation`, Conversation);
      const at = (kind: string) => log.find((e) => e.kind === kind)?.at ?? NaN;
      const start = at("container.start");
      const stages = [
        "container.start",
        "sup.hello",
        "workspace.prepared",
        "workspace.ready",
        "agent.ready",
        "prompt.delivered",
        "turn.ended",
      ];
      if (
        stages.some(
          (kind, i) => !Number.isFinite(at(kind)) || (i > 0 && at(kind) < at(stages[i - 1] ?? "")),
        ) ||
        !answer.turns[0]?.assistant.includes("startup-ready") ||
        log.some((e) => e.kind === "invariant.violated" || e.kind === "sup.error") ||
        !log.some((e) => e.kind === "turn.ended" && e.state === "completed")
      )
        return yield* failure(
          "startup",
          "Missing or unordered startup stages, failed turn or wrong answer",
          "scotty doctor",
        );
      console.log(
        JSON.stringify({
          run,
          id: session.id,
          hello: at("sup.hello") - start,
          prepared: at("workspace.prepared") - start,
          workspace: at("workspace.ready") - start,
          agent: at("agent.ready") - start,
          delivered: at("prompt.delivered") - start,
          ended: at("turn.ended") - start,
          answer: answer.turns[0]?.assistant,
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const log = yield* request(`${prefix}/log`, Log);
          yield* Effect.promise(() =>
            writeFile(
              `work/startup-${session.id}.jsonl`,
              log.map((e) => JSON.stringify(e)).join("\n") + "\n",
            ),
          );
          yield* request(`${prefix}/stop`, View, { method: "POST" });
        }).pipe(Effect.orDie),
      ),
    );
  }
});
Effect.runPromise(program).catch((e) => {
  console.error(e instanceof CliFailure ? e.message : "Startup e2e failed");
  process.exitCode = 1;
});
