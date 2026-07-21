import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CODEX_AUTH_SOURCE_ID,
  disposableLocalSecretScanMarkers,
  disposableLocalSecretSourceLayer,
  deriveLocalSecretKeys,
  keyedSecretDigest,
  localCodexSecretPathsFromEnvironment,
  localCodexSecretSourceLayer,
  localSecretOwnerKeyLayer,
  RETAIN_PREVIOUS_OWNER_KEY,
  syncLocalSecretMetadata,
  type LocalSecretPaths,
} from "./local-secret-source.ts";
import { SecretOwnerKey, SecretSource } from "./write-only-secret.ts";

const secret = "synthetic-plaintext-never-leak";
const rootText = randomBytes(32).toString("base64url");
const uid = process.getuid?.() ?? -1;
const recoveryReceipt = (encodedRoot: string, escrowId = "encrypted-backup:test") =>
  JSON.stringify({
    version: 1,
    rootKeyFingerprint: createHash("sha256")
      .update(Buffer.from(encodedRoot, "base64url"))
      .digest("hex"),
    escrowId,
  });

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-local-secret-"));
    const auth = join(directory, "auth.json");
    const root = join(directory, "root");
    const recovery = join(directory, "root.recovery.json");
    await writeFile(auth, JSON.stringify({ OPENAI_API_KEY: secret }), { mode: 0o600 });
    await writeFile(root, rootText, { mode: 0o600 });
    await writeFile(recovery, recoveryReceipt(rootText), { mode: 0o600 });
    return {
      directory,
      auth,
      root,
      recovery,
      config: {
        codexAuthPath: auth,
        rootKeyPath: root,
        recoveryReceiptPath: recovery,
        expectedUid: uid,
      },
    };
  }),
  ({ directory }) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);

const resolveWith = (config: LocalSecretPaths, sourceId = CODEX_AUTH_SOURCE_ID) =>
  Effect.gen(function* () {
    const source = yield* SecretSource;
    return yield* source.resolve(sourceId);
  }).pipe(Effect.provide(disposableLocalSecretSourceLayer(config, CODEX_AUTH_SOURCE_ID)));

const failureText = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.map(Effect.flip(effect), inspect);

describe("local Codex secret source", () => {
  it("derives deterministic domain-separated keys and canonical digests", () => {
    const root = Buffer.alloc(32, 7);
    const first = deriveLocalSecretKeys(root);
    const second = deriveLocalSecretKeys(root);
    assert.deepStrictEqual(first, second);
    assert.notStrictEqual(
      Buffer.from(first.digestKey).toString("hex"),
      Buffer.from(first.ownerKey).toString("hex"),
    );
    assert.match(keyedSecretDigest("value", first.digestKey), /^hmac-sha256:v1:[0-9a-f]{64}$/);
  });

  it.effect("is lazy, resolves the exact source, and emits metadata-only plans", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const missing: LocalSecretPaths = {
          codexAuthPath: "/missing/auth",
          rootKeyPath: "/missing/root",
          expectedUid: uid,
        };
        yield* Layer.build(disposableLocalSecretSourceLayer(missing, CODEX_AUTH_SOURCE_ID));

        const files = yield* fixture;
        const snapshot = yield* resolveWith(files.config);
        assert.strictEqual(snapshot.plaintext, JSON.stringify({ OPENAI_API_KEY: secret }));
        assert.match(snapshot.keyedDigest, /^hmac-sha256:v1:[0-9a-f]{64}$/);
        const plan = yield* syncLocalSecretMetadata().pipe(
          Effect.provide(disposableLocalSecretSourceLayer(files.config, CODEX_AUTH_SOURCE_ID)),
        );
        assert.deepStrictEqual(Object.keys(plan).sort(), ["keyedDigest", "sourceId"]);
        assert.ok(!inspect(plan).includes(secret));
        assert.ok(!inspect(plan).includes(rootText));
        const markers = yield* disposableLocalSecretScanMarkers(files.config, CODEX_AUTH_SOURCE_ID);
        assert.deepEqual(markers, [JSON.stringify({ OPENAI_API_KEY: secret }), secret, rootText]);
      }),
    ),
  );

  it.effect("rejects unknown sources before any file read", () =>
    Effect.gen(function* () {
      const text = yield* failureText(
        resolveWith(
          {
            codexAuthPath: `/missing/${secret}`,
            rootKeyPath: `/missing/${rootText}`,
            expectedUid: 0,
          },
          `/unknown/${secret}/${rootText}`,
        ),
      );
      assert.match(text, /unknown-source/);
      assert.ok(!text.includes(secret));
      assert.ok(!text.includes(rootText));
      assert.ok(!text.includes("/unknown/"));
      assert.ok(!text.includes("open-failed"));
    }),
  );

  it.effect("maps the production source exactly and rejects CI before file reads", () =>
    Effect.gen(function* () {
      const defaultPaths = yield* localCodexSecretPathsFromEnvironment(
        { HOME: "/home/operator" },
        42,
      );
      assert.deepEqual(defaultPaths, {
        codexAuthPath: "/home/operator/.codex/auth.json",
        rootKeyPath: "/home/operator/.config/scotty/secrets/root-key",
        recoveryReceiptPath: "/home/operator/.config/scotty/secrets/root-key.recovery.json",
        previousRootKeyPaths: [],
        expectedUid: 42,
      });
      const rotated = yield* localCodexSecretPathsFromEnvironment(
        {
          HOME: "/home/operator",
          CODEX_HOME: "/secure/codex",
          [RETAIN_PREVIOUS_OWNER_KEY]: "1",
        },
        42,
      );
      assert.strictEqual(rotated.codexAuthPath, "/secure/codex/auth.json");
      assert.deepEqual(rotated.previousRootKeyPaths, [
        "/home/operator/.config/scotty/secrets/root-key.previous",
      ]);
      yield* Layer.build(localCodexSecretSourceLayer({ HOME: "/missing" }, 42)).pipe(Effect.scoped);
      const ciFailure = yield* failureText(
        Layer.build(localCodexSecretSourceLayer({ HOME: "/missing", CI: "true" }, 42)).pipe(
          Effect.scoped,
        ),
      );
      assert.match(ciFailure, /ci-forbidden/u);
      assert.ok(!ciFailure.includes("/missing"));
    }),
  );

  it.effect("changes the digest when plaintext rotates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* fixture;
        const before = yield* resolveWith(files.config);
        yield* Effect.promise(() =>
          writeFile(files.auth, JSON.stringify({ tokens: { access_token: "rotated" } }), {
            mode: 0o600,
          }),
        );
        const after = yield* resolveWith(files.config);
        assert.notStrictEqual(before.keyedDigest, after.keyedDigest);
      }),
    ),
  );

  it.effect("loads a stable active key and explicitly retained previous keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* fixture;
        const previousRootText = randomBytes(32).toString("base64url");
        const previousRootPath = join(files.directory, "previous-root");
        const previousRecoveryPath = `${previousRootPath}.recovery.json`;
        yield* Effect.promise(() => writeFile(previousRootPath, previousRootText, { mode: 0o600 }));
        yield* Effect.promise(() =>
          writeFile(previousRecoveryPath, recoveryReceipt(previousRootText), { mode: 0o600 }),
        );
        const keys = yield* SecretOwnerKey.pipe(
          Effect.provide(
            localSecretOwnerKeyLayer({
              ...files.config,
              previousRootKeyPaths: [previousRootPath],
            }),
          ),
        );
        assert.strictEqual(
          Buffer.from(keys.active).toString("hex"),
          Buffer.from(deriveLocalSecretKeys(Buffer.from(rootText, "base64url")).ownerKey).toString(
            "hex",
          ),
        );
        assert.deepEqual(
          keys.previous.map((key) => Buffer.from(key).toString("hex")),
          [
            Buffer.from(
              deriveLocalSecretKeys(Buffer.from(previousRootText, "base64url")).ownerKey,
            ).toString("hex"),
          ],
        );
      }),
    ),
  );

  it.effect("requires matching recovery evidence and bounds retained owner keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* fixture;
        const missingRecovery = yield* failureText(
          SecretOwnerKey.pipe(
            Effect.provide(
              localSecretOwnerKeyLayer({ ...files.config, recoveryReceiptPath: undefined }),
            ),
          ),
        );
        assert.match(missingRecovery, /recovery-required/u);
        assert.ok(!missingRecovery.includes(rootText));

        yield* Effect.promise(() =>
          writeFile(files.recovery, recoveryReceipt(randomBytes(32).toString("base64url")), {
            mode: 0o600,
          }),
        );
        const mismatch = yield* failureText(
          SecretOwnerKey.pipe(Effect.provide(localSecretOwnerKeyLayer(files.config))),
        );
        assert.match(mismatch, /recovery-mismatch/u);
        assert.ok(!mismatch.includes(rootText));

        const tooMany = yield* failureText(
          SecretOwnerKey.pipe(
            Effect.provide(
              localSecretOwnerKeyLayer({
                ...files.config,
                previousRootKeyPaths: ["/never-read/one", "/never-read/two"],
              }),
            ),
          ),
        );
        assert.match(tooMany, /too-many-previous-keys/u);
        assert.ok(!tooMany.includes("/never-read/"));
      }),
    ),
  );

  it.effect(
    "fails closed for malformed, oversized, symlinked, wrong-mode, owner, and root files",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const files = yield* fixture;
          const cases: Array<readonly [string, () => Promise<void>, Partial<LocalSecretPaths>]> = [
            [
              "invalid-auth",
              () => writeFile(files.auth, `{'OPENAI_API_KEY':'${secret}'`, { mode: 0o600 }),
              {},
            ],
            ["value-too-large", () => writeFile(files.auth, "x".repeat(1025), { mode: 0o600 }), {}],
            ["insecure-mode", () => chmod(files.auth, 0o640), {}],
            ["insecure-mode", () => chmod(files.auth, 0o700), {}],
            ["wrong-owner", async () => {}, { expectedUid: uid + 1 }],
            [
              "invalid-root",
              () => writeFile(files.root, "not-canonical-root", { mode: 0o600 }),
              {},
            ],
          ];
          for (const [code, mutate, overrides] of cases) {
            yield* Effect.promise(async () => {
              await writeFile(files.auth, JSON.stringify({ OPENAI_API_KEY: secret }), {
                mode: 0o600,
              });
              await chmod(files.auth, 0o600);
              await writeFile(files.root, rootText, { mode: 0o600 });
              await mutate();
            });
            const text = yield* failureText(resolveWith({ ...files.config, ...overrides }));
            assert.ok(text.includes(code), `${code}: ${text}`);
            assert.ok(!text.includes(secret));
            assert.ok(!text.includes(rootText));
          }

          const link = join(files.directory, "auth-link");
          yield* Effect.promise(() => writeFile(files.root, rootText, { mode: 0o600 }));
          yield* Effect.promise(() => symlink(files.auth, link));
          const symlinkText = yield* failureText(
            resolveWith({ ...files.config, codexAuthPath: link }),
          );
          assert.match(symlinkText, /open-failed/);
          assert.ok(!symlinkText.includes(secret));
        }),
      ),
  );
});
