import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { ContainerProxy as OfficialContainerProxy } from "@cloudflare/sandbox";
import { ContainerProxy, ScottySandbox } from "./sandbox-sdk-canary-worker.ts";
import {
  assertM01CCanaryConfig,
  expectedCleanupApproval,
  expectedDeployApproval,
  M01C_ACCOUNT_SECRET_MAX_BYTES,
  M01C_LIVE_ASSERTIONS,
  m01cAccountSecretBinding,
  m01cCanaryNames,
} from "./sandbox-sdk-canary.ts";

const isolatedStage = `m01c-canary-${randomBytes(16).toString("hex")}`;

const approvedConfig = () => ({
  stage: isolatedStage,
  deployApproval: expectedDeployApproval(isolatedStage),
  cleanupApproval: expectedCleanupApproval(isolatedStage),
  telemetryDisabled: true,
});

describe("M01C local Sandbox SDK canary scaffold", () => {
  it("fails closed for unsafe stages and missing stage-scoped approvals", () => {
    for (const stage of ["", "dev", "m01c-canary-main", "m01c-canary-production"] as const) {
      assert.throws(() =>
        assertM01CCanaryConfig({
          stage,
          deployApproval: expectedDeployApproval(stage),
          cleanupApproval: expectedCleanupApproval(stage),
          telemetryDisabled: true,
        }),
      );
    }
    assert.throws(() =>
      assertM01CCanaryConfig({
        ...approvedConfig(),
        deployApproval: undefined,
      }),
    );
    assert.throws(() =>
      assertM01CCanaryConfig({
        ...approvedConfig(),
        telemetryDisabled: false,
      }),
    );
    assert.throws(() =>
      assertM01CCanaryConfig({
        ...approvedConfig(),
        cleanupApproval: undefined,
      }),
    );
    assert.doesNotThrow(() => assertM01CCanaryConfig(approvedConfig()));
  });

  it("uses unmistakably synthetic, stage-isolated physical names", () => {
    const names = m01cCanaryNames(isolatedStage);
    for (const name of Object.values(names)) {
      assert.match(name, /^scotty-m01c-disposable-[a-f0-9]{24}-/u);
      assert.ok(name.length <= 63);
      assert.equal(/(?:^|-)(?:prod|production|main|staging)(?:-|$)/u.test(name), false);
    }
  });

  it("preserves the official ContainerProxy and an SDK Sandbox host subclass", () => {
    assert.equal(ContainerProxy, OfficialContainerProxy);
    assert.equal(Object.getPrototypeOf(ScottySandbox.prototype).constructor.name, "Sandbox");

    const workerSource = readFileSync(
      new URL("./sandbox-sdk-canary-worker.ts", import.meta.url),
      "utf8",
    );
    assert.match(workerSource, /export class ScottySandbox extends Sandbox/u);
    assert.match(workerSource, /export \{ ContainerProxy \}/u);
    assert.match(
      workerSource,
      /terminal\(request, \{ cols: 80, rows: 24, shell: "\/bin\/cat" \}\)/u,
    );
  });

  it("declares the public Alchemy topology and current Worker configuration", () => {
    const stackSource = readFileSync(new URL("./sandbox-sdk-canary.ts", import.meta.url), "utf8");
    const bindingSource = readFileSync(
      new URL("./external-sandbox-container-binding.ts", import.meta.url),
      "utf8",
    );
    const providerSource = readFileSync(
      new URL(
        "../../vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/WorkerProvider.ts",
        import.meta.url,
      ),
      "utf8",
    );

    assert.match(stackSource, /Cloudflare\.DurableObject<[\s\S]+>\("Sandbox", \{/u);
    assert.match(stackSource, /className: "ScottySandbox"/u);
    assert.match(stackSource, /main: "spikes\/infra\/sandbox-sdk-canary-worker\.ts"/u);
    assert.match(stackSource, /context: "\."/u);
    assert.match(stackSource, /dockerfile: "worker\/container\/Dockerfile"/u);
    assert.match(stackSource, /directory: "worker\/public"/u);
    assert.match(stackSource, /Cloudflare\.readAssets\(assetConfig\)/u);
    assert.match(stackSource, /hash: assetHash/u);
    assert.match(stackSource, /date: compatibilityDate/u);
    assert.match(stackSource, /flags: \["nodejs_compat"\]/u);
    assert.match(stackSource, /observability: \{ enabled: false \}/u);
    assert.match(stackSource, /SANDBOX: durableObject/u);
    assert.match(stackSource, /SESSIONS: sessions/u);
    assert.match(stackSource, /BACKUP_BUCKET: backups/u);
    assert.match(
      stackSource,
      /bindExternalSandboxContainer\(\{ worker, container, durableObject \}\)/u,
    );
    assert.match(stackSource, /RemovalPolicy\.destroy\(\)/u);
    assert.notMatch(stackSource, /pinnedSafetyExtensionsReady|SCOTTY_M01C_ARM_CLEANUP/u);

    assert.match(bindingSource, /durableObjects: \{ namespaceId \}/u);
    assert.match(bindingSource, /containers: \[/u);
    assert.match(providerSource, /newSqliteClasses\.push\(binding\.className\)/u);
    assert.match(providerSource, /const metadataContainers = \[\.\.\.containerClassNames\]/u);
    assert.notMatch(stackSource, /alchemy\/(?:lib|src)\//u);
    assert.notMatch(stackSource, /(?:Worker|Container)Provider/u);
  });

  it("records the deployed canary evidence without overstating lifecycle timing", () => {
    assert.deepEqual(
      M01C_LIVE_ASSERTIONS.map(({ id }) => id),
      [
        "command",
        "files",
        "named-session",
        "pty-websocket",
        "backup-restore",
        "lifecycle-callbacks",
        "outbound-interception",
        "do-reconstruction",
        "idempotent-plan",
        "guarded-cleanup",
      ],
    );
    assert.deepEqual(
      M01C_LIVE_ASSERTIONS.filter(({ status }) => status === "unverified-live").map(({ id }) => id),
      ["lifecycle-callbacks"],
    );
  });

  it("models only identifier metadata for the deferred Account Secrets Store binding", () => {
    const suffix = randomBytes(8).toString("hex");
    const reference = {
      sourceId: `source-${suffix}`,
      storeId: `store-${suffix}`,
      secretId: `secret-id-${suffix}`,
      secretName: `secret-name-${suffix}`,
      bindingName: "M01C_BACKUP_REFERENCE",
      providerVersion: 1,
      keyedDigest: `hmac-sha256:v1:${randomBytes(32).toString("hex")}`,
      expectedOwnerMarker: `scotty:v1:${randomBytes(24).toString("base64url")}`,
    };

    assert.deepEqual(m01cAccountSecretBinding(reference), {
      type: "secrets_store_secret",
      name: reference.bindingName,
      storeId: reference.storeId,
      secretName: reference.secretName,
    });
    assert.equal(M01C_ACCOUNT_SECRET_MAX_BYTES, 1024);
    assert.equal("plaintext" in reference, false);
    assert.equal("value" in reference, false);
  });

  it("bundles the canary host without credential material", () => {
    const bundlePath = "/tmp/scotty-m01c-canary-worker.js";
    const syntheticMaterial = randomBytes(48).toString("base64url");
    execFileSync(
      "bun",
      [
        "build",
        "spikes/infra/sandbox-sdk-canary-worker.ts",
        "--target=browser",
        "--external=cloudflare:*",
        `--outfile=${bundlePath}`,
      ],
      {
        cwd: new URL("../../", import.meta.url),
        stdio: "pipe",
        env: {
          ...process.env,
          CODEX_AUTH_JSON: syntheticMaterial,
          GH_TOKEN: syntheticMaterial,
          SCOTTY_TOKEN: syntheticMaterial,
        },
      },
    );
    const bundle = readFileSync(bundlePath, "utf8");
    const stackSource = readFileSync(new URL("./sandbox-sdk-canary.ts", import.meta.url), "utf8");

    assert.notMatch(stackSource, /Config\.redacted|environmentVariables|secrets:/u);
    assert.equal(bundle.includes(syntheticMaterial), false);
    assert.equal(stackSource.includes(syntheticMaterial), false);
  });
});
