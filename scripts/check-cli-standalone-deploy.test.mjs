import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  STANDALONE_DEPLOY_ARGS,
  STANDALONE_DEPLOY_ERROR,
  STANDALONE_DEPLOY_TIMEOUT_MS,
  assertStandaloneDeployFailure,
  checkCliStandaloneDeploy,
  standaloneDeployEnvironment,
} from "./check-cli-standalone-deploy.mjs";

const diagnostic = (overrides = {}) => ({
  version: 1,
  recordedAt: "2026-01-01T00:00:00.000Z",
  operation: "uninstall",
  phase: "apply",
  context: { installationName: "clean-room", profile: "clean-room" },
  cause: {
    name: "AuthError",
    message:
      "No credentials configured for 'cloudflare' in profile 'clean-room', and this process is non-interactive.",
  },
  ...overrides,
});

const failure = (overrides = {}) => ({
  status: 1,
  signal: null,
  stdout: `${JSON.stringify({ error: { ...STANDALONE_DEPLOY_ERROR, hint: "retry" } })}\n`,
  stderr: "",
  error: undefined,
  ...overrides,
});

const writeDiagnostic = (home, value = diagnostic()) => {
  const path = join(home, ".scotty", "diagnostics", "uninstall-apply.json");
  mkdirSync(join(home, ".scotty", "diagnostics"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

describe("standalone deployment clean-room proof", () => {
  it("builds through build-cli and runs uninstall in an isolated home and empty cwd", async () => {
    const calls = [];
    let runCwd;
    const result = await checkCliStandaloneDeploy({
      root: "/checkout",
      environment: {
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: "must-not-pass",
        ALCHEMY_PROFILE: "must-not-pass",
        GH_TOKEN: "must-not-pass",
        PI_AUTH_JSON: "must-not-pass",
        CREDENTIAL_WRAPPING_KEY: "must-not-pass",
      },
      execute: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "bun") {
          assert.deepEqual(args.slice(0, 1), ["scripts/build-cli.mjs"]);
          writeFileSync(args[1], "binary");
          return { status: 0, signal: null, stdout: "", stderr: "", error: undefined };
        }
        runCwd = options.cwd;
        assert.deepEqual(args, STANDALONE_DEPLOY_ARGS);
        assert.deepEqual(readdirSync(options.cwd), []);
        assert.equal(options.timeout, STANDALONE_DEPLOY_TIMEOUT_MS);
        assert.equal(options.killSignal, "SIGKILL");
        assert.equal(options.env.HOME, options.env.USERPROFILE);
        assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
        assert.equal(options.env.ALCHEMY_PROFILE, undefined);
        assert.equal(options.env.GH_TOKEN, undefined);
        assert.equal(options.env.PI_AUTH_JSON, undefined);
        assert.equal(options.env.CREDENTIAL_WRAPPING_KEY, undefined);
        assert.match(options.env.DOCKER_HOST, /scotty-clean-room/u);
        assert.ok(existsSync(join(options.env.HOME, ".scotty.json")));
        writeDiagnostic(options.env.HOME);
        return failure();
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.cwd, "/checkout");
    assert.equal(
      result.binary,
      process.platform === "win32" ? "scotty-clean-room.exe" : "scotty-clean-room",
    );
    assert.equal(result.diagnostic.operation, "uninstall");
    assert.equal(existsSync(runCwd), false);
  });

  it("accepts an existing release binary without rebuilding it", async () => {
    let binary;
    const result = await checkCliStandaloneDeploy({
      root: "/checkout",
      binaryPath: process.execPath,
      execute: (command, args, options) => {
        binary = command;
        assert.deepEqual(args, STANDALONE_DEPLOY_ARGS);
        writeDiagnostic(options.env.HOME);
        return failure();
      },
    });
    assert.equal(binary, process.execPath);
    assert.equal(result.binary, process.execPath);
  });

  it("passes through only the environment needed by the isolated process", () => {
    const clean = standaloneDeployEnvironment("/clean/home", "/clean/tmp", {
      PATH: "/bin",
      CI: "1",
      CLOUDFLARE_ACCOUNT_ID: "secret-account",
      CLOUDFLARE_API_TOKEN: "secret-token",
      NODE_PATH: "/checkout/node_modules",
    });
    assert.equal(clean.PATH, "/bin");
    assert.equal(clean.HOME, "/clean/home");
    assert.equal(clean.TMPDIR, "/clean/tmp");
    assert.equal(clean.CI, undefined);
    assert.equal(clean.CLOUDFLARE_ACCOUNT_ID, undefined);
    assert.equal(clean.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(clean.NODE_PATH, undefined);
  });

  it("accepts only the phase-aware Cloudflare credentials failure", () => {
    assert.equal(
      assertStandaloneDeployFailure(failure(), diagnostic(), { checkoutRoot: "/checkout" }).code,
      STANDALONE_DEPLOY_ERROR.code,
    );
    assert.throws(
      () =>
        assertStandaloneDeployFailure(failure(), diagnostic({ phase: "plan" }), {
          checkoutRoot: "/checkout",
        }),
      /phase was not apply/u,
    );
    assert.throws(
      () =>
        assertStandaloneDeployFailure(
          failure(),
          diagnostic({
            cause: { name: "InstallationDeploymentError", message: "generic failure" },
          }),
          { checkoutRoot: "/checkout" },
        ),
      /missing Cloudflare credentials boundary/u,
    );
    assert.throws(
      () =>
        assertStandaloneDeployFailure(
          failure(),
          diagnostic({
            cause: {
              name: "AuthError",
              message: "No credentials configured for 'cloudflare'",
            },
          }),
          { checkoutRoot: "/checkout" },
        ),
      /non-interactive credentials boundary/u,
    );
    assert.throws(
      () =>
        assertStandaloneDeployFailure(failure({ status: 0 }), diagnostic(), {
          checkoutRoot: "/checkout",
        }),
      /exited 0/u,
    );
    assert.throws(
      () =>
        assertStandaloneDeployFailure(
          failure({ error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }),
          diagnostic(),
          { checkoutRoot: "/checkout" },
        ),
      /failed to execute.*timed out/u,
    );
    assert.throws(
      () =>
        assertStandaloneDeployFailure(failure({ signal: "SIGKILL", status: null }), diagnostic(), {
          checkoutRoot: "/checkout",
        }),
      /terminated by SIGKILL/u,
    );
  });

  it("rejects packaging and checkout signatures from output or diagnostics", () => {
    for (const text of [
      "Embedded deployment archive is missing prebuilt worker bundles",
      "Prebuilt runner worker retains stack placeholders",
      "Container context exceeded its budget",
      "Cannot find module /checkout/node_modules/workerd",
      "loaded from $bunfs/root/cli",
    ]) {
      assert.throws(
        () =>
          assertStandaloneDeployFailure(failure({ stderr: text }), diagnostic(), {
            checkoutRoot: "/checkout",
          }),
        /forbidden output|source checkout path/u,
      );
    }
    assert.throws(
      () =>
        assertStandaloneDeployFailure(
          failure(),
          diagnostic({
            cause: {
              name: "AuthError",
              message:
                "No credentials configured for 'cloudflare'; non-interactive; /checkout/cli/src",
            },
          }),
          { checkoutRoot: "/checkout" },
        ),
      /source checkout path/u,
    );
  });
});
