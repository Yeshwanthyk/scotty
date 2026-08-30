import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDirectRun } from "./is-direct-run.mjs";
import { managedInstallationPath } from "../cli/src/managed-installation-path.mjs";

export const STANDALONE_DEPLOY_ARGS = Object.freeze(["uninstall", "--yes", "--json"]);
export const STANDALONE_DEPLOY_ERROR = Object.freeze({
  code: "installation_uninstall_failed",
  message: "Could not fully uninstall the Scotty installation",
});
export const STANDALONE_DEPLOY_EXIT_CODE = 1;
export const STANDALONE_DEPLOY_TIMEOUT_MS = 30_000;

const CLEAN_ROOM_CONFIG = Object.freeze({
  installationName: "clean-room",
  profile: "clean-room",
  accountId: "00000000000000000000000000000000",
  previewBase: "preview.clean-room.example",
  previewZoneId: "11111111111111111111111111111111",
  evidenceEnabled: true,
});
const FORBIDDEN_EARLY_PHASE_SIGNATURES = Object.freeze([
  /(?:embedded )?deployment archive/iu,
  /prebuilt/iu,
  /placeholders?/iu,
  /budget/iu,
  /workerd/iu,
  /module not found/iu,
  /cannot find (?:package|module)/iu,
  /node_modules/iu,
  /\$bunfs/iu,
]);

const assertCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const environmentValue = (environment, name) => {
  const value = environment[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const standaloneDeployEnvironment = (home, scratch, environment = process.env) => ({
  ...(environmentValue(environment, "PATH") ? { PATH: environment.PATH } : {}),
  ...(environmentValue(environment, "SystemRoot") ? { SystemRoot: environment.SystemRoot } : {}),
  ...(environmentValue(environment, "WINDIR") ? { WINDIR: environment.WINDIR } : {}),
  ...(environmentValue(environment, "PATHEXT") ? { PATHEXT: environment.PATHEXT } : {}),
  HOME: home,
  USERPROFILE: home,
  TMPDIR: scratch,
  TMP: scratch,
  TEMP: scratch,
  DOCKER_HOST:
    process.platform === "win32"
      ? "npipe:////./pipe/scotty-clean-room"
      : "unix:///scotty-clean-room/no-docker.sock",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
  ALCHEMY_TELEMETRY_DISABLED: "1",
});

export const runStandaloneProcess = (command, args, options) => {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
};

const readTypedError = (output) => {
  for (const line of output.split(/\r?\n/u).reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.error && typeof parsed.error === "object") return parsed.error;
    } catch {
      // Non-JSON diagnostic lines are rejected only when they match a forbidden signature.
    }
  }
  return undefined;
};

const diagnosticMessages = (cause) => {
  const messages = [];
  let current = cause;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (typeof current.message === "string") messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
};

const checkoutPaths = (checkoutRoot) =>
  new Set([
    resolve(checkoutRoot),
    (() => {
      try {
        return realpathSync.native(checkoutRoot);
      } catch {
        return undefined;
      }
    })(),
  ]);

export const assertStandaloneDeployFailure = (
  result,
  diagnostic,
  { checkoutRoot = process.cwd() } = {},
) => {
  assertCondition(
    result.error === undefined,
    `standalone deploy failed to execute: ${result.error}`,
  );
  assertCondition(result.signal === null, `standalone deploy was terminated by ${result.signal}`);
  assertCondition(
    result.status === STANDALONE_DEPLOY_EXIT_CODE,
    `standalone deploy exited ${String(result.status)} instead of ${STANDALONE_DEPLOY_EXIT_CODE}`,
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const error = readTypedError(output);
  assertCondition(error !== undefined, "standalone deploy did not emit a typed JSON error");
  assertCondition(
    error.code === STANDALONE_DEPLOY_ERROR.code,
    `standalone deploy emitted error code ${String(error.code)}`,
  );
  assertCondition(
    error.message === STANDALONE_DEPLOY_ERROR.message,
    `standalone deploy emitted message ${String(error.message)}`,
  );

  assertCondition(diagnostic?.operation === "uninstall", "diagnostic operation was not uninstall");
  assertCondition(diagnostic?.phase === "apply", "diagnostic phase was not apply");
  assertCondition(
    diagnostic?.context?.installationName === CLEAN_ROOM_CONFIG.installationName &&
      diagnostic?.context?.profile === CLEAN_ROOM_CONFIG.profile,
    "diagnostic did not contain the clean-room installation context",
  );
  const causeMessages = diagnosticMessages(diagnostic?.cause);
  assertCondition(
    /No credentials configured for 'cloudflare'/iu.test(causeMessages),
    "diagnostic did not prove the missing Cloudflare credentials boundary",
  );
  assertCondition(
    /non-interactive/u.test(causeMessages),
    "diagnostic did not prove the non-interactive credentials boundary",
  );

  const proofText = `${output}\n${JSON.stringify(diagnostic)}`;
  for (const pattern of FORBIDDEN_EARLY_PHASE_SIGNATURES) {
    assertCondition(
      !pattern.test(proofText),
      `standalone deploy leaked forbidden output: ${pattern}`,
    );
  }
  for (const checkoutPath of checkoutPaths(checkoutRoot)) {
    if (checkoutPath && checkoutPath !== dirname(checkoutPath)) {
      assertCondition(
        !proofText.includes(checkoutPath),
        "standalone deploy leaked a source checkout path",
      );
    }
  }
  return error;
};

const assertExtractedRootsCleaned = async (scratch) => {
  const entries = await readdir(scratch);
  const leaked = entries.filter((entry) => entry.startsWith("scotty-deployment-"));
  assertCondition(
    leaked.length === 0,
    `standalone deploy retained temp roots: ${leaked.join(", ")}`,
  );
};

export const checkCliStandaloneDeploy = async ({
  root = process.cwd(),
  binaryPath,
  environment = process.env,
  execute = runStandaloneProcess,
} = {}) => {
  const harnessRoot = await mkdtemp(join(tmpdir(), "scotty-cli-standalone-deploy-"));
  const home = join(harnessRoot, "home");
  const cwd = join(harnessRoot, "cwd");
  const scratch = join(harnessRoot, "tmp");
  const builtBinary = join(
    harnessRoot,
    process.platform === "win32" ? "scotty-clean-room.exe" : "scotty-clean-room",
  );
  const binary = resolve(binaryPath ?? builtBinary);
  let result;
  let diagnostic;
  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(cwd, { recursive: true }),
      mkdir(scratch, { recursive: true }),
    ]);
    const configPath = managedInstallationPath(home);
    await mkdir(dirname(configPath), { recursive: true });
    const configBody = `${JSON.stringify(CLEAN_ROOM_CONFIG, null, 2)}\n`;
    await writeFile(configPath, configBody, { mode: 0o600 });
    await chmod(configPath, 0o600);

    if (binaryPath === undefined) {
      const build = execute("bun", ["scripts/build-cli.mjs", binary], {
        cwd: resolve(root),
        env: standaloneDeployEnvironment(home, scratch, environment),
      });
      assertCondition(build.error === undefined, `standalone CLI build failed: ${build.error}`);
      assertCondition(
        build.status === 0 && build.signal === null,
        `standalone CLI build failed with exit ${String(build.status)}`,
      );
    } else {
      assertCondition(existsSync(binary), `standalone CLI binary does not exist: ${binary}`);
    }

    result = execute(binary, STANDALONE_DEPLOY_ARGS, {
      cwd,
      env: standaloneDeployEnvironment(home, scratch, environment),
      timeout: STANDALONE_DEPLOY_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const diagnosticPath = join(home, ".scotty", "diagnostics", "uninstall-apply.json");
    const diagnosticBody = await readFile(diagnosticPath, "utf8");
    diagnostic = JSON.parse(diagnosticBody);
    assertCondition(
      ((await stat(diagnosticPath)).mode & 0o777) === 0o600,
      "diagnostic mode was not 0600",
    );
    assertStandaloneDeployFailure(result, diagnostic, { checkoutRoot: root });
    assertCondition(
      (await readFile(configPath, "utf8")) === configBody,
      "failed uninstall changed local config",
    );
    assertCondition(
      (await readdir(cwd)).length === 0,
      "standalone deploy wrote into the empty cwd",
    );
    await assertExtractedRootsCleaned(scratch);
  } finally {
    await rm(harnessRoot, { recursive: true, force: true });
  }
  assertCondition(
    !existsSync(harnessRoot),
    `standalone deploy harness was not cleaned: ${harnessRoot}`,
  );
  return { binary: binaryPath === undefined ? basename(binary) : binary, result, diagnostic };
};

if (isDirectRun(import.meta.url, process.argv[1])) {
  const binaryPath = process.argv[2];
  await checkCliStandaloneDeploy({ binaryPath });
  process.stdout.write("Standalone deployment clean-room proof passed.\n");
}
