import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FakeWorkerService } from "../support/fake-worker.mjs";
import { cliEnvironment, makeGitFixture, makeTempDir, runCli } from "../support/harness.mjs";

test("real CLI completes up/ls/snapshot/resume/pr/down/vaporize against the fake Worker", async (t) => {
  const service = await new FakeWorkerService().start();
  const root = makeTempDir();
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const env = cliEnvironment(service, home);
  t.after(async () => {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const up = await runCli(
    [
      "up",
      "exercise the complete E2E lifecycle",
      "--repo",
      "anomalyco/rift",
      "--cap",
      "1h",
      "--detach",
      "--json",
    ],
    { env },
  );
  assert.equal(up.code, 0, up.stderr);
  assert.deepEqual(Object.keys(up.json).sort(), ["branch", "id", "status", "url"]);
  assert.equal(up.json.status, "warm");
  assert.match(up.json.branch, /^scotty\/e2e-/);
  assert.doesNotMatch(up.json.url, /[?&]t=/, "CLI JSON must not persist the one-time query token");
  const id = up.json.id;

  const ls = await runCli(["ls", "--json"], { env });
  assert.equal(ls.code, 0, ls.stderr);
  assert.equal(ls.json.length, 1);
  assert.equal(ls.json[0].id, id);
  assert.equal(ls.json[0].status, "warm");
  assert.equal(typeof ls.json[0].ageSeconds, "number");
  assert.equal(typeof ls.json[0].capRemainingSeconds, "number");

  const wrongResume = await runCli(["resume", id, "--json"], { env });
  assert.equal(wrongResume.code, 5, wrongResume.stderr);
  assert.equal(wrongResume.stdout, "");
  assert.equal(wrongResume.json?.error?.code, "wrong_state");
  assert.match(wrongResume.json?.error?.hint ?? "", /sleeping|failed/i);

  const snapshot = await runCli(["snapshot", id, "--json"], { env });
  assert.equal(snapshot.code, 0, snapshot.stderr);
  assert.equal(snapshot.json.id, id);
  assert.equal(snapshot.json.status, "warm");
  assert.deepEqual(Object.keys(snapshot.json).sort(), ["backupId", "id", "status"]);
  const beforeSleep = service.inspect();
  assert.equal(beforeSleep.backupIds.length, 1);
  const originalWorktree = service.runtimes.get(id).worktree;

  await service.forceHardCap(id);
  assert.equal(service.sessions.get(id).status, "sleeping");
  assert.equal(
    service.runtimes.has(id),
    false,
    "hard cap must destroy the runtime even with clients conceptually attached",
  );
  assert.equal(service.backups.size, 2, "hard cap takes a fresh backup");

  const sleepingSnapshot = await runCli(["snapshot", id, "--json"], { env });
  assert.equal(sleepingSnapshot.code, 5, sleepingSnapshot.stderr);
  assert.equal(sleepingSnapshot.json?.error?.code, "wrong_state");

  const resume = await runCli(["resume", id, "--json"], { env });
  assert.equal(resume.code, 0, resume.stderr);
  assert.equal(resume.json.status, "warm");
  assert.deepEqual(Object.keys(resume.json).sort(), ["branch", "id", "status", "url"]);
  assert.equal(service.runtimes.get(id).worktree, originalWorktree);
  assert.equal(service.runtimes.get(id).generation, 2);

  const pr = await runCli(["pr", id, "--title", "Scotty E2E fixture", "--json"], { env });
  assert.equal(pr.code, 0, pr.stderr);
  assert.deepEqual(Object.keys(pr.json).sort(), ["branchUrl", "created", "prUrl"]);
  assert.equal(pr.json.created, true);
  assert.match(pr.json.prUrl, /\/pull\/42$/);

  const gitFixture = await makeGitFixture(root, service.sessions.get(id).branch);
  service.sessions.get(id).sha = gitFixture.sha;
  const down = await runCli(["down", id, "--json"], { env, cwd: gitFixture.local });
  assert.equal(down.code, 0, down.stderr);
  assert.deepEqual(Object.keys(down.json).sort(), ["branch", "resumeCmd", "rolloutPath", "sha"]);
  assert.equal(down.json.branch, service.sessions.get(id).branch);
  assert.match(down.json.resumeCmd, /^codex resume '[0-9a-f-]+' -C '/);
  assert.equal(
    fs.statSync(down.json.rolloutPath).mode & 0o777,
    0o600,
    "beam-down rollout must be owner-only",
  );
  assert.equal(
    fs.existsSync(path.join(gitFixture.local, ".git", "FETCH_HEAD")),
    true,
    "beam-down must fetch the remote session branch",
  );

  const vaporize = await runCli(["vaporize", id, "--yes", "--json"], { env });
  assert.equal(vaporize.code, 0, vaporize.stderr);
  assert.equal(vaporize.json.status, "gone");
  const remaining = service.inspect();
  assert.deepEqual(remaining.sessions, []);
  assert.deepEqual(remaining.projections, []);
  assert.deepEqual(remaining.backupIds, []);
  assert.deepEqual(remaining.runtimeIds, []);
  assert.deepEqual(remaining.credentialIds, []);
  assert.ok(remaining.tombstones.includes(id));

  const repeated = await runCli(["vaporize", id, "--yes", "--json"], { env });
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(repeated.json.status, "gone");
});

test("CLI preserves the stable error envelope and exit-code contract", async (t) => {
  const service = await new FakeWorkerService().start();
  const root = makeTempDir();
  const env = cliEnvironment(service, root);
  t.after(async () => {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const usage = await runCli(["snapshot", "--json"], { env });
  assert.equal(usage.code, 2, usage.stderr);
  assert.equal(usage.stdout, "");
  assert.equal(usage.json?.error?.code, "bad_usage");

  const missing = await runCli(["snapshot", "missing-session", "--json"], { env });
  assert.equal(missing.code, 3, missing.stderr);
  assert.equal(missing.stdout, "");
  assert.equal(missing.json?.error?.code, "not_found");

  const auth = await runCli(["ls", "--json"], { env: { ...env, SCOTTY_TOKEN: "wrong-token" } });
  assert.equal(auth.code, 4, auth.stderr);
  assert.equal(auth.stdout, "");
  assert.equal(auth.json?.error?.code, "auth");

  const network = await runCli(
    ["ls", "--host", "http://127.0.0.1:1", "--token", "unused-e2e-token", "--json"],
    { env },
  );
  assert.equal(network.code, 1, network.stderr);
  assert.equal(network.stdout, "");
  assert.equal(network.json?.error?.code, "network_error");
});

test("beam-down rejects traversal entries without writing outside CODEX_HOME", async (t) => {
  const service = await new FakeWorkerService().start();
  const root = makeTempDir();
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = cliEnvironment(service, home);
  t.after(async () => {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const up = await runCli(["up", "unsafe tar regression", "--detach", "--json"], { env });
  assert.equal(up.code, 0, up.stderr);
  const record = service.sessions.get(up.json.id);
  service.setRolloutEntries(up.json.id, [
    {
      name: "metadata.json",
      body: JSON.stringify({
        version: 1,
        id: record.id,
        branch: record.branch,
        sha: "0123456789abcdef0123456789abcdef01234567",
        codexThreadId: record.codexThreadId,
        rolloutPath: "../../escape.jsonl",
      }),
    },
    { name: "../../escape.jsonl", body: "owned\n" },
  ]);
  const local = path.join(root, "local");
  fs.mkdirSync(local);
  const result = await runCli(["down", up.json.id, "--json"], { env, cwd: local });
  assert.notEqual(result.code, 0, "unsafe tar must fail closed");
  assert.equal(fs.existsSync(path.join(root, "escape.jsonl")), false);
  assert.equal(fs.existsSync(path.join(home, "escape.jsonl")), false);
});
