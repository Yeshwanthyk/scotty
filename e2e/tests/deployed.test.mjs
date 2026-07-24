import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git, poll, runCli } from "../support/harness.mjs";

const REQUIRED = [
  "SCOTTY_E2E_DEPLOYED",
  "SCOTTY_E2E_STAGE",
  "SCOTTY_E2E_HOST",
  "SCOTTY_E2E_TOKEN",
  "SCOTTY_E2E_REPO",
  "SCOTTY_E2E_LOCAL_REPO",
  "SCOTTY_E2E_CAP",
  "SCOTTY_E2E_CONFIRM_DESTRUCTIVE",
];
const missing = REQUIRED.filter((name) => !process.env[name]);
const stage = process.env.SCOTTY_E2E_STAGE ?? "";
const host = process.env.SCOTTY_E2E_HOST ?? "";
const stagePrefix = "scotty-e2e-";
const expectedWorkerPrefix = `scotty-e2e-${stage.slice(stagePrefix.length, stagePrefix.length + 24)}-worker.`;
const isolated =
  /^scotty-e2e-[a-f0-9]{32}$/u.test(stage) &&
  (() => {
    try {
      return new URL(host).hostname.startsWith(expectedWorkerPrefix);
    } catch {
      return false;
    }
  })();
const enabled =
  missing.length === 0 &&
  process.env.SCOTTY_E2E_DEPLOYED === "1" &&
  process.env.SCOTTY_E2E_CONFIRM_DESTRUCTIVE === `destroy:${stage}:disposable` &&
  isolated;
const skipReason = enabled
  ? false
  : `deployed E2E skipped: ${
      missing.length
        ? `set ${missing.join(", ")}`
        : "use an isolated scotty-e2e-<32 hex> stage, its matching Worker host, and the exact stage-scoped destructive confirmation"
    }`;
if (process.env.SCOTTY_E2E_EXPLICIT === "1" && !enabled) throw new Error(skipReason);

const authorization = () => ({ authorization: `Bearer ${process.env.SCOTTY_E2E_TOKEN}` });

const canaryRequest = async (pathname, init) => {
  const response = await fetch(`${host}${pathname}`, {
    ...init,
    headers: { ...authorization(), ...init?.headers },
  });
  const expectedStatus = init?.expectedStatus ?? 200;
  if (response.status !== expectedStatus) {
    assert.fail(
      `expected HTTP ${expectedStatus}, received ${response.status}: ${await response.text()}`,
    );
  }
  return response;
};

const probe = async (id) => {
  const response = await canaryRequest(`/__e2e/probe/${id}`);
  return response.json();
};

const waitForTerminalRoundTrip = async (id, clientId, command, marker) => {
  const ticketResponse = await canaryRequest(`/api/sessions/${id}/pty-ticket`, {
    method: "POST",
  });
  const ticket = await ticketResponse.json();
  assert.equal(typeof ticket.credential, "string");
  const websocketUrl = new URL(`${host}/api/sessions/${id}/pty`);
  websocketUrl.protocol = "wss:";
  websocketUrl.searchParams.set("client", clientId);
  websocketUrl.searchParams.set("cols", "100");
  websocketUrl.searchParams.set("rows", "30");
  websocketUrl.searchParams.set("ticket", ticket.credential);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    socket.binaryType = "arraybuffer";
    let output = "";
    let commandSent = false;
    let complete = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`terminal round-trip timed out waiting for ${marker}`));
    }, 120_000);
    socket.addEventListener("message", async (event) => {
      if (typeof event.data === "string") {
        const control = JSON.parse(event.data);
        if (control.type === "ready" && !commandSent) {
          commandSent = true;
          socket.send(new TextEncoder().encode(command));
        }
        return;
      }
      const bytes =
        event.data instanceof Blob
          ? new Uint8Array(await event.data.arrayBuffer())
          : new Uint8Array(event.data);
      output += new TextDecoder().decode(bytes);
      if (!output.includes(marker) || complete) return;
      complete = true;
      clearTimeout(timer);
      socket.close(1000, "E2E round-trip complete");
    });
    socket.addEventListener("close", () => {
      if (!complete) return;
      resolve(output);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`terminal WebSocket failed for ${id}`));
    });
  });
};

const noOrphans = (value) =>
  value.runtime === false &&
  value.kv === false &&
  value.credentials === false &&
  value.backups?.length === 0 &&
  value.schedules?.length === 0 &&
  value.activeLease === false &&
  value.alarm === false &&
  value.createIdempotency === false &&
  value.terminalAttachments === 0;

test(
  "deployed canary: up/attach/reconnect/snapshot/hard-cap/resume/down/vaporize leaves no orphans",
  { skip: skipReason, timeout: 20 * 60_000 },
  async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scotty-deployed-e2e-home-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = {
      HOME: home,
      SCOTTY_HOST: host,
      SCOTTY_TOKEN: process.env.SCOTTY_E2E_TOKEN,
    };
    const cwd = process.env.SCOTTY_E2E_LOCAL_REPO;
    assert.ok(
      fs.statSync(cwd).isDirectory(),
      "SCOTTY_E2E_LOCAL_REPO must be a local checkout of SCOTTY_E2E_REPO",
    );
    let id;
    let remoteBranch;
    t.after(async () => {
      if (id)
        await runCli(["vaporize", id, "--yes", "--json"], {
          env,
          cwd,
          timeoutMs: 180_000,
        });
      if (remoteBranch) await git(["push", "origin", "--delete", remoteBranch], cwd);
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
      { env, cwd, timeoutMs: 300_000 },
    );
    assert.equal(up.code, 0, up.stderr);
    id = up.json.id;
    remoteBranch = up.json.branch;
    assert.equal(up.json.status, "warm");

    const attach = await runCli(["attach", id, "--json"], { env, cwd });
    assert.equal(attach.code, 0, attach.stderr);
    assert.deepEqual(attach.json, {
      id,
      url: `${host}/s/${id}`,
      opened: true,
    });

    const rolloutId = "11111111-2222-4333-8444-555555555555";
    const firstOutput = await waitForTerminalRoundTrip(
      id,
      "a1b2c3d4e5f6",
      `mkdir -p "$CODEX_HOME/sessions/2026/07/24"; printf '%s\\n' '{"type":"session_meta","payload":{"id":"${rolloutId}"}}' > "$CODEX_HOME/sessions/2026/07/24/rollout-2026-07-24T00-00-00-${rolloutId}.jsonl"; printf runtime-survived > /tmp/scotty-e2e-runtime-marker; git push -u origin HEAD && printf '\\nSCOTTY_E2E_PUSHED\\n'\n`,
      "SCOTTY_E2E_PUSHED",
    );
    assert.match(firstOutput, /SCOTTY_E2E_PUSHED/u);

    const secondOutput = await waitForTerminalRoundTrip(
      id,
      "b1c2d3e4f5a6",
      `test "$(cat /tmp/scotty-e2e-runtime-marker)" = runtime-survived && printf '\\nSCOTTY_E2E_RECONNECTED\\n'\n`,
      "SCOTTY_E2E_RECONNECTED",
    );
    assert.match(secondOutput, /SCOTTY_E2E_RECONNECTED/u);

    await poll(
      () => probe(id),
      (value) => value.terminalAttachments === 0,
      { timeoutMs: 60_000, intervalMs: 1_000 },
    );

    const snapshot = await runCli(["snapshot", id, "--json"], {
      env,
      cwd,
      timeoutMs: 180_000,
    });
    assert.equal(snapshot.code, 0, snapshot.stderr);
    const wrongResume = await runCli(["resume", id, "--json"], { env, cwd });
    assert.equal(wrongResume.code, 5, wrongResume.stderr);

    const beforeReconstruction = await probe(id);
    assert.equal(beforeReconstruction.authorityStatus, "warm");
    assert.equal(beforeReconstruction.credentials, true);
    assert.equal(beforeReconstruction.kv, true);
    assert.ok(beforeReconstruction.backups.length > 0);
    assert.deepEqual(beforeReconstruction.security, {
      defaultDeny: true,
      kvNonSecret: true,
      sentinelsOnly: true,
    });
    assert.ok(beforeReconstruction.schedules.includes("enforceHardCap"));

    await fetch(`${host}/__e2e/reconstruct/${id}`, {
      method: "POST",
      headers: authorization(),
    }).catch(() => undefined);
    const reconstructed = await poll(
      () => probe(id),
      (value) => value.incarnation !== beforeReconstruction.incarnation,
      { timeoutMs: 60_000, intervalMs: 1_000 },
    );
    assert.equal(reconstructed.authorityStatus, "warm");
    assert.equal(reconstructed.credentials, true);
    assert.equal(reconstructed.kv, true);

    const timeoutMs = Number(process.env.SCOTTY_E2E_CAP_TIMEOUT_MS ?? 600_000);
    await poll(
      async () => runCli(["ls", "--json"], { env, cwd, timeoutMs: 30_000 }),
      (result) =>
        result.code === 0 &&
        result.json?.find((session) => session.id === id)?.status === "sleeping",
      { timeoutMs, intervalMs: 5_000 },
    );
    const sleeping = await probe(id);
    assert.equal(sleeping.authorityStatus, "sleeping");
    assert.equal(sleeping.runtime, false);
    assert.ok(sleeping.backups.length > 0);

    const resume = await runCli(["resume", id, "--json"], {
      env,
      cwd,
      timeoutMs: 300_000,
    });
    assert.equal(resume.code, 0, resume.stderr);
    const resumed = await probe(id);
    assert.equal(resumed.runtime, true);
    assert.deepEqual(resumed.security, {
      defaultDeny: true,
      kvNonSecret: true,
      sentinelsOnly: true,
    });

    const down = await runCli(["down", id, "--json"], { env, cwd, timeoutMs: 180_000 });
    assert.equal(down.code, 0, down.stderr);
    assert.equal(fs.statSync(down.json.rolloutPath).mode & 0o777, 0o600);
    assert.equal(down.json.sha, await git(["rev-parse", "FETCH_HEAD"], cwd));
    await git(["push", "origin", "--delete", remoteBranch], cwd);
    remoteBranch = undefined;

    const vaporize = await runCli(["vaporize", id, "--yes", "--json"], {
      env,
      cwd,
      timeoutMs: 180_000,
    });
    assert.equal(vaporize.code, 0, vaporize.stderr);
    const vaporizedId = id;
    id = undefined;
    const list = await runCli(["ls", "--json"], { env, cwd });
    assert.equal(
      list.json.some((session) => session.id === vaporizedId),
      false,
      "KV projection must be removed",
    );
    const cleaned = await poll(() => probe(vaporizedId), noOrphans, {
      timeoutMs: 180_000,
      intervalMs: 2_000,
    });
    assert.equal(cleaned.authorityStatus, "gone");
    assert.equal(cleaned.security, null);
  },
);
