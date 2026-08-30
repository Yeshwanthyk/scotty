import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
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
  prepareCredentialSetup,
  readLabManifest,
  readPrivateToken,
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
