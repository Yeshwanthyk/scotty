import { randomBytes } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  assertM01BCanaryConfig,
  assertM01BCanaryApprovals,
  assertM01BPlan,
  assertM01BScanClean,
  expectedM01BApprovals,
  m01bCanaryApprovedLocalPaths,
  m01bCanaryConfigFromEnvironment,
  m01bCanaryFaultDestinationLayer,
  m01bCanaryFaultFromEnvironment,
  m01bCanaryDesired,
  m01bCanaryNames,
  m01bCanaryOperationFromEnvironment,
  m01bCanaryPhaseFromEnvironment,
  type M01BCanaryConfig,
  M01B_ACCOUNT_ID,
  M01B_BINDING_ATTACHED,
  M01B_CLEANUP_APPROVAL,
  M01B_DEPLOY_APPROVAL,
  M01B_KEYED_DIGEST,
  M01B_INTERRUPT_AFTER_WRITE,
  M01B_MUTATION_APPROVAL,
  M01B_OPERATION,
  M01B_PHASE,
  M01B_PHYSICAL_PREFIX,
  M01B_ROOT_KEY_FILE,
  M01B_STORE_ID,
  M01B_SYNTHETIC_AUTH_FILE,
  M01B_SYNTHETIC_SOURCE_ID,
} from "./account-secrets-store-canary.ts";
import { accountSecretsStoreCanaryFetch } from "./account-secrets-store-canary-worker.ts";
import { WriteOnlySecretDestination } from "./write-only-secret.ts";

const suffix = randomBytes(16).toString("hex");
const stage = `m01b-secret-canary-${suffix}`;
const config = (): M01BCanaryConfig => ({
  stage,
  deployApproval: expectedM01BApprovals(stage).deploy,
  mutationApproval: expectedM01BApprovals(stage).mutation,
  cleanupApproval: expectedM01BApprovals(stage).cleanup,
  telemetryDisabled: true,
  sourceId: M01B_SYNTHETIC_SOURCE_ID,
  keyedDigest: `hmac-sha256:v1:${randomBytes(32).toString("hex")}`,
  accountId: `account-${suffix}`,
  storeId: `store-${suffix}`,
  bindingName: "M01B_SYNTHETIC_SECRET",
  secretName: `${M01B_PHYSICAL_PREFIX}${suffix.slice(0, 24)}-secret`,
  bindingAttached: true,
});

describe("M01B Account Secrets Store canary scaffold", () => {
  it("fails closed on every independent pre-evaluation guard", () => {
    const valid = config();
    for (const bad of [
      { ...valid, stage: "m01b-secret-canary-UPPER" },
      { ...valid, deployApproval: undefined },
      { ...valid, mutationApproval: "mutate:wrong:synthetic" },
      { ...valid, cleanupApproval: undefined },
      { ...valid, telemetryDisabled: false },
      { ...valid, sourceId: "CODEX_AUTH_JSON" },
      { ...valid, keyedDigest: "not-a-keyed-digest" },
      { ...valid, secretName: "production-secret" },
    ])
      assert.throws(() => assertM01BCanaryConfig(bad));
    assert.doesNotThrow(() => assertM01BCanaryConfig(valid));
  });

  it("decodes only metadata and paths after all approvals pass", () => {
    const approvals = expectedM01BApprovals(stage);
    const home = "/home/operator";
    const canaryDirectory = `${home}/.config/scotty/canaries/${stage}`;
    const environment = {
      HOME: home,
      [M01B_DEPLOY_APPROVAL]: approvals.deploy,
      [M01B_MUTATION_APPROVAL]: approvals.mutation,
      [M01B_CLEANUP_APPROVAL]: approvals.cleanup,
      ALCHEMY_TELEMETRY_DISABLED: "1",
      [M01B_KEYED_DIGEST]: config().keyedDigest,
      [M01B_ACCOUNT_ID]: config().accountId,
      [M01B_STORE_ID]: config().storeId,
      [M01B_BINDING_ATTACHED]: "1",
      [M01B_SYNTHETIC_AUTH_FILE]: `${canaryDirectory}/auth.json`,
      [M01B_ROOT_KEY_FILE]: `${canaryDirectory}/root-key`,
    };

    assert.doesNotThrow(() => assertM01BCanaryApprovals(stage, environment));
    assert.isTrue(m01bCanaryConfigFromEnvironment(stage, environment).bindingAttached);
    assert.deepEqual(m01bCanaryApprovedLocalPaths(stage, environment, 123), {
      codexAuthPath: `${canaryDirectory}/auth.json`,
      rootKeyPath: `${canaryDirectory}/root-key`,
      previousRootKeyPaths: [],
      expectedUid: 123,
    });
    assert.throws(() =>
      m01bCanaryApprovedLocalPaths(
        stage,
        {
          ...environment,
          [M01B_SYNTHETIC_AUTH_FILE]: `${home}/.codex/auth.json`,
          [M01B_ROOT_KEY_FILE]: `${home}/.config/scotty/secrets/root-key`,
        },
        123,
      ),
    );
    assert.throws(
      () =>
        m01bCanaryConfigFromEnvironment(stage, {
          ...environment,
          [M01B_DEPLOY_APPROVAL]: undefined,
          [M01B_KEYED_DIGEST]: undefined,
        }),
      /deploy approval/u,
    );
    let pathReads = 0;
    const rejectedEnvironment: Record<string, string | undefined> = {
      ...environment,
      [M01B_DEPLOY_APPROVAL]: undefined,
    };
    Object.defineProperties(rejectedEnvironment, {
      [M01B_SYNTHETIC_AUTH_FILE]: {
        get: () => {
          pathReads += 1;
          return "/must-not-read/auth.json";
        },
      },
      [M01B_ROOT_KEY_FILE]: {
        get: () => {
          pathReads += 1;
          return "/must-not-read/root-key";
        },
      },
    });
    assert.throws(() => m01bCanaryApprovedLocalPaths(stage, rejectedEnvironment, 123));
    assert.strictEqual(pathReads, 0);
    assert.strictEqual(m01bCanaryFaultFromEnvironment({}), undefined);
    assert.strictEqual(
      m01bCanaryFaultFromEnvironment({ [M01B_INTERRUPT_AFTER_WRITE]: "create" }),
      "create",
    );
    assert.throws(() => m01bCanaryFaultFromEnvironment({ [M01B_INTERRUPT_AFTER_WRITE]: "delete" }));
    assert.strictEqual(m01bCanaryPhaseFromEnvironment({ [M01B_PHASE]: "first" }), "first");
    assert.strictEqual(m01bCanaryOperationFromEnvironment({ [M01B_OPERATION]: "plan" }), "plan");
    assert.throws(() => m01bCanaryPhaseFromEnvironment({ [M01B_PHASE]: "replace" }));
    assert.throws(() => m01bCanaryOperationFromEnvironment({ [M01B_OPERATION]: "deploy" }));
  });

  it.effect("interrupts only after the selected destination mutation commits", () => {
    let creates = 0;
    const metadata = {
      secretId: "secret-1",
      secretName: "synthetic-secret",
      storeId: "store-1",
      accountId: "account-1",
      status: "active" as const,
      scopes: ["workers"],
      comment: "synthetic-marker",
    };
    const delegate = Layer.succeed(
      WriteOnlySecretDestination,
      WriteOnlySecretDestination.of({
        read: () => Effect.succeed(metadata),
        find: () => Effect.succeed(metadata),
        create: () =>
          Effect.sync(() => {
            creates += 1;
            return metadata;
          }),
        patch: () => Effect.succeed(metadata),
        delete: () => Effect.void,
      }),
    );
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      return yield* destination.create(
        { accountId: "account-1", storeId: "store-1" },
        {
          name: "synthetic-secret",
          value: "synthetic-value",
          scopes: ["workers"],
          comment: "synthetic-marker",
        },
      );
    }).pipe(
      Effect.provide(m01bCanaryFaultDestinationLayer("create").pipe(Layer.provide(delegate))),
      Effect.exit,
      Effect.map((exit) => {
        assert.isTrue(Exit.hasInterrupts(exit));
        assert.strictEqual(creates, 1);
      }),
    );
  });

  it("retains 96 random bits in disposable names within Worker limits", () => {
    for (const name of Object.values(m01bCanaryNames(stage))) {
      assert.match(name, new RegExp(`^${M01B_PHYSICAL_PREFIX}${suffix.slice(0, 24)}-`, "u"));
      assert.ok(name.length <= 63);
    }
  });

  it("composes metadata-only props and the sole canonical binding", () => {
    const desired = m01bCanaryDesired(config());
    assert.deepEqual(desired.binding, {
      type: "secrets_store_secret",
      name: "M01B_SYNTHETIC_SECRET",
      storeId: desired.secretProps.storeId,
      secretName: desired.secretProps.secretName,
    });
    assert.deepEqual(Reflect.ownKeys(desired.secretProps).sort(), [
      "accountId",
      "bindingName",
      "keyedDigest",
      "providerVersion",
      "secretName",
      "sourceId",
      "storeId",
    ]);
  });

  it("accepts only the guarded create/update/noop/unbind/delete lifecycle plans", () => {
    const entries = (action: "create" | "noop" | "delete") => [
      { logicalId: "SyntheticSecret", resource: "Scotty.WriteOnlySecret", action },
      { logicalId: "SyntheticBindingWorker", resource: "Cloudflare.Worker", action },
    ];
    assert.doesNotThrow(() => assertM01BPlan(entries("create"), "first"));
    assert.doesNotThrow(() =>
      assertM01BPlan(
        [
          { logicalId: "SyntheticSecret", resource: "Scotty.WriteOnlySecret", action: "create" },
          { logicalId: "SyntheticBindingWorker", resource: "Cloudflare.Worker", action: "noop" },
        ],
        "first-replay",
      ),
    );
    assert.doesNotThrow(() => assertM01BPlan(entries("noop"), "second"));
    assert.doesNotThrow(() => assertM01BPlan(entries("delete"), "destroy"));
    assert.doesNotThrow(() =>
      assertM01BPlan(
        [
          { logicalId: "SyntheticSecret", resource: "Scotty.WriteOnlySecret", action: "update" },
          { logicalId: "SyntheticBindingWorker", resource: "Cloudflare.Worker", action: "noop" },
        ],
        "update",
      ),
    );
    assert.doesNotThrow(() =>
      assertM01BPlan(
        [
          { logicalId: "SyntheticSecret", resource: "Scotty.WriteOnlySecret", action: "noop" },
          { logicalId: "SyntheticBindingWorker", resource: "Cloudflare.Worker", action: "update" },
        ],
        "unbind",
      ),
    );
    assert.throws(() =>
      assertM01BPlan(
        [
          ...entries("create"),
          { logicalId: "UnexpectedRoute", resource: "Cloudflare.Route", action: "create" },
        ],
        "first",
      ),
    );
    assert.throws(() =>
      assertM01BPlan(
        [
          { logicalId: "SyntheticSecret", resource: "Scotty.WriteOnlySecret", action: "update" },
          { logicalId: "SyntheticBindingWorker", resource: "Cloudflare.Worker", action: "noop" },
        ],
        "second",
      ),
    );
    assert.throws(() =>
      assertM01BPlan(
        [
          { logicalId: "WrongSecret", resource: "Scotty.WriteOnlySecret", action: "create" },
          { logicalId: "SyntheticBindingWorker", resource: "Cloudflare.Worker", action: "create" },
        ],
        "first",
      ),
    );
    assert.throws(() => assertM01BPlan(entries("create"), "first", 1));
  });

  it("runtime response proves presence without disclosing the supplied value", async () => {
    const plaintext = `synthetic-plaintext-${randomBytes(24).toString("hex")}`;
    const response = accountSecretsStoreCanaryFetch(new Request("https://canary.invalid/"), {
      M01B_SYNTHETIC_SECRET: plaintext,
    });
    const textResponse = response.clone();
    assert.deepEqual(await response.json(), { bound: true });
    assert.notInclude(await textResponse.text(), plaintext);
    assert.deepEqual(
      await accountSecretsStoreCanaryFetch(new Request("https://canary.invalid/"), {}).json(),
      { bound: false },
    );
  });

  it("scans config, bindings, output-shaped data, and guard errors", () => {
    const plaintext = `synthetic-plaintext-${randomBytes(24).toString("hex")}`;
    const keyMarker = `synthetic-key-${randomBytes(24).toString("hex")}`;
    const authJson = JSON.stringify({ OPENAI_API_KEY: plaintext });
    const desired = m01bCanaryDesired(config());
    assert.doesNotThrow(() =>
      assertM01BScanClean(
        { config: config(), desired, outputs: desired.names },
        plaintext,
        keyMarker,
      ),
    );
    assert.throws(() => assertM01BScanClean({ accidental: plaintext }, plaintext, keyMarker));
    assert.throws(() => assertM01BScanClean({ accidental: authJson }, authJson));
    assert.throws(() =>
      assertM01BScanClean({ accidental: JSON.stringify({ nested: authJson }) }, authJson),
    );
    assert.throws(() => assertM01BScanClean(JSON.stringify({ accidental: authJson }), authJson));
    try {
      assertM01BCanaryConfig({ ...config(), deployApproval: plaintext });
    } catch (error) {
      assertM01BScanClean(String(error), plaintext, keyMarker);
    }
  });
});
