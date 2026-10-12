import { BunServices } from "@effect/platform-bun";
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
import { prompt, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";
import { githubEvents } from "./github-events.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("github", message, "scotty doctor"));
// Patterns chosen so the command text itself, echoed in a reply or a rollout, never matches.
const tokenPattern = "gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}";

// gh runs on the host with the owner's login; the session never sees that token.
const gh = (args: string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("gh", ["api", ...args], { stdin: "ignore", stderr: "ignore" }),
    );
    const out = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
    return { ok: (yield* child.exitCode) === 0, out };
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.mapError(() => failure("setup", "Could not run gh api", "gh auth login")),
  );

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  yield* githubEvents(request);
  const repo = yield* Schema.decodeUnknownEffect(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  )(process.env.SCOTTY_PRIVATE_TEST_REPO).pipe(
    Effect.mapError(() =>
      failure("setup", "SCOTTY_PRIVATE_TEST_REPO is not set", "export SCOTTY_PRIVATE_TEST_REPO="),
    ),
  );
  const marker = `MARK-${crypto.randomUUID().slice(0, 8)}`;
  const push = `echo ${marker} > marker.txt && git add marker.txt && git commit -m 'e2e marker' && git push origin HEAD`;
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      ...sessionAgent,
      title: "e2e github",
      repo,
      prompt: prompt(
        `Run exactly: \`${push}\`, then reply with only the word done.`,
        `run ${push}\nsay done`,
      ),
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  const branch = `scotty/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  const ended = (turn: string) =>
    poll(
      () => request(`${prefix}/log`, Log),
      (log) => log.some((e) => e.kind === "turn.ended" && e.turn === turn),
    );
  // Runs a command and returns its output: in words for a real agent, as a script for the stand-in.
  const run = (turn: string, command: string, ask = "reply with its full output") =>
    answer(turn, prompt(`Run exactly: \`${command}\` and ${ask}.`, `run ${command}\nsay {{out}}`));
  const answer = (turn: string, text: string) =>
    Effect.gen(function* () {
      const req = crypto.randomUUID();
      yield* request(`${prefix}/steer`, Reply, {
        method: "POST",
        key: req,
        body: { req, turn, text },
      });
      yield* ended(turn);
      const conversation = yield* request(`${prefix}/conversation`, Conversation);
      return conversation.turns.find((item) => item.id === req)?.assistant ?? "";
    });

  // 1. The agent pushes its commit to scotty/<id> of a private repository.
  yield* ended("0");
  const pushed = yield* gh([`repos/${repo}/branches/${branch}`, "--jq", ".commit.sha"]);
  yield* check(pushed.ok && /^[0-9a-f]{40}$/.test(pushed.out.trim()), `No branch ${branch}`);
  const content = yield* gh([
    "-H",
    "Accept: application/vnd.github.raw+json",
    `repos/${repo}/contents/marker.txt?ref=${branch}`,
  ]);
  yield* check(content.ok && content.out.includes(marker), "Pushed marker.txt lacks the marker");
  console.log(`Pushed: ${branch} at ${pushed.out.trim()} holds the marker`);

  // 2. A push outside scotty/* is refused.
  const refused = yield* run("1", "git push origin HEAD:refs/heads/scotty-e2e-forbidden 2>&1");
  const forbidden = yield* gh([`repos/${repo}/branches/scotty-e2e-forbidden`]);
  yield* check(!forbidden.ok, "The forbidden branch exists");
  yield* check(
    /403|error|fatal|denied/i.test(refused),
    "The forbidden push did not report failure",
  );
  console.log("Refused: push to scotty-e2e-forbidden failed and no branch exists");

  // 3. gh opens and merges a pull request between two scotty/* branches; GitHub's token is
  // swapped in by the Worker.
  const base = `${branch}-base`;
  const merged = yield* run(
    "2",
    `git push origin HEAD~1:refs/heads/${base} 2>&1 && gh pr create --base ${base} --head ${branch} --title 'e2e gh' --body 'e2e gh' 2>&1 && gh pr merge ${branch} --merge 2>&1; echo EXIT=$?`,
  );
  const pull = yield* gh([
    `repos/${repo}/pulls?state=closed&head=${repo.split("/")[0]}:${branch}`,
    "--jq",
    ".[0].merged_at",
  ]);
  yield* check(
    /EXIT=0\b/.test(merged) && pull.ok && /^\d{4}-/.test(pull.out.trim()),
    `gh did not open and merge a pull request: ${merged.slice(-400)}`,
  );
  console.log(`Merged: gh opened and merged ${branch} into ${base}`);

  // 4. gh writes that move a branch outside scotty/* are refused before they reach GitHub.
  const writes = [
    `gh api -X PUT repos/${repo}/contents/e2e-forbidden.txt -f message=x -f content=eA== -f branch=main`,
    `gh api -X POST repos/${repo}/git/refs -f ref=refs/heads/scotty-e2e-forbidden-api -f sha=$(git rev-parse HEAD)`,
    `gh api graphql -f query='mutation { updateRef(input: {refId: "x", oid: "0000000000000000000000000000000000000000"}) { clientMutationId } }'`,
  ];
  const writesRefused = yield* run(
    "3",
    `{ ${writes.join("; ")}; } 2>&1 | grep -c 'Scotty refuses'`,
    "reply with only the number it prints",
  );
  yield* check(
    /\b3\b/.test(writesRefused),
    `Not every forbidden write was refused: ${writesRefused}`,
  );
  const file = yield* gh([`repos/${repo}/contents/e2e-forbidden.txt`]);
  const apiBranch = yield* gh([`repos/${repo}/branches/scotty-e2e-forbidden-api`]);
  yield* check(!file.ok && !apiBranch.ok, "A refused write reached GitHub");
  console.log("Refused: contents PUT on main, a non-scotty ref and a GraphQL updateRef");

  // 5. No GitHub token anywhere the agent can look. Codex refuses to print env or config
  // verbatim, so the command reports only match counts. /usr is image content, and the Codex
  // binary there holds its own secret-detection patterns.
  const scan = yield* run(
    "4",
    `p='${tokenPattern}'; echo REWRITE=$(git config --global --get-regexp '^url\\..*github\\.internal' | wc -l); echo ENV=$(env | grep -cE "$p"); echo CONFIG=$(git config --list | grep -cE "$p"); echo ARGS=$(cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -cE "$p"); echo FILES=$(grep -rlE "$p" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=usr 2>/dev/null | wc -l)`,
    "reply with its output only",
  );
  yield* check(/REWRITE=1\b/.test(scan), "The reply lacks the github.internal rewrite");
  for (const place of ["ENV", "CONFIG", "ARGS", "FILES"])
    yield* check(new RegExp(`${place}=0\\b`).test(scan), `GitHub token pattern found in ${place}`);
  yield* check(!new RegExp(tokenPattern).test(scan), "The reply holds a GitHub token");
  console.log("Clean: no GitHub token in env, git config or files");

  // 6. Clean up the branches and the session.
  for (const name of [branch, base]) {
    const deleted = yield* gh(["-X", "DELETE", `repos/${repo}/git/refs/heads/${name}`]);
    yield* check(deleted.ok, `Could not delete ${name}`);
  }
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  console.log(`Deleted ${branch} and ${base}; session stopped`);
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "GitHub e2e failed");
  process.exitCode = 1;
});
