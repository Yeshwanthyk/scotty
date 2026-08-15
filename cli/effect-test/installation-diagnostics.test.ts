import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { CliError, EXIT } from "../src/core.ts";
import { FAILURE_OUTPUT_TAIL_CHARACTERS } from "../src/deployment-redaction.ts";
import {
  installationCommandFailure,
  persistInstallationFailureDiagnostic,
  renderInstallationFailureDiagnostic,
} from "../src/installation-diagnostics.ts";

const SECRET = "ghp_syntheticDiagnosticSecretValue";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const failed = <A>(result: Result.Result<A, CliError>): CliError => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("installation failure diagnostics", () => {
  it("redacts secrets and account identity while preserving a bounded cause", () => {
    const rendered = renderInstallationFailureDiagnostic({
      recordedAt: "2026-08-13T00:00:00.000Z",
      operation: "init",
      phase: "create",
      context: { installationName: "home", profile: "default" },
      cause: {
        _tag: "InstallationDeploymentError",
        name: "InstallationDeploymentError",
        message: `Alchemy failed for ${ACCOUNT} token ${SECRET}`,
        cause: { message: `nested ${SECRET} ${"overflow".repeat(20_000)}` },
      },
      environment: { CLOUDFLARE_API_TOKEN: SECRET },
    });

    assert.equal(rendered.includes(SECRET), false);
    assert.equal(rendered.includes(ACCOUNT), false);
    assert.ok(rendered.includes("[redacted-secret]"));
    assert.ok(rendered.includes("[redacted-account-id]"));
    assert.ok(rendered.includes('"operation": "init"'));
    assert.ok(rendered.includes('"phase": "create"'));
    assert.ok(rendered.includes("Alchemy failed"));
    assert.ok(rendered.includes("nested"));
    assert.ok(rendered.length < FAILURE_OUTPUT_TAIL_CHARACTERS * 3);
  });

  it("projects bounded primitive rejection causes", () => {
    const stringCause = renderInstallationFailureDiagnostic({
      recordedAt: "2026-08-13T00:00:00.000Z",
      operation: "deploy",
      phase: "apply",
      context: { installationName: "home", profile: "default" },
      cause: "Alchemy rejected apply",
    });
    assert.ok(stringCause.includes('"message": "Alchemy rejected apply"'));

    const nestedPrimitive = renderInstallationFailureDiagnostic({
      recordedAt: "2026-08-13T00:00:00.000Z",
      operation: "deploy",
      phase: "apply",
      context: { installationName: "home", profile: "default" },
      cause: { message: "outer", cause: 42 },
    });
    assert.ok(nestedPrimitive.includes('"message": "outer"'));
    assert.ok(nestedPrimitive.includes('"message": "42"'));

    const booleanCause = renderInstallationFailureDiagnostic({
      recordedAt: "2026-08-13T00:00:00.000Z",
      operation: "init",
      phase: "plan",
      context: { installationName: "home", profile: "default" },
      cause: false,
    });
    assert.ok(booleanCause.includes('"message": "false"'));

    const overflow = "x".repeat(FAILURE_OUTPUT_TAIL_CHARACTERS + 8);
    const bounded = renderInstallationFailureDiagnostic({
      recordedAt: "2026-08-13T00:00:00.000Z",
      operation: "init",
      phase: "plan",
      context: { installationName: "home", profile: "default" },
      cause: overflow,
    });
    assert.equal(bounded.includes(overflow), false);
    assert.ok(bounded.includes("x".repeat(64)));
  });

  it("persists a mode-0600 nested diagnostic", async () => {
    const home = await mkdtemp(join(tmpdir(), "scotty-installation-diagnostic-"));
    try {
      const path = await persistInstallationFailureDiagnostic({
        home,
        recordedAt: "2026-08-13T00:00:00.000Z",
        operation: "deploy",
        phase: "plan",
        context: { installationName: "home", profile: "personal" },
        cause: { message: `plan failed ${SECRET}` },
        environment: { SCOTTY_TOKEN: SECRET },
      });
      assert.equal(path, join(home, ".scotty", "diagnostics", "deploy-plan.json"));
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const body = await readFile(path, "utf8");
      assert.equal(body.includes(SECRET), false);
      assert.ok(body.includes("[redacted-secret]"));
      assert.ok(body.includes('"profile": "personal"'));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.effect(
    "maps a host failure to the unchanged public error and a Clock-stamped diagnostic",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.tryPromise({
          try: () => mkdtemp(join(tmpdir(), "scotty-installation-diagnostic-clock-")),
          catch: (cause) => new Error(String(cause)),
        });
        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* TestClock.setTime(1_700_000_000_000);
            const result = yield* Effect.result(
              installationCommandFailure(home, { CLOUDFLARE_API_TOKEN: SECRET })(
                { message: `create failed ${SECRET}` },
                {
                  code: "installation_create_failed",
                  message: "Could not create the Scotty installation",
                  hint: "Check Cloudflare authentication, Docker, and permissions, then retry scotty init.",
                  operation: "init",
                  phase: "create",
                  installationName: "home",
                  profile: "default",
                },
              ),
            );
            const error = failed(result);
            assert.equal(error.code, "installation_create_failed");
            assert.equal(error.message, "Could not create the Scotty installation");
            assert.equal(error.exitCode, EXIT.GENERIC);
            assert.equal(
              error.hint.startsWith(
                "Check Cloudflare authentication, Docker, and permissions, then retry scotty init.",
              ),
              true,
            );
            const path = join(home, ".scotty", "diagnostics", "init-create.json");
            assert.equal(error.hint.includes(`Diagnostic: ${path}`), true);
            const body = yield* Effect.tryPromise({
              try: () => readFile(path, "utf8"),
              catch: (cause) => new Error(String(cause)),
            });
            assert.equal(body.includes("2023-11-14T22:13:20.000Z"), true);
            assert.equal(body.includes(SECRET), false);
          }),
          Effect.promise(() => rm(home, { recursive: true, force: true })),
        );
      }),
  );
});
