import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { inspect, promisify } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import { adopt, Unowned } from "alchemy/AdoptPolicy";
import { Stack } from "alchemy/Stack";
import { State, encodeState, type ResourceState } from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  buildOwnerMarker,
  SECRET_SCOPES,
  SECRET_VALUE_MAX_BYTES,
  SecretOwnerKey,
  SecretSource,
  type DestinationAccountKey,
  type DestinationSecretKey,
  type SecretStatus,
  verifyOwnerMarker,
  WriteOnlySecret,
  type WriteOnlySecretAttributes,
  type WriteOnlySecretProps,
  WriteOnlySecretDestination,
  WriteOnlySecretDestinationError,
  WriteOnlySecretFailure,
  writeOnlySecretProvider,
} from "./write-only-secret.ts";

/** No-op plan-status session for direct provider-service calls. */
const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
} as const;

const FQN = "Secret";
const INSTANCE_ID = "instance-1";
const EXPECTED_OWNER = `${FQN}#${INSTANCE_ID}`;
const FOREIGN_OWNER = "OtherStack/OtherSecret#other-instance";

/** Fixed marker-signing key (Scotty-only in production). */
const ownerKey = randomBytes(32);

/** Digest of trusted plaintext, mirroring how a real source would sign it. */
const digestOf = (plaintext: string): string =>
  `hmac-sha256:v1:${createHmac("sha256", ownerKey)
    .update("scotty-write-only-secret\0")
    .update(plaintext)
    .digest("hex")}`;

interface FakeRecord {
  secretId: string;
  name: string;
  accountId: string;
  storeId: string;
  status: SecretStatus;
  scopes: readonly string[];
  comment: string | undefined;
  /** Retained in-test only to assert rewriting; never returned by read. */
  value: string | undefined;
}

type CreateMode =
  | "ok"
  | "conflict"
  | "conflict-foreign"
  | "fail-before"
  | "fail-after"
  | "interrupt-after"
  | "fail-no-store";
type PatchMode = "ok" | "fail-before" | "fail-after" | "interrupt-after" | "fail-no-store";

interface World {
  layer?: Layer.Layer<
    typeof WriteOnlySecret.Provider | SecretSource | SecretOwnerKey | WriteOnlySecretDestination,
    never,
    never
  >;
  readonly store: Map<string, FakeRecord>;
  readonly counts: {
    sourceResolves: number;
    read: number;
    find: number;
    create: number;
    patch: number;
    delete: number;
  };
  plaintext: string;
  sourceFails: boolean;
  sourceDefect: boolean;
  readDefect: boolean;
  findMismatch: boolean;
  patchStatus: SecretStatus | undefined;
  createMode: CreateMode;
  patchMode: PatchMode;
  /** Override status returned by exact-ID read (pending poll simulation). */
  readStatusSequence: SecretStatus[];
  nextId: number;
  reset(): void;
  recordForProps(props: WriteOnlySecretProps): FakeRecord | undefined;
  seedRecord(
    props: WriteOnlySecretProps,
    init: Partial<Pick<FakeRecord, "status" | "comment" | "value" | "secretId">>,
  ): FakeRecord;
}

const ACCOUNT = "synthetic-account";
const STORE_ID = "synthetic-store";
const BINDING = "SYNTHETIC_TOKEN";

const baseProps = (overrides: Partial<WriteOnlySecretProps> = {}): WriteOnlySecretProps => ({
  sourceId: "synthetic-source",
  accountId: ACCOUNT,
  storeId: STORE_ID,
  secretName: "synthetic-secret",
  bindingName: BINDING,
  providerVersion: 1,
  keyedDigest: "",
  ...overrides,
});

const propsFor = (
  plaintext: string,
  overrides: Partial<WriteOnlySecretProps> = {},
): WriteOnlySecretProps => baseProps({ keyedDigest: digestOf(plaintext), ...overrides });

const makeWorld = (): World => {
  const world: World = {
    store: new Map(),
    counts: { sourceResolves: 0, read: 0, find: 0, create: 0, patch: 0, delete: 0 },
    plaintext: randomBytes(32).toString("base64url"),
    sourceFails: false,
    sourceDefect: false,
    readDefect: false,
    findMismatch: false,
    patchStatus: undefined,
    createMode: "ok",
    patchMode: "ok",
    readStatusSequence: [],
    nextId: 1,
    reset() {
      world.store.clear();
      world.counts.sourceResolves = 0;
      world.counts.read = 0;
      world.counts.find = 0;
      world.counts.create = 0;
      world.counts.patch = 0;
      world.counts.delete = 0;
      world.plaintext = randomBytes(32).toString("base64url");
      world.sourceFails = false;
      world.sourceDefect = false;
      world.readDefect = false;
      world.findMismatch = false;
      world.patchStatus = undefined;
      world.createMode = "ok";
      world.patchMode = "ok";
      world.readStatusSequence = [];
      world.nextId = 1;
    },
    recordForProps(props) {
      for (const record of world.store.values()) {
        if (
          record.accountId === props.accountId &&
          record.storeId === props.storeId &&
          record.name === props.secretName
        ) {
          return record;
        }
      }
      return undefined;
    },
    seedRecord(props, init) {
      const secretId = init.secretId ?? `sec-${world.nextId++}`;
      const record: FakeRecord = {
        secretId,
        name: props.secretName,
        accountId: props.accountId,
        storeId: props.storeId,
        status: init.status ?? "active",
        scopes: SECRET_SCOPES,
        comment: init.comment,
        value: init.value,
      };
      world.store.set(secretId, record);
      return record;
    },
  };

  const sourceImpl = {
    resolve: (_sourceId: string) =>
      Effect.suspend(() => {
        world.counts.sourceResolves += 1;
        if (world.sourceDefect) {
          return Effect.die(new Error(`source exploded with ${world.plaintext}`));
        }
        if (world.sourceFails) {
          return Effect.fail(new Error("source unavailable"));
        }
        return Effect.succeed({
          plaintext: world.plaintext,
          keyedDigest: digestOf(world.plaintext),
        });
      }),
  };

  const destinationImpl = {
    read: (key: DestinationSecretKey) =>
      Effect.suspend(() => {
        world.counts.read += 1;
        if (world.readDefect) {
          // oxlint-disable-next-line scotty/no-raw-error-throw -- test fake deliberately raises a defect
          throw new Error("raw destination defect");
        }
        const record = world.store.get(key.secretId);
        if (record === undefined) {
          return Effect.fail(
            new WriteOnlySecretDestinationError({
              operation: "read",
              code: "not-found",
              accountId: key.accountId,
              storeId: key.storeId,
              secretId: key.secretId,
            }),
          );
        }
        const status =
          world.readStatusSequence.length > 0
            ? (world.readStatusSequence.shift() as SecretStatus)
            : record.status;
        return Effect.succeed({
          secretId: record.secretId,
          secretName: record.name,
          storeId: record.storeId,
          accountId: record.accountId,
          status,
          scopes: record.scopes,
          comment: record.comment,
        });
      }),
    find: (key: DestinationAccountKey & { readonly secretName: string }) =>
      Effect.sync(() => {
        world.counts.find += 1;
        for (const record of world.store.values()) {
          if (
            record.accountId === key.accountId &&
            record.storeId === key.storeId &&
            record.name === key.secretName
          ) {
            if (world.findMismatch) {
              // Return metadata for a DIFFERENT account/store/name to test
              // identity validation in collision recovery.
              return {
                secretId: record.secretId,
                secretName: "wrong-name",
                storeId: "wrong-store",
                accountId: "wrong-account",
                status: record.status,
                scopes: record.scopes,
                comment: record.comment,
              };
            }
            return {
              secretId: record.secretId,
              secretName: record.name,
              storeId: record.storeId,
              accountId: record.accountId,
              status: record.status,
              scopes: record.scopes,
              comment: record.comment,
            };
          }
        }
        return undefined;
      }),
    create: (
      key: DestinationAccountKey,
      body: {
        readonly name: string;
        readonly value: string;
        readonly scopes: readonly string[];
        readonly comment: string;
      },
    ) =>
      Effect.suspend(() => {
        world.counts.create += 1;
        if (world.createMode === "conflict-foreign") {
          // 409 without seeding — a foreign-owned secret already exists.
          return Effect.fail(
            new WriteOnlySecretDestinationError({
              operation: "create",
              code: "conflict",
              accountId: key.accountId,
              storeId: key.storeId,
              secretId: undefined,
            }),
          );
        }
        if (world.createMode === "conflict") {
          // Simulate a concurrent same-owner create: the secret now exists
          // under our marker, but Cloudflare reports 409.
          const secretId = `sec-${world.nextId++}`;
          world.store.set(secretId, {
            secretId,
            name: body.name,
            accountId: key.accountId,
            storeId: key.storeId,
            status: "active",
            scopes: body.scopes,
            comment: body.comment,
            value: body.value,
          });
          return Effect.fail(
            new WriteOnlySecretDestinationError({
              operation: "create",
              code: "conflict",
              accountId: key.accountId,
              storeId: key.storeId,
              secretId: undefined,
            }),
          );
        }
        if (world.createMode === "fail-before") {
          return Effect.fail(new Error(`synthetic create echoed ${body.value}`));
        }
        if (world.createMode === "fail-no-store") {
          return Effect.fail(new Error("synthetic create failed without storing"));
        }
        const secretId = `sec-${world.nextId++}`;
        const record: FakeRecord = {
          secretId,
          name: body.name,
          accountId: key.accountId,
          storeId: key.storeId,
          status: "active",
          scopes: body.scopes,
          comment: body.comment,
          value: body.value,
        };
        world.store.set(secretId, record);
        if (world.createMode === "fail-after") {
          // Ambiguous: stored before the response was lost.
          return Effect.fail(new Error(`synthetic create echoed ${body.value}`));
        }
        if (world.createMode === "interrupt-after") {
          return Effect.interrupt;
        }
        return Effect.succeed({
          secretId: record.secretId,
          secretName: record.name,
          storeId: record.storeId,
          accountId: record.accountId,
          status: record.status,
          scopes: record.scopes,
          comment: record.comment,
        });
      }),
    patch: (
      key: DestinationSecretKey,
      body: {
        readonly value: string;
        readonly scopes: readonly string[];
        readonly comment: string;
      },
    ) =>
      Effect.suspend(() => {
        world.counts.patch += 1;
        if (world.patchMode === "fail-before") {
          return Effect.fail(new Error(`synthetic patch echoed ${body.value}`));
        }
        if (world.patchMode === "fail-no-store") {
          return Effect.fail(new Error("synthetic patch failed without storing"));
        }
        const record = world.store.get(key.secretId);
        if (record === undefined) {
          return Effect.fail(
            new WriteOnlySecretDestinationError({
              operation: "patch",
              code: "not-found",
              accountId: key.accountId,
              storeId: key.storeId,
              secretId: key.secretId,
            }),
          );
        }
        record.value = body.value;
        record.comment = body.comment;
        record.scopes = body.scopes;
        // A deleted secret cannot be resurrected by PATCH.
        if (record.status !== "deleted") {
          record.status = world.patchStatus ?? "active";
        }
        if (world.patchMode === "fail-after") {
          // Ambiguous: stored before the response was lost.
          return Effect.fail(new Error(`synthetic patch echoed ${body.value}`));
        }
        if (world.patchMode === "interrupt-after") {
          return Effect.interrupt;
        }
        return Effect.succeed({
          secretId: record.secretId,
          secretName: record.name,
          storeId: record.storeId,
          accountId: record.accountId,
          status: record.status,
          scopes: record.scopes,
          comment: record.comment,
        });
      }),
    delete: (key: DestinationSecretKey) =>
      Effect.suspend(() => {
        world.counts.delete += 1;
        const record = world.store.get(key.secretId);
        if (record === undefined) {
          return Effect.fail(
            new WriteOnlySecretDestinationError({
              operation: "delete",
              code: "not-found",
              accountId: key.accountId,
              storeId: key.storeId,
              secretId: key.secretId,
            }),
          );
        }
        world.store.delete(key.secretId);
        return Effect.succeed(undefined);
      }),
  };

  world.layer = writeOnlySecretProvider.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(SecretSource, sourceImpl),
        Layer.succeed(SecretOwnerKey, { key: ownerKey }),
        Layer.succeed(WriteOnlySecretDestination, destinationImpl),
      ),
    ),
  );

  return world;
};

const world = makeWorld();
assert.ok(world.layer);
const providers = world.layer;

/** Direct provider-service accessor. */
const providerService = Effect.gen(function* () {
  return yield* WriteOnlySecret.Provider;
});

const reconcileInput = (
  news: WriteOnlySecretProps,
  options: { olds?: WriteOnlySecretProps; output?: WriteOnlySecretAttributes } = {},
) => ({
  id: FQN,
  fqn: FQN,
  instanceId: INSTANCE_ID,
  news,
  olds: options.olds,
  output: options.output,
  session,
  bindings: [],
});

const deleteInput = (olds: WriteOnlySecretProps, output: WriteOnlySecretAttributes) => ({
  id: FQN,
  fqn: FQN,
  instanceId: INSTANCE_ID,
  olds,
  output,
  session,
  bindings: [],
});

const readInput = (olds: WriteOnlySecretProps, output: WriteOnlySecretAttributes | undefined) => ({
  id: FQN,
  fqn: FQN,
  instanceId: INSTANCE_ID,
  olds,
  output,
});

/** Run an effect against the world layer. */
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(providers));

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (Exit.isFailure(exit)) {
    const option = Cause.findErrorOption(exit.cause);
    return Option.getOrUndefined(option) as E | undefined;
  }
  return undefined;
};

const isWriteOnlySecretFailure = (value: unknown): value is WriteOnlySecretFailure =>
  Predicate.isTagged(value, "WriteOnlySecretFailure");

const runReconcile = (
  news: WriteOnlySecretProps,
  options: { olds?: WriteOnlySecretProps; output?: WriteOnlySecretAttributes } = {},
) =>
  run(
    Effect.gen(function* () {
      const service = yield* providerService;
      return yield* service.reconcile(reconcileInput(news, options));
    }),
  );

const runDelete = (olds: WriteOnlySecretProps, output: WriteOnlySecretAttributes) =>
  run(
    Effect.gen(function* () {
      const service = yield* providerService;
      return yield* service.delete(deleteInput(olds, output));
    }),
  );

const runRead = (olds: WriteOnlySecretProps, output: WriteOnlySecretAttributes | undefined) =>
  run(
    Effect.gen(function* () {
      const service = yield* providerService;
      if (service.read === undefined) return undefined;
      return yield* service.read(readInput(olds, output));
    }),
  );

const attributesFrom = (
  props: WriteOnlySecretProps,
  record: FakeRecord,
  ownerRef = EXPECTED_OWNER,
): WriteOnlySecretAttributes => ({
  ...props,
  secretId: record.secretId,
  status: record.status,
  scopes: record.scopes,
  ownerReference: ownerRef,
});

const encodedForms = (plaintext: string): readonly string[] => [
  plaintext,
  Buffer.from(plaintext).toString("base64"),
  Buffer.from(plaintext).toString("base64url"),
  Buffer.from(plaintext).toString("hex"),
  encodeURIComponent(plaintext),
];

const assertNoPlaintext = (label: string, plaintexts: readonly string[], value: unknown): void => {
  const rendered =
    typeof value === "string"
      ? value
      : inspect(value, {
          depth: Infinity,
          getters: false,
          maxArrayLength: Infinity,
          maxStringLength: Infinity,
        });
  for (const plaintext of plaintexts) {
    for (const encoded of encodedForms(plaintext)) {
      if (encoded.length === 0) continue;
      assert.ok(
        !rendered.includes(encoded),
        `${label} contained a forbidden synthetic credential encoding`,
      );
    }
  }
};

describe("M01B Account Secrets Store marker and binding (pure)", () => {
  it("round-trips an authentic ownership marker", () => {
    const digest = digestOf("secret-value");
    const marker = buildOwnerMarker(EXPECTED_OWNER, digest, 1, ownerKey);
    const verified = verifyOwnerMarker(marker, ownerKey);
    assert.isTrue(verified.authentic);
    assert.strictEqual(verified.ownerReference, EXPECTED_OWNER);
    assert.strictEqual(verified.keyedDigest, digest);
    assert.strictEqual(verified.providerVersion, 1);
  });

  it("rejects a foreign-owner marker as not ours but authentic to its author", () => {
    const digest = digestOf("secret-value");
    const foreign = buildOwnerMarker(FOREIGN_OWNER, digest, 1, ownerKey);
    const verified = verifyOwnerMarker(foreign, ownerKey);
    assert.isTrue(verified.authentic);
    assert.strictEqual(verified.ownerReference, FOREIGN_OWNER);
    assert.notStrictEqual(verified.ownerReference, EXPECTED_OWNER);
  });

  it("rejects a malformed marker", () => {
    assert.isFalse(verifyOwnerMarker("not-a-scotty-marker", ownerKey).authentic);
    assert.isFalse(verifyOwnerMarker(undefined, ownerKey).authentic);
    const partial = "scotty:v1;owner=Secret#instance-1;digest=x;ver=1";
    assert.isFalse(verifyOwnerMarker(partial, ownerKey).authentic);
  });

  it("rejects a tampered HMAC marker", () => {
    const digest = digestOf("secret-value");
    const injectedOwner = "attacker-controlled-owner";
    const marker = buildOwnerMarker(injectedOwner, digest, 1, ownerKey);
    const tampered = marker.slice(0, marker.length - 2) + (marker.endsWith("00") ? "11" : "00");
    const verified = verifyOwnerMarker(tampered, ownerKey);
    assert.isFalse(verified.authentic);
    assert.isUndefined(verified.ownerReference);
    assert.isUndefined(verified.keyedDigest);
    assert.isUndefined(verified.providerVersion);
    assertNoPlaintext("rejected marker fields", [injectedOwner], verified);
  });
});

describe("M01B Account Secrets Store provider reconcile", () => {
  it.live("creates an active secret with workers scope and our marker", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const result = yield* runReconcile(news, {});
      assert.strictEqual(result?.status, "active");
      assert.deepEqual(result?.scopes, ["workers"]);
      assert.strictEqual(result?.ownerReference, EXPECTED_OWNER);
      assert.strictEqual(world.counts.sourceResolves, 1);
      assert.strictEqual(world.counts.create, 1);
      const record = world.recordForProps(news);
      assert.ok(record !== undefined);
      const verified = verifyOwnerMarker(record!.comment, ownerKey);
      assert.isTrue(verified.authentic);
      assert.strictEqual(verified.ownerReference, EXPECTED_OWNER);
      assert.strictEqual(verified.keyedDigest, news.keyedDigest);
      assertNoPlaintext("reconcile output", [world.plaintext], result);
    }),
  );

  it.live("treats exact-ID read 404 as missing and creates", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      // Persisted output points at a secretId that no longer exists (404).
      const staleOutput = attributesFrom(news, {
        secretId: "ghost",
        name: news.secretName,
        accountId: news.accountId,
        storeId: news.storeId,
        status: "active",
        scopes: SECRET_SCOPES,
        comment: undefined,
        value: undefined,
      });
      const result = yield* runReconcile(news, { olds: news, output: staleOutput });
      assert.strictEqual(result?.status, "active");
      assert.strictEqual(world.counts.create, 1);
      assert.notStrictEqual(result?.secretId, "ghost");
    }),
  );

  it.live("recovers a same-owner create collision (409) by PATCHing the exact ID", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      // No pre-seed: the fake seeds a same-owner record on 409, simulating
      // a concurrent create that won the race.
      world.createMode = "conflict";
      const result = yield* runReconcile(news, {});
      assert.strictEqual(result?.status, "active");
      assert.strictEqual(world.counts.create, 1);
      assert.strictEqual(world.counts.patch, 1);
      // The collision recovery found the seeded record and PATCHed it.
      const record = world.recordForProps(news);
      assert.ok(record !== undefined);
      const verified = verifyOwnerMarker(record!.comment, ownerKey);
      assert.isTrue(verified.authentic);
      assert.strictEqual(verified.ownerReference, EXPECTED_OWNER);
      assert.strictEqual(verified.keyedDigest, news.keyedDigest);
    }),
  );

  it.live("fails closed on a foreign create collision without adoption", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.seedRecord(news, {
        comment: buildOwnerMarker(FOREIGN_OWNER, digestOf("foreign"), 1, ownerKey),
        value: "foreign",
      });
      world.createMode = "conflict-foreign";
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit);
      assert.ok(isWriteOnlySecretFailure(failure));
      assert.strictEqual(failure?.code, "foreign-owner");
      assert.strictEqual(world.counts.patch, 0);
    }),
  );

  it.live("rejects a collision lookup returning mismatched identity metadata", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.seedRecord(news, {
        comment: buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey),
        value: "stale",
      });
      world.createMode = "conflict";
      world.findMismatch = true;
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "destination-failure");
      assert.strictEqual(world.counts.patch, 0);
    }),
  );

  it.live("polls a pending secret until active", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      // Seed a pending secret we own; reconcile will PATCH it (stale digest
      // via output mismatch) and the read sequence simulates pending→active.
      const seeded = world.seedRecord(news, {
        status: "pending",
        comment: buildOwnerMarker(EXPECTED_OWNER, "stale-digest", 1, ownerKey),
        value: "old",
      });
      const output: WriteOnlySecretAttributes = {
        ...news,
        keyedDigest: "stale-digest",
        secretId: seeded.secretId,
        status: "pending",
        scopes: SECRET_SCOPES,
        ownerReference: EXPECTED_OWNER,
      };
      world.patchStatus = "pending";
      // First read is the pre-write exact-ID observation (pending); the
      // subsequent poll after the PATCH returns active.
      world.readStatusSequence = ["pending", "active"];
      const result = yield* runReconcile(news, { olds: news, output });
      assert.strictEqual(result?.status, "active");
      assert.ok(world.counts.read >= 2, "pending poll must read at least twice");
    }),
  );

  it.live("fails a deleted observation as write-verification failure", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        status: "deleted",
        comment: buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey),
        value: undefined,
      });
      const output = attributesFrom(news, seeded, EXPECTED_OWNER);
      const exit = yield* Effect.exit(runReconcile(news, { olds: news, output }));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "write-verification-failure");
      assert.strictEqual(world.counts.sourceResolves, 1);
    }),
  );

  it.live("fails closed on a foreign marker discovered during initial create", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.seedRecord(news, {
        comment: buildOwnerMarker(FOREIGN_OWNER, digestOf("foreign"), 1, ownerKey),
        value: "foreign",
      });
      // No output: initial create discovers the foreign secret by name.
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "foreign-owner");
      assert.strictEqual(world.counts.sourceResolves, 0);
      assert.strictEqual(world.counts.patch, 0);
    }),
  );

  it.live("fails closed on a malformed marker discovered during initial create", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.seedRecord(news, { comment: "garbage-not-scotty", value: "x" });
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "foreign-owner");
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );

  it.live("fails closed on a tampered HMAC marker discovered during initial create", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const marker = buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey);
      const tampered = marker.slice(0, marker.length - 2) + (marker.endsWith("00") ? "11" : "00");
      world.seedRecord(news, { comment: tampered, value: "x" });
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "foreign-owner");
    }),
  );

  it.live("persisted foreign output never authorizes adoption", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(FOREIGN_OWNER, digestOf("foreign"), 1, ownerKey),
        value: "foreign",
      });
      const output = attributesFrom(news, seeded, FOREIGN_OWNER);
      const exit = yield* Effect.exit(runReconcile(news, { output }));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(world.counts.sourceResolves, 0);
      assert.strictEqual(world.counts.patch, 0);
      const verified = verifyOwnerMarker(seeded.comment, ownerKey);
      assert.isTrue(verified.authentic);
      assert.strictEqual(verified.ownerReference, FOREIGN_OWNER);
      assert.strictEqual(seeded.value, "foreign");
    }),
  );

  it.live("foreign ownership fails before source resolution or PATCH", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(FOREIGN_OWNER, digestOf("foreign"), 1, ownerKey),
        value: "foreign",
      });
      const output = attributesFrom(news, seeded, FOREIGN_OWNER);
      const exit = yield* Effect.exit(runReconcile(news, { output }));
      assert.isTrue(Exit.isFailure(exit));
      const verified = verifyOwnerMarker(seeded.comment, ownerKey);
      assert.strictEqual(verified.ownerReference, FOREIGN_OWNER);
      assert.strictEqual(seeded.value, "foreign");
      assert.strictEqual(world.counts.sourceResolves, 0);
      assert.strictEqual(world.counts.patch, 0);
    }),
  );

  it.live("repeated reconcile cannot turn foreign persisted output into authorization", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const foreignDigest = digestOf("foreign");
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(FOREIGN_OWNER, foreignDigest, 1, ownerKey),
        value: "foreign",
      });
      // Output carries the FOREIGN digest (the state before our takeover).
      const output: WriteOnlySecretAttributes = {
        ...news,
        keyedDigest: foreignDigest,
        secretId: seeded.secretId,
        status: "active",
        scopes: SECRET_SCOPES,
        ownerReference: FOREIGN_OWNER,
      };
      const firstExit = yield* Effect.exit(runReconcile(news, { output }));
      assert.isTrue(Exit.isFailure(firstExit));
      const secondExit = yield* Effect.exit(runReconcile(news, { output }));
      assert.isTrue(Exit.isFailure(secondExit));
      assert.strictEqual(world.counts.sourceResolves, 0);
      assert.strictEqual(world.counts.patch, 0);
      const verified = verifyOwnerMarker(seeded.comment, ownerKey);
      assert.strictEqual(verified.ownerReference, FOREIGN_OWNER);
      assert.strictEqual(seeded.value, "foreign");
    }),
  );

  it.live("ambiguous create re-resolves and PATCHes before committing ownership", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.createMode = "fail-after";
      const firstExit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(firstExit));
      // The create stored a record before failing (ambiguous).
      assert.strictEqual(world.store.size, 1);
      const resolvesAfterFirst = world.counts.sourceResolves;
      const patchesAfterFirst = world.counts.patch;
      world.createMode = "ok";
      const result = yield* runReconcile(news, {});
      assert.strictEqual(result?.status, "active");
      // The live marker cannot prove which plaintext was committed. Recovery
      // therefore re-resolves the trusted source and idempotently PATCHes the
      // exact discovered ID before accepting the active observation.
      assert.strictEqual(world.counts.sourceResolves, resolvesAfterFirst + 1);
      assert.strictEqual(world.counts.patch, patchesAfterFirst + 1);
      assert.strictEqual(world.counts.create, 1);
    }),
  );

  it.live("post-create interruption is preserved and recovered by exact-ID PATCH", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.createMode = "interrupt-after";
      const firstExit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.hasInterrupts(firstExit));
      assert.strictEqual(world.store.size, 1);
      const resolvesAfterFirst = world.counts.sourceResolves;
      const patchesAfterFirst = world.counts.patch;
      world.createMode = "ok";
      const result = yield* runReconcile(news, {});
      assert.strictEqual(result?.status, "active");
      assert.strictEqual(world.counts.sourceResolves, resolvesAfterFirst + 1);
      assert.strictEqual(world.counts.patch, patchesAfterFirst + 1);
      assert.strictEqual(world.counts.create, 1);
    }),
  );

  it.live("ambiguous patch re-resolves and PATCHes before committing desired output", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const oldDigest = digestOf("old");
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(EXPECTED_OWNER, oldDigest, 1, ownerKey),
        value: "old",
      });
      // Output carries the OLD digest (the state before rotation).
      const output: WriteOnlySecretAttributes = {
        ...news,
        keyedDigest: oldDigest,
        secretId: seeded.secretId,
        status: "active",
        scopes: SECRET_SCOPES,
        ownerReference: EXPECTED_OWNER,
      };
      world.patchMode = "fail-after";
      const firstExit = yield* Effect.exit(runReconcile(news, { olds: news, output }));
      assert.isTrue(Exit.isFailure(firstExit));
      const resolvesAfterFirst = world.counts.sourceResolves;
      const patchesAfterFirst = world.counts.patch;
      world.patchMode = "ok";
      const result = yield* runReconcile(news, { olds: news, output });
      assert.strictEqual(result?.status, "active");
      // The old persisted output cannot certify the ambiguous desired write.
      // Recovery must produce one unambiguous exact-ID PATCH and active read.
      assert.strictEqual(world.counts.sourceResolves, resolvesAfterFirst + 1);
      assert.strictEqual(world.counts.patch, patchesAfterFirst + 1);
    }),
  );

  it.live("post-PATCH interruption is preserved and recovered by exact-ID PATCH", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const oldDigest = digestOf("old");
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(EXPECTED_OWNER, oldDigest, 1, ownerKey),
        value: "old",
      });
      const output: WriteOnlySecretAttributes = {
        ...news,
        keyedDigest: oldDigest,
        secretId: seeded.secretId,
        status: "active",
        scopes: SECRET_SCOPES,
        ownerReference: EXPECTED_OWNER,
      };
      world.patchMode = "interrupt-after";
      const firstExit = yield* Effect.exit(runReconcile(news, { olds: news, output }));
      assert.isTrue(Exit.hasInterrupts(firstExit));
      const resolvesAfterFirst = world.counts.sourceResolves;
      const patchesAfterFirst = world.counts.patch;
      world.patchMode = "ok";
      const result = yield* runReconcile(news, { olds: news, output });
      assert.strictEqual(result?.status, "active");
      assert.strictEqual(world.counts.sourceResolves, resolvesAfterFirst + 1);
      assert.strictEqual(world.counts.patch, patchesAfterFirst + 1);
    }),
  );

  it.live("true create failure (no store) recovers via re-resolve and re-create", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.createMode = "fail-no-store";
      const firstExit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(firstExit));
      // The create did NOT store a record (true failure).
      assert.strictEqual(world.store.size, 0);
      const resolvesAfterFirst = world.counts.sourceResolves;
      const createsAfterFirst = world.counts.create;
      world.createMode = "ok";
      const result = yield* runReconcile(news, {});
      assert.strictEqual(result?.status, "active");
      // Recovery re-resolved the trusted source before the retry create
      // (the first create did not store, so convergence was NOT detected).
      assert.strictEqual(world.counts.sourceResolves, resolvesAfterFirst + 1);
      assert.strictEqual(world.counts.create, createsAfterFirst + 1);
    }),
  );

  it.live("true patch failure (no store) recovers via re-resolve and exact-ID PATCH", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const oldDigest = digestOf("old");
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(EXPECTED_OWNER, oldDigest, 1, ownerKey),
        value: "old",
      });
      const output: WriteOnlySecretAttributes = {
        ...news,
        keyedDigest: oldDigest,
        secretId: seeded.secretId,
        status: "active",
        scopes: SECRET_SCOPES,
        ownerReference: EXPECTED_OWNER,
      };
      world.patchMode = "fail-no-store";
      const firstExit = yield* Effect.exit(runReconcile(news, { olds: news, output }));
      assert.isTrue(Exit.isFailure(firstExit));
      const resolvesAfterFirst = world.counts.sourceResolves;
      const patchesAfterFirst = world.counts.patch;
      world.patchMode = "ok";
      const result = yield* runReconcile(news, { olds: news, output });
      assert.strictEqual(result?.status, "active");
      // Recovery re-resolved and re-PATCHed the exact ID (the live state
      // still had the old digest, so convergence was NOT detected).
      assert.strictEqual(world.counts.sourceResolves, resolvesAfterFirst + 1);
      assert.strictEqual(world.counts.patch, patchesAfterFirst + 1);
    }),
  );

  it.live("steady-state no-op does not resolve plaintext or write", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const first = yield* runReconcile(news, {});
      assert.strictEqual(first?.status, "active");
      const resolves = world.counts.sourceResolves;
      const creates = world.counts.create;
      const patches = world.counts.patch;
      // Second reconcile with persisted output matching the marker digest.
      const second = yield* runReconcile(news, { olds: news, output: first });
      assert.strictEqual(second?.secretId, first?.secretId);
      assert.strictEqual(world.counts.sourceResolves, resolves);
      assert.strictEqual(world.counts.create, creates);
      assert.strictEqual(world.counts.patch, patches);
    }),
  );

  it.live("source failure surfaces a sanitized source-failure error", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.sourceFails = true;
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "source-failure");
      const rendered = Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty);
      assertNoPlaintext("source-failure cause", [world.plaintext], rendered);
      assertNoPlaintext("source-failure error", [world.plaintext], failure);
    }),
  );

  it.live("destination failure surfaces a sanitized destination-failure error", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.createMode = "fail-before";
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "destination-failure");
      const rendered = Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty);
      assertNoPlaintext("destination-failure cause", [world.plaintext], rendered);
    }),
  );

  it.live("accepts a value of exactly 1024 UTF-8 bytes and rejects 1025", () =>
    Effect.gen(function* () {
      world.reset();
      const exactly = "a".repeat(SECRET_VALUE_MAX_BYTES);
      world.plaintext = exactly;
      const okNews = propsFor(world.plaintext);
      const okResult = yield* runReconcile(okNews, {});
      assert.strictEqual(okResult?.status, "active");
      assert.strictEqual(world.counts.create, 1);

      world.reset();
      const tooLarge = "a".repeat(SECRET_VALUE_MAX_BYTES + 1);
      world.plaintext = tooLarge;
      const tooLargeNews = propsFor(world.plaintext);
      const exit = yield* Effect.exit(runReconcile(tooLargeNews, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "value-too-large");
      assert.strictEqual(world.counts.create, 0);
    }),
  );

  it.live("rejects a multibyte value whose UTF-8 length exceeds 1024 bytes", () =>
    Effect.gen(function* () {
      world.reset();
      // 342 four-byte chars = 1368 bytes > 1024.
      world.plaintext = "🛡".repeat(342);
      const news = propsFor(world.plaintext);
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "value-too-large");
    }),
  );

  it.live("defects from the destination are sanitized to destination-failure", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey),
        value: "x",
      });
      const output = attributesFrom(news, seeded, EXPECTED_OWNER);
      // Force read to raise a raw defect (not a typed error).
      world.readDefect = true;
      const exit = yield* Effect.exit(runReconcile(news, { olds: news, output }));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "destination-failure");
      const rendered = Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty);
      assertNoPlaintext("defect cause", [world.plaintext], rendered);
    }),
  );

  it.live("fails closed when an owned secret's marker is replaced out-of-band", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(FOREIGN_OWNER, digestOf("foreign"), 1, ownerKey),
        value: "foreign",
      });
      // Output carries OUR ownerReference (the engine thinks it's ours),
      // but the live marker is now foreign. This is an out-of-band transfer.
      const output = attributesFrom(news, seeded, EXPECTED_OWNER);
      const exit = yield* Effect.exit(runReconcile(news, { olds: news, output }));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "foreign-owner");
      assert.strictEqual(world.counts.sourceResolves, 0);
      assert.strictEqual(world.counts.patch, 0);
    }),
  );

  it.live("sanitizes a source defect whose message contains plaintext", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      world.sourceDefect = true;
      const exit = yield* Effect.exit(runReconcile(news, {}));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "source-failure");
      const rendered = Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty);
      assertNoPlaintext("source defect cause", [world.plaintext], rendered);
      assertNoPlaintext("source defect error", [world.plaintext], failure);
    }),
  );

  it("rejects non-canonical marker comments (extra segments)", () => {
    const digest = digestOf("secret-value");
    const marker = buildOwnerMarker(EXPECTED_OWNER, digest, 1, ownerKey);
    assert.isFalse(verifyOwnerMarker(`${marker};extra=x`, ownerKey).authentic);
    assert.isFalse(verifyOwnerMarker(`${marker};owner=evil`, ownerKey).authentic);
  });

  it("rejects non-canonical version (leading zero)", () => {
    const digest = digestOf("secret-value");
    const sig = createHmac("sha256", ownerKey)
      .update(`scotty:v1\0${EXPECTED_OWNER}\0${digest}\0` + "01")
      .digest("hex");
    const marker = `scotty:v1;owner=${EXPECTED_OWNER};digest=${digest};ver=01;sig=${sig}`;
    assert.isFalse(verifyOwnerMarker(marker, ownerKey).authentic);
  });

  it("rejects a non-hex signature", () => {
    const digest = digestOf("secret-value");
    const marker = `scotty:v1;owner=${EXPECTED_OWNER};digest=${digest};ver=1;sig=${"X".repeat(64)}`;
    assert.isFalse(verifyOwnerMarker(marker, ownerKey).authentic);
  });

  it("rejects a short signature", () => {
    const digest = digestOf("secret-value");
    const marker = `scotty:v1;owner=${EXPECTED_OWNER};digest=${digest};ver=1;sig=abc`;
    assert.isFalse(verifyOwnerMarker(marker, ownerKey).authentic);
  });
});

describe("M01B Account Secrets Store provider read", () => {
  it.live("returns undefined when the exact ID is missing (404) and no name match", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const result = yield* runRead(news, undefined);
      assert.isUndefined(result);
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );

  it.live("returns our attributes for an exact-ID read of an owned secret", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey),
        value: "x",
      });
      const output = attributesFrom(news, seeded, EXPECTED_OWNER);
      const result = yield* runRead(news, output);
      assert.strictEqual(result?.secretId, seeded.secretId);
      assert.strictEqual(result?.ownerReference, EXPECTED_OWNER);
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );

  it.live("marks a foreign-owned secret as Unowned for adoption gating", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(FOREIGN_OWNER, digestOf("foreign"), 1, ownerKey),
        value: "foreign",
      });
      const output = attributesFrom(news, seeded, FOREIGN_OWNER);
      const result = yield* runRead(news, output);
      assert.isTrue(Unowned.is(result));
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );

  it.live("does not project unauthenticated marker fields into Unowned attributes", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const injectedOwner = "attacker-controlled-owner";
      const marker = buildOwnerMarker(injectedOwner, news.keyedDigest, 1, ownerKey);
      const tampered = marker.slice(0, marker.length - 2) + (marker.endsWith("00") ? "11" : "00");
      const seeded = world.seedRecord(news, { comment: tampered, value: "foreign" });
      const result = yield* runRead(news, attributesFrom(news, seeded, injectedOwner));
      assert.isTrue(Unowned.is(result));
      assertNoPlaintext("unowned attributes", [injectedOwner], result);
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );
});

describe("M01B Account Secrets Store provider delete", () => {
  it.live("deletes the persisted exact ID and never resolves plaintext", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey),
        value: world.plaintext,
      });
      const output = attributesFrom(news, seeded, EXPECTED_OWNER);
      yield* runDelete(news, output);
      assert.strictEqual(world.store.size, 0);
      assert.strictEqual(world.counts.delete, 1);
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );

  it.live("tolerates a 404 on delete (already gone) without failing", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const output = attributesFrom(news, {
        secretId: "ghost",
        name: news.secretName,
        accountId: news.accountId,
        storeId: news.storeId,
        status: "active",
        scopes: SECRET_SCOPES,
        comment: buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey),
        value: undefined,
      });
      const exit = yield* Effect.exit(runDelete(news, output));
      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );

  it.live("refuses to delete a foreign-owned secret", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, {
        comment: buildOwnerMarker(FOREIGN_OWNER, digestOf("foreign"), 1, ownerKey),
        value: "foreign",
      });
      const output = attributesFrom(news, seeded, FOREIGN_OWNER);
      const exit = yield* Effect.exit(runDelete(news, output));
      assert.isTrue(Exit.isFailure(exit));
      const failure = failureOf(exit) as WriteOnlySecretFailure | undefined;
      assert.strictEqual(failure?.code, "foreign-owner");
      assert.strictEqual(world.store.size, 1);
      assert.strictEqual(world.counts.delete, 0);
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );

  it.live("refuses to delete a malformed-marker secret", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const seeded = world.seedRecord(news, { comment: "garbage", value: "x" });
      const output = attributesFrom(news, seeded, "");
      const exit = yield* Effect.exit(runDelete(news, output));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(world.counts.delete, 0);
      assert.strictEqual(world.counts.sourceResolves, 0);
    }),
  );

  it.live("refuses to delete a tampered-marker secret", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const marker = buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey);
      const tampered = marker.slice(0, marker.length - 2) + (marker.endsWith("00") ? "11" : "00");
      const seeded = world.seedRecord(news, { comment: tampered, value: "x" });
      const output = attributesFrom(news, seeded, EXPECTED_OWNER);
      const exit = yield* Effect.exit(runDelete(news, output));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(world.counts.delete, 0);
    }),
  );

  it.live("does not delete a same-name owned secret when persisted ID is gone", () =>
    Effect.gen(function* () {
      world.reset();
      const news = propsFor(world.plaintext);
      const goneOutput = attributesFrom(news, {
        secretId: "gone-A",
        name: news.secretName,
        accountId: news.accountId,
        storeId: news.storeId,
        status: "active",
        scopes: SECRET_SCOPES,
        comment: buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey),
        value: undefined,
      });
      const secretB = world.seedRecord(news, {
        secretId: "live-B",
        comment: buildOwnerMarker(EXPECTED_OWNER, news.keyedDigest, 1, ownerKey),
        value: "B-value",
      });
      yield* runDelete(news, goneOutput);
      assert.strictEqual(world.counts.find, 0, "delete must not find-by-name");
      assert.strictEqual(world.counts.delete, 0, "delete must not delete B");
      assert.ok(world.store.has(secretB.secretId), "secret B must survive");
    }),
  );
});

// End-to-end engine lifecycle + plaintext/encoding scan across Alchemy surfaces.
const { test } = Test.make({ providers });

const program = (desired: WriteOnlySecretProps) =>
  Effect.gen(function* () {
    return yield* WriteOnlySecret("Secret", desired);
  });

const getState = Effect.fnUntraced(function* () {
  const state = yield* yield* State;
  const stack = yield* Stack;
  return (yield* state.get({
    stack: stack.name,
    stage: stack.stage,
    fqn: FQN,
  })) as ResourceState | undefined;
});

describe("M01B Account Secrets Store end-to-end lifecycle and plaintext scan", () => {
  test.provider(
    "keeps plaintext out of exercised plan, state, output, and bundle surfaces",
    (stack) =>
      Effect.gen(function* () {
        world.reset();
        process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
        const plaintexts: string[] = [world.plaintext];

        const initialProps = propsFor(world.plaintext);
        const createPlan = yield* stack.plan(program(initialProps));
        assert.strictEqual(createPlan.resources[FQN]?.action, "create");
        assert.strictEqual(world.counts.sourceResolves, 0, "plan must not resolve plaintext");
        assertNoPlaintext("create plan", plaintexts, createPlan.resources[FQN]);

        const firstOutput = yield* stack.deploy(program(initialProps));
        assert.strictEqual(world.counts.sourceResolves, 1);
        assertNoPlaintext("deploy output", plaintexts, firstOutput);
        assertNoPlaintext("created state", plaintexts, encodeState(yield* getState()));

        const noOpPlan = yield* stack.plan(program(initialProps));
        assert.strictEqual(noOpPlan.resources[FQN]?.action, "noop");
        assert.strictEqual(
          world.counts.sourceResolves,
          1,
          "repeat plan must not resolve plaintext",
        );
        assertNoPlaintext("noop plan", plaintexts, noOpPlan.resources[FQN]);

        // Rotation: new plaintext drives an update.
        world.plaintext = randomBytes(32).toString("base64url");
        plaintexts.push(world.plaintext);
        const updateProps = propsFor(world.plaintext);
        const updatePlan = yield* stack.plan(program(updateProps));
        assert.strictEqual(updatePlan.resources[FQN]?.action, "update");
        assert.strictEqual(
          world.counts.sourceResolves,
          1,
          "plan must not resolve plaintext even for an update",
        );
        assertNoPlaintext("update plan", plaintexts, updatePlan.resources[FQN]);

        yield* stack.deploy(program(updateProps));
        assert.strictEqual(world.counts.sourceResolves, 2);
        assertNoPlaintext("updated state", plaintexts, encodeState(yield* getState()));

        const resolvesBeforeDestroy = world.counts.sourceResolves;
        yield* stack.destroy();
        assert.strictEqual(world.store.size, 0);
        assert.strictEqual(
          world.counts.sourceResolves,
          resolvesBeforeDestroy,
          "delete must not resolve plaintext",
        );
        assert.strictEqual(yield* getState(), undefined);
        assertNoPlaintext("delete counters", plaintexts, world.counts);

        // Bundle scan: the generated artifact must not embed plaintext either.
        const providerSource = yield* Effect.tryPromise(() =>
          readFile(new URL("write-only-secret.ts", import.meta.url), "utf8"),
        );
        assertNoPlaintext("provider source", plaintexts, providerSource);
        const bundlePath = "/tmp/scotty-m01b-write-only-secret.js";
        yield* Effect.tryPromise(() =>
          promisify(execFile)(
            "bun",
            [
              "build",
              "spikes/infra/write-only-secret.ts",
              "--target=node",
              "--external=alchemy/*",
              "--external=@effect/platform-bun/*",
              `--outfile=${bundlePath}`,
            ],
            { cwd: new URL("../../", import.meta.url) },
          ),
        );
        const bundle = yield* Effect.tryPromise(() => readFile(bundlePath, "utf8"));
        assertNoPlaintext("bundle", plaintexts, bundle);
      }),
  );

  test.provider("failed adoption cannot authorize a later unapproved deploy", (stack) =>
    Effect.gen(function* () {
      world.reset();
      process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
      const foreignProps = propsFor(world.plaintext);
      const injectedOwner = "attacker-controlled-owner";
      const marker = buildOwnerMarker(injectedOwner, digestOf("foreign"), 1, ownerKey);
      const tampered = marker.slice(0, marker.length - 2) + (marker.endsWith("00") ? "11" : "00");
      // Pre-seed an unowned secret with attacker-controlled marker fields.
      const seeded = world.seedRecord(foreignProps, {
        comment: tampered,
        value: "foreign",
      });
      const beforePatches = world.counts.patch;
      const beforeResolves = world.counts.sourceResolves;
      const adoptionProgram = program(foreignProps).pipe(adopt(true));

      assert.isUndefined(yield* getState());
      const adoptionPlan = yield* stack.plan(adoptionProgram);
      assert.strictEqual(adoptionPlan.resources[FQN]?.action, "update");
      assert.isUndefined(yield* getState());

      const adopted = yield* Effect.exit(stack.deploy(adoptionProgram));
      assert.isTrue(Exit.isFailure(adopted));
      const adoptionFailure = failureOf(adopted);
      assert.ok(isWriteOnlySecretFailure(adoptionFailure));
      assert.strictEqual(adoptionFailure.code, "foreign-owner");
      const failedState = yield* getState();
      assert.ok(failedState !== undefined);
      assert.strictEqual(failedState.status, "updating");
      assert.ok(failedState.attr !== undefined);
      assert.strictEqual(failedState.attr.secretId, seeded.secretId);
      assert.strictEqual(failedState.attr.ownerReference, "");
      assertNoPlaintext("failed adoption state", [injectedOwner], encodeState(failedState));

      const unapprovedRetry = yield* Effect.exit(stack.deploy(program(foreignProps)));
      assert.isTrue(Exit.isFailure(unapprovedRetry));
      const retryFailure = failureOf(unapprovedRetry);
      assert.ok(isWriteOnlySecretFailure(retryFailure));
      assert.strictEqual(retryFailure.code, "foreign-owner");
      const retryState = yield* getState();
      assert.ok(retryState !== undefined);
      assert.strictEqual(retryState.status, "updating");
      assert.ok(retryState.attr !== undefined);
      assert.strictEqual(retryState.attr.secretId, seeded.secretId);
      assertNoPlaintext("unapproved retry state", [injectedOwner], encodeState(retryState));
      assert.strictEqual(world.counts.patch, beforePatches);
      assert.strictEqual(world.counts.sourceResolves, beforeResolves);
      const verified = verifyOwnerMarker(seeded.comment, ownerKey);
      assert.isFalse(verified.authentic);
      assert.isUndefined(verified.ownerReference);
      assert.strictEqual(seeded.value, "foreign");
      world.store.clear();
    }),
  );
});
