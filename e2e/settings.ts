import { Effect } from "effect";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  Reply,
  Saved,
  Settings,
  SkillSwitched,
  SourceRemoved,
  SourceSaved,
  target,
  View,
} from "../cli/client.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("settings", message, "scotty doctor"));

// A public repository made for this test. `skills/` holds scotty-e2e-a, whose SKILL.md links to
// scotty-e2e-b's ref.md and ships an executable scripts/mark.sh; `clash/` holds another
// scotty-e2e-a.
const source = "Yeshwanthyk/scotty-skills-fixture/skills";
const clash = "Yeshwanthyk/scotty-skills-fixture/clash";
const [first, second] = ["scotty-e2e-a", "scotty-e2e-b"];
const id = crypto.randomUUID().slice(0, 8).toUpperCase();
const firstMark = `OWNERMARK-A-${id}`;
const secondMark = `OWNERMARK-B-${id}`;

// Lists what start installed, follows the link between the skills, runs the script, and greps
// the owner's marker from the agent's instructions.
const { skills, instructions } = {
  codex: { skills: "~/.agents/skills", instructions: '"${CODEX_HOME:-$HOME/.codex}/AGENTS.md"' },
  claude: { skills: "~/.claude/skills", instructions: "~/.claude/CLAUDE.md" },
}[agent];
const command = `ls ${skills}; cat ${skills}/${first}/../${second}/ref.md; ${skills}/${first}/scripts/mark.sh; grep -o "OWNERMARK-[A-Z0-9-]*" ${instructions}`;
const probe = prompt(
  `Run exactly: \`${command}\` and reply with its full output only.`,
  `run ${command}\nsay {{out}}`,
);

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const remove = (id: string) =>
    request("/api/skill-sources/remove", SourceRemoved, { method: "POST", body: { source: id } });
  const toggle = (name: string, enabled: boolean) =>
    request(`/api/skills/${name}`, SkillSwitched, { method: "PATCH", body: { enabled } });

  // 1. The source, fresh: both skills arrive off; a refresh finds nothing new; a second source
  // with a skill of the same name is refused.
  yield* remove(source).pipe(Effect.ignore);
  const added = yield* request("/api/skill-sources", SourceSaved, {
    method: "POST",
    body: { source },
  });
  yield* check(
    added.added.includes(first) && added.added.includes(second),
    `Add found ${added.added.join(", ")}`,
  );
  const listed = (yield* request("/api/settings", Settings)).sources.find((s) => s.id === source);
  yield* check(
    listed !== undefined && listed.skills.every((skill) => !skill.enabled),
    "New skills are not all off",
  );
  const refreshed = yield* request("/api/skill-sources/refresh", SourceSaved, {
    method: "POST",
    body: { source },
  });
  yield* check(
    refreshed.added.length + refreshed.updated.length + refreshed.removed.length === 0,
    "Refresh at the same commit reported changes",
  );
  const clashed = yield* request("/api/skill-sources", SourceSaved, {
    method: "POST",
    body: { source: clash },
  }).pipe(Effect.flip);
  yield* check(
    clashed.message.includes(`${first} (${source})`),
    `Clash not refused: ${clashed.message}`,
  );
  console.log(`Source ${source} at ${added.commit.slice(0, 7)}: two skills off; clash refused`);

  // 2. One skill on and owner instructions; a new session's agent gets the whole folder.
  yield* toggle(first, true);
  yield* request("/api/settings/instructions", Saved, {
    method: "PUT",
    body: { text: `The owner marker is ${firstMark}.` },
  });
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
  const start = yield* reply("0");
  yield* check(start.includes(first) && start.includes(second), "Source folder not installed");
  yield* check(start.includes("LINKMARK-B"), "A skill's link to another skill doesn't resolve");
  yield* check(start.includes("SCRIPTMARK-A"), "A skill's script didn't run");
  yield* check(start.includes(firstMark), "Owner instructions not in the agent's instructions");
  console.log("Start: both skills installed, link resolves, script runs, owner marker present");

  // 3. The skill off and new instructions; a stop and resume picks up both.
  yield* toggle(first, false);
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
  const resumed = yield* reply("1");
  yield* check(!resumed.includes("SCRIPTMARK-A"), "A source with no skill on is still installed");
  yield* check(
    resumed.includes(secondMark) && !resumed.includes(firstMark),
    "Resume kept the old instructions",
  );
  console.log("Resume: no skills, new owner marker present");

  // 4. Clean up so other tests start without settings.
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  yield* remove(source);
  yield* request("/api/settings/instructions", Saved, { method: "PUT", body: { text: "" } });
  console.log("Cleaned up");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Settings e2e failed");
  process.exitCode = 1;
});
