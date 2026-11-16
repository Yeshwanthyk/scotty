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
import { fixtureRepo } from "../protocol/supervisor.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const marker = `DRAFT-${crypto.randomUUID().slice(0, 8)}`;
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: `e2e drafts (${agent})`,
      repo: fixtureRepo,
      ...sessionAgent,
      prompt: prompt(`Reply with only ${marker}. Do not modify files.`, `say ${marker}`),
      provider: "cloudflare",
      size: "standard-2",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  yield* Effect.gen(function* () {
    const view = yield* request(prefix, View);
    if (view.session.display.size !== "standard-2")
      return yield* failure("drafts", "Explicit standard-2 was lost", "scotty show");
    const poll = waiter(request, prefix);
    yield* poll(
      () => request(`${prefix}/log`, Log),
      (events) => events.some((event) => event.kind === "turn.ended" && event.turn === "0"),
    );
    const conversation = yield* request(`${prefix}/conversation`, Conversation);
    if (!conversation.turns[0]?.assistant.includes(marker))
      return yield* failure(
        "drafts",
        "The configured model did not complete the initial turn",
        "scotty doctor",
      );
    console.log(`Drafts (${agent}): explicit standard-2 and initial model response verified`);
  }).pipe(Effect.ensuring(request(`${prefix}/stop`, View, { method: "POST" }).pipe(Effect.ignore)));
});
Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Draft e2e failed");
  process.exitCode = 1;
});
