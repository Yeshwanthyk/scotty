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
import { Log, waiter } from "./lib/wait.js";

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
  const repo = yield* Schema.decodeUnknownEffect(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  )(process.env.SCOTTY_PRIVATE_TEST_REPO).pipe(
    Effect.mapError(() =>
      failure("setup", "SCOTTY_PRIVATE_TEST_REPO is not set", "export SCOTTY_PRIVATE_TEST_REPO="),
    ),
  );
  const marker = `MARK-${crypto.randomUUID().slice(0, 8)}`;
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: "e2e github",
      repo,
      prompt: `Run exactly: \`echo ${marker} > marker.txt && git add marker.txt && git commit -m 'e2e marker' && git push origin HEAD\`, then reply with only the word done.`,
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
  const refused = yield* answer(
    "1",
    "Run exactly: `git push origin HEAD:refs/heads/scotty-e2e-forbidden` and reply with its full output.",
  );
  const forbidden = yield* gh([`repos/${repo}/branches/scotty-e2e-forbidden`]);
  yield* check(!forbidden.ok, "The forbidden branch exists");
  yield* check(
    /403|error|fatal|denied/i.test(refused),
    "The forbidden push did not report failure",
  );
  console.log("Refused: push to scotty-e2e-forbidden failed and no branch exists");

  // 3. No GitHub token anywhere the agent can look. Codex refuses to print env or config
  // verbatim, so the command reports only match counts. /usr is image content, and the Codex
  // binary there holds its own secret-detection patterns.
  const scan = yield* answer(
    "2",
    `Run exactly: \`p='${tokenPattern}'; echo REWRITE=$(git config --global --get-regexp '^url\\..*github\\.internal' | wc -l); echo ENV=$(env | grep -cE "$p"); echo CONFIG=$(git config --list | grep -cE "$p"); echo ARGS=$(cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -cE "$p"); echo FILES=$(grep -rlE "$p" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=usr 2>/dev/null | wc -l)\` and reply with its output only.`,
  );
  yield* check(/REWRITE=1\b/.test(scan), "The reply lacks the github.internal rewrite");
  for (const place of ["ENV", "CONFIG", "ARGS", "FILES"])
    yield* check(new RegExp(`${place}=0\\b`).test(scan), `GitHub token pattern found in ${place}`);
  yield* check(!new RegExp(tokenPattern).test(scan), "The reply holds a GitHub token");
  console.log("Clean: no GitHub token in env, git config or files");

  // 4. Clean up the branch and the session.
  const deleted = yield* gh(["-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
  yield* check(deleted.ok, `Could not delete ${branch}`);
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  console.log(`Deleted ${branch}; session stopped`);
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "GitHub e2e failed");
  process.exitCode = 1;
});
