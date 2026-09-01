#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { formatCredentialToml } from "../e2e/support/credential-canary.mjs";
import {
  assertPortAvailable,
  formatLocalDevVars,
  labSystemEnvironment,
  processGroupAlive,
  readStartupLogTail,
  redact,
  removeLocalHarnessContainersForWorker,
  requireLocalInputs,
  ROOT,
  stopProcessGroup,
  terminateProcessGroup,
  waitForWorker,
} from "../e2e/support/local-worker.mjs";

export const LAB_DIRECTORY = path.join(ROOT, ".scotty-lab");
export const MANIFEST_PATH = path.join(LAB_DIRECTORY, "run.json");
export const LIFECYCLE_LOCK_PATH = path.join(LAB_DIRECTORY, "lifecycle.lock");
export const EVIDENCE_DIRECTORY = path.join(LAB_DIRECTORY, "evidence");
export const PROTECTED_SESSION_ID = "6ffa0a512819";
const PORT = 8791;
const RUN_ID_PATTERN = /^lab-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,31}$/u;
const STATUS_VALUES = new Set(["starting", "running", "cleanup-pending"]);
const GENERATED_PATH_NAMES = ["tokenFile", "cliHome", "persistPath", "envFile", "logFile"];

function isSafePid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

export function workerNameForRunId(runId) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Lab run ID is invalid");
  return `scotty-lab-${runId.slice("lab-".length)}`;
}

function privateRegularFile(file, label) {
  const info = lstatSync(file);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  const mode = info.mode & 0o777;
  if (mode !== 0o600) throw new Error(`${label} must be mode 0600, received ${mode.toString(8)}`);
  return info;
}

function validateExistingPath(file, label, predicate, kind) {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!predicate(info)) throw new Error(`${label} must be a non-symlink ${kind}`);
}

function privateMode(file, label) {
  return privateRegularFile(file, label).mode & 0o777;
}

export function writePrivateManifest(manifestPath, manifest, { exclusive = false } = {}) {
  const directory = path.dirname(manifestPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (exclusive) {
    let existing;
    try {
      existing = lstatSync(manifestPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing) {
      const error = new Error(`EEXIST: Manifest already exists at ${manifestPath}`);
      error.code = "EEXIST";
      throw error;
    }
  } else {
    try {
      const existing = lstatSync(manifestPath);
      if (!existing.isFile()) throw new Error("Lab manifest must be a regular file");
      if ((existing.mode & 0o777) !== 0o600) throw new Error("Lab manifest must be mode 0600");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, manifestPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function evidencePathsForRunId(runId, evidenceDirectory = EVIDENCE_DIRECTORY) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Lab run ID is invalid");
  const directory = path.join(evidenceDirectory, runId);
  return {
    directory,
    manifest: path.join(directory, "run.json"),
    commands: path.join(directory, "commands.jsonl"),
    workerLog: path.join(directory, "worker.log"),
  };
}

function unavailableObservation(reason) {
  return { status: "not-available", reason };
}

export function ensureEvidenceRun(manifest, evidenceDirectory = EVIDENCE_DIRECTORY) {
  const paths = evidencePathsForRunId(manifest.runId, evidenceDirectory);
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  chmodSync(evidenceDirectory, 0o700);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  chmodSync(paths.directory, 0o700);
  try {
    privateRegularFile(paths.manifest, "Lab evidence manifest");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    writePrivateManifest(
      paths.manifest,
      {
        version: 1,
        runId: manifest.runId,
        createdAt: manifest.createdAt,
        workerName: manifest.workerName,
        ownedSessionIds: [],
        scenarioResults: [],
        cleanupResult: { status: "not-run" },
        observations: {
          actorAuthorityRevision: unavailableObservation(
            "The public CLI does not expose the actor authority revision.",
          ),
          operationJournal: unavailableObservation(
            "The public CLI does not expose the actor operation journal.",
          ),
          providerSnapshot: unavailableObservation(
            "The public CLI does not expose provider state snapshots.",
          ),
        },
      },
      { exclusive: true },
    );
  }
  try {
    privateRegularFile(paths.commands, "Lab evidence command log");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    writeFileSync(paths.commands, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(paths.commands, 0o600);
  }
  return paths;
}

export function readEvidenceManifest(runId, evidenceDirectory = EVIDENCE_DIRECTORY) {
  const paths = evidencePathsForRunId(runId, evidenceDirectory);
  privateRegularFile(paths.manifest, "Lab evidence manifest");
  const parsed = JSON.parse(readFileSync(paths.manifest, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    parsed.runId !== runId ||
    !Array.isArray(parsed.ownedSessionIds) ||
    !Array.isArray(parsed.scenarioResults)
  ) {
    throw new Error("Lab evidence manifest is invalid");
  }
  return parsed;
}

function updateEvidenceManifest(manifest, update, evidenceDirectory = EVIDENCE_DIRECTORY) {
  ensureEvidenceRun(manifest, evidenceDirectory);
  const paths = evidencePathsForRunId(manifest.runId, evidenceDirectory);
  const current = readEvidenceManifest(manifest.runId, evidenceDirectory);
  writePrivateManifest(paths.manifest, update(current));
  return readEvidenceManifest(manifest.runId, evidenceDirectory);
}

export function recordOwnedSession(manifest, sessionId, recordedAt, evidenceDirectory) {
  assertLifecycleSessionId(sessionId);
  return updateEvidenceManifest(
    manifest,
    (current) => ({
      ...current,
      ownedSessionIds: current.ownedSessionIds.includes(sessionId)
        ? current.ownedSessionIds
        : [...current.ownedSessionIds, sessionId],
      sessionOwnershipUpdatedAt: recordedAt,
    }),
    evidenceDirectory,
  );
}

export function isOwnedSession(manifest, sessionId, evidenceDirectory) {
  assertLifecycleSessionId(sessionId);
  ensureEvidenceRun(manifest, evidenceDirectory);
  return readEvidenceManifest(manifest.runId, evidenceDirectory).ownedSessionIds.includes(
    sessionId,
  );
}

export function recordScenarioResult(manifest, result, evidenceDirectory) {
  return updateEvidenceManifest(
    manifest,
    (current) => ({ ...current, scenarioResults: [...current.scenarioResults, result] }),
    evidenceDirectory,
  );
}

export function recordCleanupResult(manifest, cleanupResult, evidenceDirectory) {
  return updateEvidenceManifest(
    manifest,
    (current) => ({ ...current, cleanupResult }),
    evidenceDirectory,
  );
}

export function recordActorDiagnostics(manifest, observation, evidenceDirectory) {
  assertLifecycleSessionId(observation.sessionId);
  return updateEvidenceManifest(
    manifest,
    (current) => ({
      ...current,
      observations: {
        ...current.observations,
        actorAuthorityRevision: {
          status: "available",
          snapshots: [
            ...(current.observations.actorAuthorityRevision.snapshots ?? []),
            {
              scenario: observation.scenario,
              sessionId: observation.sessionId,
              observedAt: observation.observedAt,
              revision: observation.diagnostics.revision,
              authority: observation.diagnostics.authority,
            },
          ],
        },
        operationJournal: {
          status: "available",
          snapshots: [
            ...(current.observations.operationJournal.snapshots ?? []),
            {
              scenario: observation.scenario,
              sessionId: observation.sessionId,
              observedAt: observation.observedAt,
              journalSequence: observation.diagnostics.journalSequence,
              journalTail: observation.diagnostics.journalTail,
              journal: observation.diagnostics.journal,
              journalTruncated: observation.diagnostics.journalTruncated,
            },
          ],
        },
      },
    }),
    evidenceDirectory,
  );
}

export function assertStableActorObservation(diagnostics, expectedStable) {
  const { authority, journalSequence, journalTail, revision } = diagnostics;
  if (
    authority.revision !== revision ||
    journalTail.revision !== revision ||
    journalTail.sequence !== journalSequence
  )
    throw new Error("Actor authority and journal revisions do not agree");
  const proofField = {
    Warm: "readiness",
    Sleeping: "wakeSource",
    Failed: "code",
    Gone: "cleanup",
  }[expectedStable];
  if (
    !Object.hasOwn(authority.state, "stable") ||
    !Object.hasOwn(authority.state.stable, proofField)
  )
    throw new Error(`Expected Stable(${expectedStable}) actor authority`);
  return diagnostics;
}

export function appendEvidenceCommand(manifest, record, evidenceDirectory) {
  const paths = ensureEvidenceRun(manifest, evidenceDirectory);
  privateRegularFile(paths.commands, "Lab evidence command log");
  const previous = readFileSync(paths.commands, "utf8");
  const temporaryPath = `${paths.commands}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${previous}${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, paths.commands);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function preserveWorkerLog(manifest, evidenceDirectory = EVIDENCE_DIRECTORY) {
  validateLabManifestPaths(manifest);
  let contents;
  try {
    privateRegularFile(manifest.logFile, "Lab Worker log");
    contents = readFileSync(manifest.logFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const paths = ensureEvidenceRun(manifest, evidenceDirectory);
  const temporaryPath = `${paths.workerLog}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, paths.workerLog);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return true;
}

export function assertLifecycleSessionId(sessionId) {
  if (sessionId === PROTECTED_SESSION_ID)
    throw new Error(`Session ${PROTECTED_SESSION_ID} is protected and must never be targeted`);
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Session ID is invalid");
  return sessionId;
}

export function recoverPendingCreateSessionId(manifest, body) {
  validateLabManifestPaths(manifest);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([manifest.host, body]))
    .digest("hex");
  const pendingPath = path.join(manifest.cliHome, ".scotty", "pending-up", `${fingerprint}.json`);
  privateRegularFile(pendingPath, "Lab pending create request");
  const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
  if (
    !pending ||
    typeof pending !== "object" ||
    Array.isArray(pending) ||
    typeof pending.key !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(pending.key) ||
    typeof pending.createdAt !== "string" ||
    !Number.isFinite(Date.parse(pending.createdAt))
  )
    throw new Error("Lab pending create request is invalid");
  return assertLifecycleSessionId(
    createHash("sha256").update(pending.key).digest("hex").slice(0, 12),
  );
}

function generatedPaths(tempRoot) {
  return {
    tokenFile: path.join(tempRoot, "root-token"),
    cliHome: path.join(tempRoot, "home"),
    persistPath: path.join(tempRoot, "wrangler-state"),
    envFile: path.join(tempRoot, ".dev.vars"),
    logFile: path.join(tempRoot, "wrangler.log"),
  };
}

function validProcessIdentity(value) {
  if (value.pid === undefined && value.processStartTime === undefined) return true;
  return (
    isSafePid(value.pid) &&
    typeof value.processStartTime === "string" &&
    value.processStartTime.length > 0
  );
}

function validManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.runId !== "string" || !RUN_ID_PATTERN.test(value.runId)) return false;
  if (value.workerName !== workerNameForRunId(value.runId)) return false;
  if (typeof value.status !== "string" || !STATUS_VALUES.has(value.status)) return false;
  if (!GENERATED_PATH_NAMES.every((name) => typeof value[name] === "string")) return false;
  if (typeof value.createdAt !== "string" || typeof value.tempRoot !== "string") return false;
  return (
    typeof value.host === "string" &&
    Number.isSafeInteger(value.port) &&
    validProcessIdentity(value)
  );
}

export function readLabManifest(manifestPath = MANIFEST_PATH) {
  privateMode(manifestPath, "Lab manifest");
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!validManifest(parsed)) throw new Error("Lab manifest is invalid");
  return parsed;
}

export function validateLabManifestPaths(manifest) {
  if (manifest.port !== PORT) throw new Error(`Lab port must be the fixed local port ${PORT}`);
  if (manifest.host !== `http://127.0.0.1:${manifest.port}`)
    throw new Error("Lab host must be the fixed local loopback host");
  if (!path.isAbsolute(manifest.tempRoot)) throw new Error("Lab temporary root must be absolute");
  const tempRoot = path.resolve(manifest.tempRoot);
  const temporaryParent = `${path.resolve(tmpdir())}${path.sep}`;
  if (
    !tempRoot.startsWith(temporaryParent) ||
    !path.basename(tempRoot).startsWith(`scotty-lab-${manifest.runId}-`)
  ) {
    throw new Error("Lab manifest temporary root is not owned by this run");
  }
  const expectedPaths = generatedPaths(tempRoot);
  for (const name of GENERATED_PATH_NAMES) {
    if (
      !path.isAbsolute(manifest[name]) ||
      path.resolve(manifest[name]) !== path.resolve(expectedPaths[name])
    ) {
      throw new Error(`Lab manifest ${name} is not the fixed generated path`);
    }
  }
  return tempRoot;
}

export function validateLabExecManifest(manifest) {
  if (manifest.status !== "running") throw new Error("The lab is not running");
  if (!isSafePid(manifest.pid)) throw new Error("The running lab has no safe process ID");
  validateLabManifestPaths(manifest);
  validateExistingPath(
    manifest.tempRoot,
    "Lab temporary root",
    (info) => info.isDirectory(),
    "directory",
  );
  validateExistingPath(manifest.cliHome, "Lab CLI HOME", (info) => info.isDirectory(), "directory");
  validateExistingPath(
    manifest.persistPath,
    "Wrangler state",
    (info) => info.isDirectory(),
    "directory",
  );
  validateExistingPath(manifest.envFile, "Lab env file", (info) => info.isFile(), "regular file");
  validateExistingPath(
    manifest.logFile,
    "Lab startup log",
    (info) => info.isFile(),
    "regular file",
  );
  return manifest;
}

export function readPrivateToken(tokenFile) {
  privateMode(tokenFile, "Lab root token");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error("Lab root token is empty");
  return token;
}

function processField(pid, field) {
  return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function readProcessSnapshot(pid) {
  if (!isSafePid(pid)) return undefined;
  try {
    process.kill(pid, 0);
    return {
      pid,
      pgid: Number(processField(pid, "pgid")),
      startTime: processField(pid, "lstart"),
      command: processField(pid, "command"),
    };
  } catch (error) {
    if (error?.code === "ESRCH" || error?.status === 1) return undefined;
    throw error;
  }
}

export function readProcessGroupSnapshots(pgid) {
  if (!isSafePid(pgid)) return [];
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/u.exec(line);
    if (!match || Number(match[3]) !== pgid) return [];
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        startTime: match[4],
        command: match[5],
      },
    ];
  });
}

export function validateLabProcess(manifest, snapshot) {
  if (!snapshot) return { status: "missing" };
  const expectedFragments = [
    "worker/wrangler.jsonc",
    manifest.workerName,
    manifest.persistPath,
    manifest.envFile,
    String(manifest.port),
  ];
  if (
    !isSafePid(manifest.pid) ||
    snapshot.pid !== manifest.pid ||
    snapshot.pgid !== manifest.pid ||
    snapshot.startTime !== manifest.processStartTime ||
    expectedFragments.some((fragment) => !snapshot.command.includes(fragment))
  ) {
    return { status: "mismatch" };
  }
  return { status: "owned" };
}

export function validateOrphanedLabProcessGroup(manifest, snapshots) {
  if (snapshots.length === 0) return { status: "missing" };
  const leaderStartedAt = Date.parse(manifest.processStartTime);
  const allowedCommands = [
    `${path.join(ROOT, "node_modules/@esbuild/")}`,
    `${path.join(ROOT, "node_modules/@cloudflare/workerd-")}`,
  ];
  const owned =
    Number.isFinite(leaderStartedAt) &&
    snapshots.every(
      (snapshot) =>
        isSafePid(snapshot.pid) &&
        snapshot.pid !== manifest.pid &&
        snapshot.pgid === manifest.pid &&
        Date.parse(snapshot.startTime) >= leaderStartedAt &&
        allowedCommands.some((prefix) => snapshot.command.startsWith(prefix)) &&
        (snapshot.command.includes("/bin/esbuild --service=") ||
          snapshot.command.includes("/bin/workerd serve ")),
    );
  return { status: owned ? "owned" : "mismatch" };
}

export function cleanupOwnedFiles(manifest, manifestPath = MANIFEST_PATH, remove = rmSync) {
  const errors = [];
  const tempRoot = validateLabManifestPaths(manifest);
  try {
    remove(tempRoot, { recursive: true, force: true });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length === 0) {
    try {
      remove(manifestPath, { force: true });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

export function acquireLifecycleLock() {
  mkdirSync(LAB_DIRECTORY, { recursive: true, mode: 0o700 });
  chmodSync(LAB_DIRECTORY, 0o700);
  try {
    return openSync(LIFECYCLE_LOCK_PATH, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error("Another Scotty lab lifecycle operation is already in progress");
    throw error;
  }
}

export function releaseLifecycleLock(descriptor) {
  try {
    closeSync(descriptor);
  } finally {
    rmSync(LIFECYCLE_LOCK_PATH, { force: true });
  }
}

export function createStartReservation(createdAt) {
  const runId = `lab-${randomUUID()}`;
  const tempRoot = mkdtempSync(path.join(tmpdir(), `scotty-lab-${runId}-`));
  chmodSync(tempRoot, 0o700);
  const paths = generatedPaths(tempRoot);
  const manifest = {
    version: 1,
    runId,
    workerName: workerNameForRunId(runId),
    status: "starting",
    createdAt,
    tempRoot,
    ...paths,
    host: `http://127.0.0.1:${PORT}`,
    port: PORT,
  };
  try {
    writePrivateManifest(MANIFEST_PATH, manifest, { exclusive: true });
    ensureEvidenceRun(manifest);
    return manifest;
  } catch (error) {
    try {
      const persisted = readLabManifest();
      if (persisted.runId === runId) rmSync(MANIFEST_PATH, { force: true });
    } catch {
      // The reservation either was never written or cannot be safely identified as this run.
    }
    rmSync(tempRoot, { recursive: true, force: true });
    if (error?.code === "EEXIST")
      throw new Error(`A Scotty lab already exists; stop the run recorded in ${MANIFEST_PATH}`);
    throw error;
  }
}

export async function prepareStart(manifest) {
  await assertPortAvailable(PORT);
  await assertPortAvailable(PORT + 1);
  const inputs = requireLocalInputs();
  mkdirSync(manifest.cliHome, { mode: 0o700 });
  writeFileSync(manifest.envFile, formatLocalDevVars(inputs), { mode: 0o600 });
  chmodSync(manifest.envFile, 0o600);
  writeFileSync(manifest.tokenFile, `${inputs.rootToken}\n`, { mode: 0o600 });
  chmodSync(manifest.tokenFile, 0o600);
  validateLabManifestPaths(manifest);
  return {
    dockerConfig: inputs.dockerConfig,
    dockerHost: inputs.dockerHost,
    secrets: [inputs.rootToken],
  };
}

export async function launchWrangler(manifest, prepared) {
  const log = [];
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, "scripts/scotty-lab-wrangler-supervisor.mjs"),
      "worker/wrangler.jsonc",
      manifest.envFile,
      manifest.persistPath,
      manifest.workerName,
      String(PORT),
      manifest.logFile,
    ],
    {
      cwd: ROOT,
      detached: true,
      env: labSystemEnvironment(manifest.cliHome, {
        DOCKER_CONFIG: prepared.dockerConfig,
        DOCKER_HOST: prepared.dockerHost,
      }),
      stdio: "ignore",
    },
  );
  const flushLog = () => {
    try {
      const contents = readFileSync(manifest.logFile, "utf8");
      log.splice(0, log.length, contents);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  const started = {
    child,
    log,
    flushLog,
  };
  try {
    if (!started.child.pid) throw new Error("Wrangler did not return a process ID");
    const snapshot = readProcessSnapshot(started.child.pid);
    if (!snapshot) throw new Error("Wrangler exited before its process identity was recorded");
    const recorded = { ...manifest, pid: started.child.pid, processStartTime: snapshot.startTime };
    writePrivateManifest(MANIFEST_PATH, recorded);
    return { manifest: recorded, started };
  } catch (error) {
    await stopProcessGroup(started.child);
    throw error;
  }
}

export async function awaitWrangler(manifest, started, signal) {
  await waitForWorker(manifest.host, started, { signal });
}

export async function terminateStartedWrangler(started) {
  await stopProcessGroup(started.child);
}

export function completeStart(manifest, started) {
  const running = { ...manifest, status: "running" };
  writePrivateManifest(MANIFEST_PATH, running);
  started.child.stdout?.unref?.();
  started.child.stderr?.unref?.();
  started.child.unref();
  return running;
}

export function startupFailureDetails(error, secrets, started, cleanupErrors) {
  const details = [redact(error instanceof Error ? error.message : String(error), secrets)];
  const logTail = readStartupLogTail(started);
  if (logTail) details.push(`Local Wrangler log tail:\n${logTail}`);
  if (cleanupErrors.length > 0) details.push(`Cleanup errors:\n${cleanupErrors.join("\n")}`);
  return details.join("\n\n");
}

export async function terminateManifestProcess(manifest) {
  const snapshot = isSafePid(manifest.pid) ? readProcessSnapshot(manifest.pid) : undefined;
  const validation = validateLabProcess(manifest, snapshot);
  if (validation.status === "mismatch") {
    return {
      validation,
      stopped: false,
      error: `Refusing to stop PID ${manifest.pid}: process ownership validation failed`,
    };
  }
  if (validation.status === "missing") {
    if (isSafePid(manifest.pid) && processGroupAlive(manifest.pid))
      await new Promise((resolve) => setTimeout(resolve, 250));
    if (isSafePid(manifest.pid) && processGroupAlive(manifest.pid)) {
      const orphanValidation = validateOrphanedLabProcessGroup(
        manifest,
        readProcessGroupSnapshots(manifest.pid),
      );
      if (orphanValidation.status !== "owned")
        return {
          validation: orphanValidation,
          stopped: false,
          error: `Refusing to signal process group ${manifest.pid}: orphan ownership validation failed`,
        };
      try {
        await terminateProcessGroup(manifest.pid);
      } catch (error) {
        return {
          validation: orphanValidation,
          stopped: !processGroupAlive(manifest.pid),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const stopped = !processGroupAlive(manifest.pid);
      return {
        validation: orphanValidation,
        stopped,
        ...(stopped
          ? {}
          : { error: "Orphaned Wrangler process group is still running after termination" }),
      };
    }
    return { validation, stopped: true };
  }
  try {
    await terminateProcessGroup(manifest.pid);
  } catch (error) {
    return {
      validation,
      stopped: !processGroupAlive(manifest.pid),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const stopped = !processGroupAlive(manifest.pid);
  return {
    validation,
    stopped,
    ...(stopped ? {} : { error: "Wrangler process group is still running after termination" }),
  };
}

export function removeWorkerContainers(manifest) {
  return removeLocalHarnessContainersForWorker(manifest.workerName);
}

export function removeOwnedTempRoot(manifest) {
  rmSync(validateLabManifestPaths(manifest), { recursive: true, force: true });
}

export function markCleanupPending(manifest) {
  writePrivateManifest(MANIFEST_PATH, { ...manifest, status: "cleanup-pending" });
}

export function execManifest(runId) {
  const manifest = readLabManifest();
  if (manifest.runId !== runId) throw new Error(`Unknown Scotty lab run: ${runId}`);
  validateLabExecManifest(manifest);
  const validation = validateLabProcess(manifest, readProcessSnapshot(manifest.pid));
  if (validation.status !== "owned") throw new Error("The lab Wrangler process is not running");
  return manifest;
}

export function activeRunManifest() {
  const manifest = readLabManifest();
  return execManifest(manifest.runId);
}

const shellWord = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

export function prepareCredentialSetup(manifest, repo, suppliedInputs) {
  validateLabExecManifest(manifest);
  const inputs =
    suppliedInputs ??
    Object.assign(requireLocalInputs(), {
      githubHome: homedir(),
      githubExecutable: execFileSync("which", ["gh"], { encoding: "utf8" }).trim(),
    });
  const configDirectory = path.join(manifest.cliHome, ".config", "scotty");
  const configPath = path.join(configDirectory, "scotty.toml");
  const credentialBin = path.join(manifest.cliHome, ".local", "credential-bin");
  const githubLauncher = path.join(credentialBin, "gh");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  validateExistingPath(
    configDirectory,
    "Lab Scotty config directory",
    (info) => info.isDirectory(),
    "directory",
  );
  chmodSync(configDirectory, 0o700);
  validateExistingPath(configPath, "Lab Scotty config", (info) => info.isFile(), "regular file");
  writeFileSync(configPath, formatCredentialToml({ repo, piAuthPath: inputs.piAuthPath }), {
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
  mkdirSync(credentialBin, { recursive: true, mode: 0o700 });
  chmodSync(credentialBin, 0o700);
  writeFileSync(
    githubLauncher,
    `#!/bin/sh\nexec env HOME=${shellWord(inputs.githubHome)} GH_CONFIG_DIR=${shellWord(inputs.githubConfigDir)} ${shellWord(inputs.githubExecutable)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(githubLauncher, 0o700);
  return { credentialBin };
}

export function spawnCli(manifest, argv, explicitEnvironment = {}, stdio = "inherit") {
  const rootToken = readPrivateToken(manifest.tokenFile);
  return spawn("bun", [path.join(ROOT, "cli/scotty.ts"), ...argv], {
    cwd: ROOT,
    env: labSystemEnvironment(manifest.cliHome, {
      SCOTTY_HOST: manifest.host,
      SCOTTY_TOKEN: rootToken,
      ...explicitEnvironment,
    }),
    stdio,
  });
}

export function sanitizeEvidenceText(manifest, value) {
  return redact(value, [readPrivateToken(manifest.tokenFile)]);
}

export async function sleepSession(manifest, sessionId, signal) {
  assertLifecycleSessionId(sessionId);
  const rootToken = readPrivateToken(manifest.tokenFile);
  const response = await fetch(
    new URL(`/api/sessions/${encodeURIComponent(sessionId)}/sleep`, manifest.host),
    {
      method: "POST",
      headers: { authorization: `Bearer ${rootToken}` },
      signal,
    },
  );
  const body = redact(await response.text(), [rootToken]);
  return { status: response.status, body };
}

export async function readActorDiagnostics(manifest, sessionId, signal) {
  assertLifecycleSessionId(sessionId);
  const rootToken = readPrivateToken(manifest.tokenFile);
  const response = await fetch(
    new URL(`/api/sessions/${encodeURIComponent(sessionId)}/actor`, manifest.host),
    {
      headers: { authorization: `Bearer ${rootToken}` },
      signal,
    },
  );
  const body = redact(await response.text(), [rootToken]);
  return { status: response.status, body };
}

export function stopManifest(runId, manifestPath = MANIFEST_PATH) {
  const manifest = readLabManifest(manifestPath);
  if (manifest.runId !== runId) throw new Error(`Unknown Scotty lab run: ${runId}`);
  validateLabManifestPaths(manifest);
  return manifest;
}
