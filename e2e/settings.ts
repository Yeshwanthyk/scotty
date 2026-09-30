import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  Reply,
  target,
  View,
} from "../cli/client.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("settings", message, "scotty doctor"));
const Saved = Schema.Struct({ saved: Schema.Boolean });
const Switched = Schema.Struct({ name: Schema.String, enabled: Schema.Boolean });
const Removed = Schema.Struct({ removed: Schema.Boolean });
const Added = Schema.Struct({ name: Schema.String });

const name = "scotty-e2e";
const id = crypto.randomUUID().slice(0, 8).toUpperCase();
const skillMark = `SKILLMARK-${id}`;
const firstMark = `OWNERMARK-A-${id}`;
const secondMark = `OWNERMARK-B-${id}`;

// `scotty push skill` zips the folder and uploads it, as the owner would.
const addSkill = (url: string) =>
  Effect.gen(function* () {
    const folder = mkdtempSync(join(tmpdir(), "scotty-skill-"));
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: Scotty end-to-end test skill; use only when asked for the skill marker.\n---\n\nThe skill marker is ${skillMark}.\n`,
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("bun", ["cli/main.ts", "push", "skill", folder, "--json"], {
        env: { SCOTTY_URL: url },
        extendEnv: true,
        stdin: "ignore",
        stderr: "inherit",
      }),
    );
    const out = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
    if ((yield* child.exitCode) !== 0) return yield* failure("settings", out, "scotty push skill");
    const [added] = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Tuple([Added])))(
      out.trim(),
    );
    return added;
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.mapError((error) =>
      error instanceof CliFailure
        ? error
        : failure("settings", "scotty push skill failed", "scotty push --help"),
    ),
  );

// Lists what start installed: the agent's skill folders and the markers in its instructions.
const { skills, instructions } = {
  codex: { skills: "~/.agents/skills", instructions: '"${CODEX_HOME:-$HOME/.codex}/AGENTS.md"' },
  claude: { skills: "~/.claude/skills", instructions: "~/.claude/CLAUDE.md" },
}[agent];
const command = `ls ${skills}; grep -rho "[A-Z]*MARK-[A-Z0-9-]*" ${skills} ${instructions}`;
const probe = prompt(
  `Run exactly: \`${command}\` and reply with its full output only.`,
  `run ${command}\nsay {{out}}`,
);

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });

  // 1. A skill added with the CLI and owner instructions.
  const added = yield* addSkill(url);
  yield* check(added.name === name, `push skill returned ${added.name}`);
  yield* request("/api/settings/instructions", Saved, {
    method: "PUT",
    body: { text: `The owner marker is ${firstMark}.` },
  });
  console.log(`Skill ${name} added; instructions set`);

  // 2. A new session's agent sees both.
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: `e2e settings (${agent})`,
      repo: fixtureRepo,
      ...sessionAgent,
      prompt: probe,
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);
  const reply = (turn: string) =>
    Effect.gen(function* () {
      yield* poll(events, (log) => log.some((e) => e.kind === "turn.ended" && e.turn === turn));
      const conversation = yield* request(`${prefix}/conversation`, Conversation);
      return conversation.turns.at(-1)?.assistant ?? "";
    });
  const first = yield* reply("0");
  yield* check(first.includes(name) && first.includes(skillMark), "Skill not installed");
  yield* check(
    first.includes(firstMark),
    "Owner instructions not in the agent's instructions file",
  );
  console.log("Start: skill and owner marker present");

  // 3. Skill off and new instructions; a stop and resume picks up both.
  yield* request(`/api/skills/${name}`, Switched, { method: "PATCH", body: { enabled: false } });
  yield* request("/api/settings/instructions", Saved, {
    method: "PUT",
    body: { text: `The owner marker is ${secondMark}.` },
  });
  yield* poll(events, (log) => log.some((e) => e.kind === "save.done" && e.turn === "0"));
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  const req = crypto.randomUUID();
  yield* request(`${prefix}/steer`, Reply, {
    method: "POST",
    key: req,
    body: { req, turn: "1", text: probe },
  });
  const second = yield* reply("1");
  yield* check(!second.includes(skillMark), "Switched-off skill still installed after resume");
  yield* check(
    second.includes(secondMark) && !second.includes(firstMark),
    "Resume kept the old instructions",
  );
  console.log("Resume: skill gone, new owner marker present");

  // 4. Clean up so other tests start without settings.
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  yield* request(`/api/skills/${name}`, Removed, { method: "DELETE" });
  yield* request("/api/settings/instructions", Saved, { method: "PUT", body: { text: "" } });
  console.log("Cleaned up");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Settings e2e failed");
  process.exitCode = 1;
});
