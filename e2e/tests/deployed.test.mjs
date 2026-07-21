import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { poll, runCli } from "../support/harness.mjs";

const REQUIRED = [
  "SCOTTY_E2E_DEPLOYED",
  "SCOTTY_E2E_HOST",
  "SCOTTY_E2E_TOKEN",
  "SCOTTY_E2E_REPO",
  "SCOTTY_E2E_LOCAL_REPO",
  "SCOTTY_E2E_CAP",
  "SCOTTY_E2E_CONFIRM_DESTRUCTIVE",
  "SCOTTY_E2E_ORPHAN_PROBE_URL",
];
const missing = REQUIRED.filter((name) => !process.env[name]);
const enabled =
  missing.length === 0 &&
  process.env.SCOTTY_E2E_DEPLOYED === "1" &&
  process.env.SCOTTY_E2E_CONFIRM_DESTRUCTIVE === "YES";
const skipReason = enabled
  ? false
  : `deployed E2E skipped: set ${missing.length ? missing.join(", ") : "SCOTTY_E2E_DEPLOYED=1 and SCOTTY_E2E_CONFIRM_DESTRUCTIVE=YES"}`;
if (process.env.SCOTTY_E2E_EXPLICIT === "1" && !enabled) throw new Error(skipReason);

test(
  "deployed canary: up/snapshot/hard-cap/resume/pr/down/vaporize leaves no orphans",
  { skip: skipReason, timeout: 15 * 60_000 },
  async (t) => {
    const env = {
      SCOTTY_HOST: process.env.SCOTTY_E2E_HOST,
      SCOTTY_TOKEN: process.env.SCOTTY_E2E_TOKEN,
    };
    const cwd = process.env.SCOTTY_E2E_LOCAL_REPO;
    assert.ok(
      fs.statSync(cwd).isDirectory(),
      "SCOTTY_E2E_LOCAL_REPO must be a local checkout of SCOTTY_E2E_REPO",
    );
    let id;
    t.after(async () => {
      if (id) await runCli(["vaporize", id, "--yes", "--json"], { env, cwd, timeoutMs: 120_000 });
    });

    const up = await runCli(
      [
        "up",
        `Scotty deployed E2E canary ${new Date().toISOString()}`,
        "--repo",
        process.env.SCOTTY_E2E_REPO,
        "--cap",
        process.env.SCOTTY_E2E_CAP,
        "--detach",
        "--json",
      ],
      { env, cwd, timeoutMs: 180_000 },
    );
    assert.equal(up.code, 0, up.stderr);
    id = up.json.id;
    assert.equal(up.json.status, "warm");

    const snapshot = await runCli(["snapshot", id, "--json"], { env, cwd, timeoutMs: 180_000 });
    assert.equal(snapshot.code, 0, snapshot.stderr);
    const wrongResume = await runCli(["resume", id, "--json"], { env, cwd });
    assert.equal(wrongResume.code, 5, wrongResume.stderr);

    const timeoutMs = Number(process.env.SCOTTY_E2E_CAP_TIMEOUT_MS ?? 420_000);
    await poll(
      async () => runCli(["ls", "--json"], { env, cwd, timeoutMs: 30_000 }),
      (result) =>
        result.code === 0 &&
        result.json?.find((session) => session.id === id)?.status === "sleeping",
      { timeoutMs, intervalMs: 5_000 },
    );
    const resume = await runCli(["resume", id, "--json"], { env, cwd, timeoutMs: 180_000 });
    assert.equal(resume.code, 0, resume.stderr);

    const pr = await runCli(["pr", id, "--title", `Scotty E2E ${id}`, "--json"], {
      env,
      cwd,
      timeoutMs: 180_000,
    });
    assert.equal(pr.code, 0, pr.stderr);
    assert.equal(pr.json.created, true);
    const down = await runCli(["down", id, "--json"], { env, cwd, timeoutMs: 180_000 });
    assert.equal(down.code, 0, down.stderr);
    assert.equal(fs.statSync(down.json.rolloutPath).mode & 0o777, 0o600);

    const vaporize = await runCli(["vaporize", id, "--yes", "--json"], {
      env,
      cwd,
      timeoutMs: 180_000,
    });
    assert.equal(vaporize.code, 0, vaporize.stderr);
    id = undefined;
    const list = await runCli(["ls", "--json"], { env, cwd });
    assert.equal(
      list.json.some((session) => session.id === up.json.id),
      false,
      "KV projection must be removed",
    );
    const probe = await fetch(
      `${process.env.SCOTTY_E2E_ORPHAN_PROBE_URL.replace(/\/$/, "")}/${up.json.id}`,
      { headers: { authorization: `Bearer ${process.env.SCOTTY_E2E_TOKEN}` } },
    );
    assert.equal(
      probe.status,
      200,
      "orphan probe must be enabled on the disposable deployed test Worker",
    );
    assert.deepEqual(await probe.json(), {
      runtime: false,
      kv: false,
      credentials: false,
      backups: [],
    });
  },
);
