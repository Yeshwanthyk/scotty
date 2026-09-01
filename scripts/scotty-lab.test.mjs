import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupOwnedFiles,
  appendEvidenceCommand,
  assertStableActorObservation,
  assertLifecycleSessionId,
  ensureEvidenceRun,
  evidencePathsForRunId,
  isOwnedSession,
  prepareCredentialSetup,
  preserveWorkerLog,
  readLabManifest,
  readEvidenceManifest,
  readPrivateToken,
  recoverPendingCreateSessionId,
  recordActorDiagnostics,
  recordCleanupResult,
  recordOwnedSession,
  recordScenarioResult,
  validateOrphanedLabProcessGroup,
  stopManifest,
  validateLabExecManifest,
  validateLabManifestPaths,
  validateLabProcess,
  workerNameForRunId,
  writePrivateManifest,
} from "./scotty-lab.mjs";
import { labSystemEnvironment, wranglerInvocation } from "../e2e/support/local-worker.mjs";

const RUN_ID = "lab-12345678-1234-4123-8123-123456789abc";

function fixtureManifest(tempRoot, overrides = {}) {
  return {
    version: 1,
    runId: RUN_ID,
    workerName: workerNameForRunId(RUN_ID),
    status: "running",
    createdAt: "2026-08-27T00:00:00.000Z",
    tempRoot,
    tokenFile: path.join(tempRoot, "root-token"),
    cliHome: path.join(tempRoot, "home"),
    persistPath: path.join(tempRoot, "wrangler-state"),
    envFile: path.join(tempRoot, ".dev.vars"),
    logFile: path.join(tempRoot, "wrangler.log"),
    host: "http://127.0.0.1:8791",
    port: 8791,
    pid: 4321,
    processStartTime: "Thu Aug 27 00:00:00 2026",
    ...overrides,
  };
}

test("lab manifests are private, atomically replaceable, and contain no credentials", () => {
  const root = mkdtempSync(path.join(tmpdir(), "scotty-lab-test-"));
  try {
    const manifestPath = path.join(root, "private", "run.json");
    const runRoot = path.join(tmpdir(), `scotty-lab-${RUN_ID}-fixture`);
    const manifest = fixtureManifest(runRoot);
    writePrivateManifest(manifestPath, manifest, { exclusive: true });
    assert.equal(statSync(path.dirname(manifestPath)).mode & 0o777, 0o700);
    assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
    assert.deepEqual(readLabManifest(manifestPath), manifest);
    const replacement = { ...manifest, status: "cleanup-pending" };
    writePrivateManifest(manifestPath, replacement);
    assert.deepEqual(readLabManifest(manifestPath), replacement);
    const serialized = readFileSync(manifestPath, "utf8");
    assert.doesNotMatch(serialized, /SCOTTY_TOKEN|root-token-value/u);
    assert.throws(
      () => writePrivateManifest(manifestPath, manifest, { exclusive: true }),
      /EEXIST/u,
    );

    const manifestLink = path.join(root, "manifest-link");
    symlinkSync(manifestPath, manifestLink);
    assert.throws(() => readLabManifest(manifestLink), /regular file/u);
    assert.throws(() => writePrivateManifest(manifestLink, replacement), /regular file/u);
    const manifestDirectory = path.join(root, "manifest-directory");
    mkdirSync(manifestDirectory);
    assert.throws(() => readLabManifest(manifestDirectory), /regular file/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed create ownership is recovered only from the exact private pending request", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), `scotty-lab-${RUN_ID}-pending-`));
  try {
    const manifest = fixtureManifest(tempRoot);
    const body = {
      title: "Scotty lifecycle lab",
      prompt: "Reply with exactly SCOTTY_LAB_READY.",
      provider: "cloudflare",
      repo: "owner/repo",
      cap: "30m",
      hardCapSeconds: 1_800,
    };
    const key = "12345678-1234-4123-8123-123456789abc";
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([manifest.host, body]))
      .digest("hex");
    const pendingDirectory = path.join(manifest.cliHome, ".scotty", "pending-up");
    const pendingPath = path.join(pendingDirectory, `${fingerprint}.json`);
    mkdirSync(pendingDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      pendingPath,
      `${JSON.stringify({ key, createdAt: "2026-09-01T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );

    assert.equal(
      recoverPendingCreateSessionId(manifest, body),
      createHash("sha256").update(key).digest("hex").slice(0, 12),
    );
    assert.throws(
      () => recoverPendingCreateSessionId(manifest, { ...body, repo: "other/repo" }),
      /ENOENT/u,
    );
    chmodSync(pendingPath, 0o644);
    assert.throws(() => recoverPendingCreateSessionId(manifest, body), /mode 0600/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("lifecycle evidence is private, atomic, retained, and explicit about unavailable observations", () => {
  const root = mkdtempSync(path.join(tmpdir(), "scotty-lab-evidence-test-"));
  const tempRoot = mkdtempSync(path.join(tmpdir(), `scotty-lab-${RUN_ID}-`));
  try {
    const manifest = fixtureManifest(tempRoot);
    const evidenceRoot = path.join(root, "evidence");
    const paths = ensureEvidenceRun(manifest, evidenceRoot);
    assert.equal(statSync(evidenceRoot).mode & 0o777, 0o700);
    assert.equal(statSync(paths.directory).mode & 0o777, 0o700);
    assert.equal(statSync(paths.manifest).mode & 0o777, 0o600);
    assert.equal(statSync(paths.commands).mode & 0o777, 0o600);

    appendEvidenceCommand(
      manifest,
      {
        scenario: "checkpoint",
        argv: ["snapshot", "a0b1c2d3e4f5", "--json"],
        stdout: '{"id":"a0b1c2d3e4f5","status":"warm"}\n',
        stderr: "",
        exitCode: 0,
        signal: null,
        startedAt: "2026-08-31T00:00:00.000Z",
        finishedAt: "2026-08-31T00:00:01.000Z",
        sessionId: "a0b1c2d3e4f5",
        sessionOwned: true,
      },
      evidenceRoot,
    );
    appendEvidenceCommand(
      manifest,
      {
        scenario: "hard-cap",
        argv: [],
        stdout: "",
        stderr: "not available",
        exitCode: 1,
        signal: null,
        startedAt: "2026-08-31T00:00:02.000Z",
        finishedAt: "2026-08-31T00:00:02.000Z",
        sessionId: "a0b1c2d3e4f5",
        sessionOwned: true,
      },
      evidenceRoot,
    );
    const commands = readFileSync(paths.commands, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0].argv, ["snapshot", "a0b1c2d3e4f5", "--json"]);
    assert.equal(commands[0].stdout.includes("warm"), true);
    assert.equal(commands[0].stderr, "");
    assert.equal(commands[0].exitCode, 0);
    assert.equal(commands[0].signal, null);
    assert.doesNotMatch(JSON.stringify(commands), /SCOTTY_TOKEN|root-token-value/u);
    assert.equal(
      readdirSync(paths.directory).some((name) => name.endsWith(".tmp")),
      false,
    );

    // Ownership is retained even when the create response is not ready yet.
    recordOwnedSession(manifest, "a0b1c2d3e4f5", "2026-08-31T00:00:03.000Z", evidenceRoot);
    recordScenarioResult(
      manifest,
      {
        scenario: "create-and-ready",
        status: "failed",
        sessionId: "a0b1c2d3e4f5",
        reason: "Expected warm, received booting",
      },
      evidenceRoot,
    );
    recordActorDiagnostics(
      manifest,
      {
        scenario: "checkpoint",
        sessionId: "a0b1c2d3e4f5",
        observedAt: "2026-08-31T00:00:04.500Z",
        diagnostics: {
          revision: 2,
          authority: { state: { _tag: "Stable", stable: { _tag: "Warm" } } },
          journalSequence: 2,
          journalTail: { sequence: 2, resultCode: "checkpoint_complete" },
          journal: [
            { sequence: 1, resultCode: "create_complete" },
            { sequence: 2, resultCode: "checkpoint_complete" },
          ],
          journalTruncated: false,
        },
      },
      evidenceRoot,
    );
    recordScenarioResult(
      manifest,
      {
        scenario: "checkpoint",
        status: "not-available",
        sessionId: "a0b1c2d3e4f5",
        fault: "after-intent-commit",
        reason: "Fault injection is not available",
      },
      evidenceRoot,
    );
    recordScenarioResult(
      manifest,
      {
        scenario: "vaporize",
        status: "rejected",
        sessionId: "b0b1c2d3e4f5",
        reason: "Session is not owned by this run",
      },
      evidenceRoot,
    );
    assert.equal(isOwnedSession(manifest, "a0b1c2d3e4f5", evidenceRoot), true);
    assert.equal(isOwnedSession(manifest, "b0b1c2d3e4f5", evidenceRoot), false);
    assert.throws(() => assertLifecycleSessionId("6ffa0a512819"), /protected/u);
    assert.throws(
      () => recordOwnedSession(manifest, "6ffa0a512819", "2026-08-31T00:00:04.000Z", evidenceRoot),
      /protected/u,
    );

    recordCleanupResult(
      manifest,
      { status: "succeeded", finishedAt: "2026-08-31T00:00:05.000Z", errors: [] },
      evidenceRoot,
    );
    rmSync(tempRoot, { recursive: true, force: true });
    const evidence = readEvidenceManifest(RUN_ID, evidenceRoot);
    assert.deepEqual(evidence.ownedSessionIds, ["a0b1c2d3e4f5"]);
    assert.equal(evidence.scenarioResults[0].status, "failed");
    assert.equal(evidence.scenarioResults[1].status, "not-available");
    assert.equal(evidence.scenarioResults[1].fault, "after-intent-commit");
    assert.equal(evidence.scenarioResults[2].status, "rejected");
    assert.equal(evidence.cleanupResult.status, "succeeded");
    assert.equal(evidence.observations.actorAuthorityRevision.status, "available");
    assert.equal(evidence.observations.actorAuthorityRevision.snapshots[0].revision, 2);
    assert.equal(evidence.observations.operationJournal.status, "available");
    assert.equal(evidence.observations.operationJournal.snapshots[0].journal.length, 2);
    assert.equal(evidence.observations.providerSnapshot.status, "not-available");
    assert.equal(statSync(evidencePathsForRunId(RUN_ID, evidenceRoot).manifest).isFile(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("cleanup evidence preserves the private Worker log outside the temporary root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "scotty-lab-log-test-"));
  const tempRoot = mkdtempSync(path.join(tmpdir(), `scotty-lab-${RUN_ID}-`));
  try {
    const manifest = fixtureManifest(tempRoot);
    writeFileSync(manifest.logFile, "redacted worker failure\n", { mode: 0o600 });
    const evidenceRoot = path.join(root, "evidence");
    assert.equal(preserveWorkerLog(manifest, evidenceRoot), true);
    const log = evidencePathsForRunId(RUN_ID, evidenceRoot).workerLog;
    assert.equal(readFileSync(log, "utf8"), "redacted worker failure\n");
    assert.equal(statSync(log).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("lifecycle success requires matching stable authority and journal revisions", () => {
  const diagnostics = {
    authority: {
      revision: 7,
      state: { _tag: "Stable", stable: { _tag: "Warm", readiness: {} } },
    },
    revision: 7,
    journalSequence: 9,
    journalTail: { revision: 7, sequence: 9 },
  };
  assert.equal(assertStableActorObservation(diagnostics, "Warm"), diagnostics);
  assert.throws(
    () =>
      assertStableActorObservation(
        { ...diagnostics, authority: { revision: 7, state: { _tag: "Transitioning" } } },
        "Warm",
      ),
    /Stable\(Warm\)/u,
  );
  assert.throws(
    () =>
      assertStableActorObservation(
        { ...diagnostics, journalTail: { revision: 6, sequence: 9 } },
        "Warm",
      ),
    /revisions do not agree/u,
  );
});

test("lab stop recovers a persisted starting reservation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "scotty-lab-starting-test-"));
  const tempRoot = mkdtempSync(path.join(tmpdir(), `scotty-lab-${RUN_ID}-`));
  try {
    const manifestPath = path.join(root, "run.json");
    const manifest = fixtureManifest(tempRoot, {
      status: "starting",
      pid: undefined,
      processStartTime: undefined,
    });
    writePrivateManifest(manifestPath, manifest);
    const recovered = stopManifest(RUN_ID, manifestPath);
    assert.equal(recovered.runId, RUN_ID);
    assert.equal(recovered.status, "starting");
    assert.equal(recovered.pid, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("lab exec validation requires running state, a safe PID, and fixed local paths", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), `scotty-lab-${RUN_ID}-`));
  const manifest = fixtureManifest(tempRoot);
  try {
    mkdirSync(manifest.cliHome);
    mkdirSync(manifest.persistPath);
    writeFileSync(manifest.envFile, "", { mode: 0o600 });
    writeFileSync(manifest.logFile, "", { mode: 0o600 });
    assert.equal(validateLabExecManifest(manifest), manifest);
    assert.throws(
      () => validateLabExecManifest({ ...manifest, status: "starting" }),
      /not running/u,
    );
    for (const pid of [undefined, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateLabExecManifest({ ...manifest, pid }), /safe process ID/u);
    }
    for (const name of ["tokenFile", "cliHome", "persistPath", "envFile", "logFile"]) {
      assert.throws(
        () => validateLabExecManifest({ ...manifest, [name]: path.join(tempRoot, "other") }),
        /fixed generated path/u,
      );
    }
    assert.throws(
      () => validateLabExecManifest({ ...manifest, host: "http://127.0.0.1:8792" }),
      /loopback host/u,
    );
    assert.throws(() => validateLabExecManifest({ ...manifest, port: 8792 }), /fixed local port/u);
    assert.throws(
      () => validateLabManifestPaths({ ...manifest, tempRoot: "/tmp/elsewhere" }),
      /owned by this run/u,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("lab process validation requires the recorded PID, group, start time, worker, and Wrangler paths", () => {
  const manifest = fixtureManifest(path.join(tmpdir(), `scotty-lab-${RUN_ID}-fixture`));
  const command = [
    "node wrangler dev --config worker/wrangler.jsonc",
    `--name ${manifest.workerName}`,
    `--persist-to ${manifest.persistPath}`,
    `--env-file ${manifest.envFile}`,
    "--port 8791",
  ].join(" ");
  const owned = {
    pid: manifest.pid,
    pgid: manifest.pid,
    startTime: manifest.processStartTime,
    command,
  };
  assert.deepEqual(validateLabProcess(manifest, owned), { status: "owned" });
  assert.deepEqual(validateLabProcess(manifest, undefined), { status: "missing" });
  assert.deepEqual(validateLabProcess(manifest, { ...owned, pgid: 7 }), { status: "mismatch" });
  assert.deepEqual(validateLabProcess(manifest, { ...owned, startTime: "later" }), {
    status: "mismatch",
  });
  assert.deepEqual(validateLabProcess(manifest, { ...owned, command: "unrelated process" }), {
    status: "mismatch",
  });
});

test("orphan cleanup accepts only known repo-local Wrangler children", () => {
  const manifest = fixtureManifest(path.join(tmpdir(), `scotty-lab-${RUN_ID}-fixture`));
  const child = {
    pid: 4322,
    ppid: 1,
    pgid: manifest.pid,
    startTime: "Thu Aug 27 00:00:01 2026",
    command: `${path.join(
      process.cwd(),
      "node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd",
    )} serve --binary`,
  };
  assert.deepEqual(validateOrphanedLabProcessGroup(manifest, [child]), { status: "owned" });
  assert.deepEqual(validateOrphanedLabProcessGroup(manifest, []), { status: "missing" });
  assert.deepEqual(
    validateOrphanedLabProcessGroup(manifest, [{ ...child, command: "/usr/bin/unrelated" }]),
    { status: "mismatch" },
  );
  assert.deepEqual(validateOrphanedLabProcessGroup(manifest, [{ ...child, pgid: 7 }]), {
    status: "mismatch",
  });
  assert.deepEqual(
    validateOrphanedLabProcessGroup(manifest, [
      { ...child, startTime: "Wed Aug 26 23:59:59 2026" },
    ]),
    { status: "mismatch" },
  );
});

test("lab token files must be private regular files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "scotty-lab-token-test-"));
  try {
    const token = path.join(root, "root-token");
    writeFileSync(token, "root-token-value\n", { mode: 0o600 });
    assert.equal(readPrivateToken(token), "root-token-value");
    const link = path.join(root, "token-link");
    symlinkSync(token, link);
    assert.throws(() => readPrivateToken(link), /regular file/u);
    const directory = path.join(root, "token-directory");
    mkdirSync(directory);
    assert.throws(() => readPrivateToken(directory), /regular file/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lab child environments keep only benign system values and explicit lab values", () => {
  const environment = labSystemEnvironment(
    "/tmp/scotty-lab-home",
    {
      SCOTTY_HOST: "http://127.0.0.1:8791",
      SCOTTY_TOKEN: "root-token",
      PATH: "/explicit/bin:/bin",
    },
    {
      PATH: "/bin",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      HOME: "/real/home",
      CLOUDFLARE_API_TOKEN: "cloudflare-secret",
      SCOTTY_TOKEN: "ambient-secret",
      GH_CONFIG_DIR: "/real/gh-config",
    },
  );
  assert.equal(environment.PATH, "/explicit/bin:/bin");
  assert.equal(environment.DOCKER_HOST, "unix:///tmp/docker.sock");
  assert.equal(environment.HOME, "/tmp/scotty-lab-home");
  assert.equal(environment.SCOTTY_HOST, "http://127.0.0.1:8791");
  assert.equal(environment.SCOTTY_TOKEN, "root-token");
  assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(environment.GH_CONFIG_DIR, undefined);
});

test("lab credential setup writes only private source pointers", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), `scotty-lab-${RUN_ID}-`));
  try {
    const manifest = fixtureManifest(tempRoot);
    mkdirSync(manifest.cliHome, { mode: 0o700 });
    const setup = prepareCredentialSetup(manifest, "owner/repo", {
      piAuthPath: "/private/pi-auth.json",
      githubConfigDir: "/private/gh-config",
      githubHome: "/private/home",
      githubExecutable: "/opt/bin/gh",
    });
    const configPath = path.join(manifest.cliHome, ".config", "scotty", "scotty.toml");
    const githubLauncher = path.join(setup.credentialBin, "gh");
    const config = readFileSync(configPath, "utf8");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(statSync(githubLauncher).mode & 0o777, 0o700);
    assert.match(config, /^allowed = \["owner\/repo"\]$/mu);
    assert.match(config, /^source = "\/private\/pi-auth\.json"$/mu);
    assert.doesNotMatch(config, /token|credential value/iu);
    assert.equal(
      readFileSync(githubLauncher, "utf8"),
      "#!/bin/sh\nexec env HOME='/private/home' GH_CONFIG_DIR='/private/gh-config' '/opt/bin/gh' \"$@\"\n",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Wrangler lab invocations carry the run-specific worker name", () => {
  const workerName = workerNameForRunId(RUN_ID);
  const invocation = wranglerInvocation({
    envFile: "/tmp/scotty-lab.env",
    persistPath: "/tmp/scotty-lab-state",
    port: 8791,
    name: workerName,
  });
  const nameIndex = invocation.args.indexOf("--name");
  assert.notEqual(nameIndex, -1);
  assert.equal(invocation.args[nameIndex + 1], workerName);
});

test("lab cleanup removes only an owned temporary root and keeps the manifest after a failure", () => {
  const labRoot = mkdtempSync(path.join(tmpdir(), "scotty-lab-manifest-test-"));
  const tempRoot = mkdtempSync(path.join(tmpdir(), `scotty-lab-${RUN_ID}-`));
  const manifestPath = path.join(labRoot, "run.json");
  const manifest = fixtureManifest(tempRoot);
  writeFileSync(path.join(tempRoot, "root-token"), "secret", { mode: 0o600 });
  writePrivateManifest(manifestPath, manifest);

  const failed = cleanupOwnedFiles(manifest, manifestPath, () => {
    throw new Error("remove failed");
  });
  assert.deepEqual(failed, ["remove failed"]);
  assert.equal(readLabManifest(manifestPath).runId, RUN_ID);

  assert.deepEqual(cleanupOwnedFiles(manifest, manifestPath), []);
  assert.equal(statSync(labRoot).isDirectory(), true);
  assert.throws(() => statSync(tempRoot), /ENOENT/u);
  assert.throws(() => statSync(manifestPath), /ENOENT/u);
  rmSync(labRoot, { recursive: true, force: true });
});

test("lab cleanup rejects temporary paths outside the run-owned root", () => {
  const manifest = fixtureManifest(path.join(tmpdir(), `scotty-lab-${RUN_ID}-fixture`));
  manifest.tokenFile = path.join(tmpdir(), "someone-elses-token");
  assert.throws(() => cleanupOwnedFiles(manifest, "/tmp/unused"), /fixed generated path/u);
});
