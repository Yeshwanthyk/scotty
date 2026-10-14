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

// The owner's own public skill repositories. In agent-skills, yesh-router links to
// ../plan/SKILL.md and ships an executable references/decision-trail/log.sh.
const source = "Yeshwanthyk/agent-skills/skills";
const other = "Yeshwanthyk/scotty/skills";
const [router, linked, scotty] = ["yesh-router", "plan", "scotty"];
const id = crypto.randomUUID().slice(0, 8).toUpperCase();
const firstMark = `OWNERMARK-A-${id}`;
const secondMark = `OWNERMARK-B-${id}`;

// Lists what start installed, follows yesh-router's link, checks its script kept its mode, and
// greps the owner's marker from the agent's instructions.
const { skills, instructions } = {
  codex: { skills: "~/.agents/skills", instructions: '"${CODEX_HOME:-$HOME/.codex}/AGENTS.md"' },
  claude: { skills: "~/.claude/skills", instructions: "~/.claude/CLAUDE.md" },
}[agent];
const command = `ls ${skills}; test -f ${skills}/${router}/../${linked}/SKILL.md && echo LINK-OK; test -x ${skills}/${router}/references/decision-trail/log.sh && echo EXEC-OK; grep -o "OWNERMARK-[A-Z0-9-]*" ${instructions}`;
const probe = prompt(
  `Run exactly: \`${command}\` and reply with its full output only.`,
  `run ${command}\nsay {{out}}`,
);

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const add = (id: string) =>
    request("/api/skill-sources", SourceSaved, { method: "POST", body: { source: id } });
  const remove = (id: string) =>
    request("/api/skill-sources/remove", SourceRemoved, { method: "POST", body: { source: id } });
  const toggle = (name: string, enabled: boolean) =>
    request(`/api/skills/${name}`, SkillSwitched, { method: "PATCH", body: { enabled } });

  // The owner may use these sources and instructions; note them to put back at the end.
  const owner = yield* request("/api/settings", Settings);
  const before = owner.sources.filter((known) => known.id === source || known.id === other);
  for (const known of before) yield* remove(known.id);

  // 1. Added fresh, every skill is off; a refresh at the same commit finds nothing new.
  const added = yield* add(source);
  yield* check(
    added.added.includes(router) && added.added.includes(linked),
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
  yield* add(other);
  console.log(`${source} at ${added.commit.slice(0, 7)}: ${added.added.length} skills, all off`);

  // 2. One skill on in each source and owner instructions; a new session gets both folders whole.
  yield* toggle(router, true);
  yield* toggle(scotty, true);
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
  yield* check(
    [router, linked, scotty].every((name) => start.includes(name)),
    `Both sources not installed: ${start}`,
  );
  yield* check(start.includes("LINK-OK"), "A skill's link to another skill doesn't resolve");
  yield* check(start.includes("EXEC-OK"), "A skill's script lost its execute bit");
  yield* check(start.includes(firstMark), "Owner instructions not in the agent's instructions");
  console.log("Start: both sources installed, link resolves, script executable, owner marker");

  // 3. Every skill off and new instructions; a stop and resume picks up both.
  yield* toggle(router, false);
  yield* toggle(scotty, false);
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
  yield* check(!resumed.includes("LINK-OK"), "A source with no skill on is still installed");
  yield* check(
    resumed.includes(secondMark) && !resumed.includes(firstMark),
    "Resume kept the old instructions",
  );
  console.log("Resume: no skills, new owner marker present");

  // 4. Clean up, and put back the owner's sources and instructions as they were.
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  yield* remove(source);
  yield* remove(other);
  yield* request("/api/settings/instructions", Saved, {
    method: "PUT",
    body: { text: owner.instructions },
  });
  for (const known of before) {
    yield* add(`${known.id}${known.ref === null ? "" : `@${known.ref}`}`);
    for (const skill of known.skills) if (skill.enabled) yield* toggle(skill.name, true);
  }
  console.log("Cleaned up");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Settings e2e failed");
  process.exitCode = 1;
});
