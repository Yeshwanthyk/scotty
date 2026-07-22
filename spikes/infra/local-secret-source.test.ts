import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  GITHUB_TOKEN_SOURCE_ID,
  keyedSecretDigest,
  localCodexSecretPathsFromEnvironment,
  localCodexSecretSourceLayer,
  localProductionSecretSourceLayer,
  localSecretOwnerKeyLayer,
  RETAIN_PREVIOUS_OWNER_KEY,
  SCOTTY_TOKEN_SOURCE_ID,
  syncLocalSecretMetadata,
  type LocalSecretPaths,
} from "./local-secret-source.ts";
import { SECRET_VALUE_MAX_BYTES, SecretOwnerKey, SecretSource } from "./write-only-secret.ts";

const secret = "synthetic-plaintext-never-leak";
const githubToken = "ghp_synthetic-github-token-never-leak";
const scottyToken = "a".repeat(64);
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

const githubCommand = (
  path: string,
  options: { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number },
) =>
  Effect.promise(() =>
    writeFile(
      path,
      `#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != "auth" ] || [ "$2" != "token" ]; then exit 91; fi
if [ -n "\${GH_TOKEN+x}" ] || [ -n "\${GITHUB_TOKEN+x}" ]; then exit 92; fi
printf '%s' '${options.stdout ?? ""}'
printf '%s' '${options.stderr ?? ""}' >&2
exit ${options.exitCode ?? 0}
`,
      { mode: 0o700 },
    ),
  );

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-local-secret-"));
    const codexDirectory = join(directory, ".codex");
    const secretsDirectory = join(directory, ".config", "scotty", "secrets");
    const binDirectory = join(directory, "bin");
    const auth = join(codexDirectory, "auth.json");
    const root = join(secretsDirectory, "root-key");
    const recovery = join(secretsDirectory, "root-key.recovery.json");
    const scotty = join(secretsDirectory, "scotty-token");
    const gh = join(binDirectory, "gh");
    await mkdir(codexDirectory, { recursive: true });
    await mkdir(secretsDirectory, { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await writeFile(auth, JSON.stringify({ OPENAI_API_KEY: secret }), { mode: 0o600 });
    await writeFile(root, rootText, { mode: 0o600 });
    await writeFile(recovery, recoveryReceipt(rootText), { mode: 0o600 });
    await writeFile(scotty, scottyToken, { mode: 0o600 });
    await writeFile(gh, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    return {
      directory,
      binDirectory,
      auth,
      root,
      recovery,
      scotty,
      gh,
      environment: { HOME: directory, PATH: binDirectory },
      config: {
        codexAuthPath: auth,
        scottyTokenPath: scotty,
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

const resolveProductionWith = (
  environment: Readonly<Record<string, string | undefined>>,
  sourceId: string,
) =>
  Effect.gen(function* () {
    const source = yield* SecretSource;
    return yield* source.resolve(sourceId);
  }).pipe(Effect.provide(localProductionSecretSourceLayer(environment, uid)));

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
      const productionCiFailure = yield* failureText(
        Layer.build(localProductionSecretSourceLayer({ HOME: "/missing", CI: "true" }, 42)).pipe(
          Effect.scoped,
        ),
      );
      assert.match(productionCiFailure, /ci-forbidden/u);
      assert.ok(!productionCiFailure.includes("/missing"));
    }),
  );

  it.effect("routes exactly three production sources and reads only the requested source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* fixture;
        yield* Effect.promise(() => chmod(files.scotty, 0o640));
        const codex = yield* resolveProductionWith(files.environment, CODEX_AUTH_SOURCE_ID);
        assert.strictEqual(codex.plaintext, JSON.stringify({ OPENAI_API_KEY: secret }));

        yield* Effect.promise(() => rm(files.auth));
        yield* githubCommand(files.gh, { stdout: `${githubToken}\n` });
        const github = yield* resolveProductionWith(files.environment, GITHUB_TOKEN_SOURCE_ID);
        assert.strictEqual(github.plaintext, githubToken);

        yield* Effect.promise(() => rm(files.gh));
        yield* Effect.promise(() => chmod(files.scotty, 0o600));
        const scotty = yield* resolveProductionWith(files.environment, SCOTTY_TOKEN_SOURCE_ID);
        assert.strictEqual(scotty.plaintext, scottyToken);

        yield* Effect.promise(() => rm(files.root));
        const unknown = yield* failureText(
          resolveProductionWith(files.environment, "scotty/not-a-source"),
        );
        assert.match(unknown, /unknown-source/u);
        assert.ok(!unknown.includes("open-failed"));
      }),
    ),
  );

  it.effect("executes gh auth token, trims one newline, and uses the shared keyed digest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* fixture;
        yield* githubCommand(files.gh, { stdout: `${githubToken}\n` });
        const snapshot = yield* resolveProductionWith(
          { ...files.environment, GH_TOKEN: secret, GITHUB_TOKEN: secret },
          GITHUB_TOKEN_SOURCE_ID,
        );
        const { digestKey } = deriveLocalSecretKeys(Buffer.from(rootText, "base64url"));
        assert.strictEqual(snapshot.plaintext, githubToken);
        assert.strictEqual(snapshot.keyedDigest, keyedSecretDigest(githubToken, digestKey));
      }),
    ),
  );

  it.effect("rejects invalid gh output and sanitizes command failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* fixture;
        const invalidOutputs = [
          "",
          "   \n",
          `${githubToken}\n\n`,
          `${githubToken}\r\n`,
          `embedded ${githubToken}`,
        ];
        for (const stdout of invalidOutputs) {
          yield* githubCommand(files.gh, { stdout });
          const text = yield* failureText(
            resolveProductionWith(files.environment, GITHUB_TOKEN_SOURCE_ID),
          );
          assert.match(text, /invalid-github/u);
          assert.ok(!text.includes(githubToken));
        }

        const stderrSecret = "stderr-secret-never-leak";
        yield* githubCommand(files.gh, {
          stdout: githubToken,
          stderr: stderrSecret,
          exitCode: 1,
        });
        const commandFailure = yield* failureText(
          resolveProductionWith(files.environment, GITHUB_TOKEN_SOURCE_ID),
        );
        assert.match(commandFailure, /command-failed/u);
        assert.ok(!commandFailure.includes(githubToken));
        assert.ok(!commandFailure.includes(stderrSecret));
        assert.ok(!commandFailure.includes(files.gh));

        yield* githubCommand(files.gh, {
          stdout: `${"x".repeat(SECRET_VALUE_MAX_BYTES + 1)}\n`,
        });
        const oversized = yield* failureText(
          resolveProductionWith(files.environment, GITHUB_TOKEN_SOURCE_ID),
        );
        assert.match(oversized, /value-too-large/u);
        assert.ok(!oversized.includes("x".repeat(64)));

        yield* Effect.promise(() => rm(files.gh));
        const spawnFailure = yield* failureText(
          resolveProductionWith(files.environment, GITHUB_TOKEN_SOURCE_ID),
        );
        assert.match(spawnFailure, /command-failed/u);
        assert.ok(!spawnFailure.includes(files.binDirectory));
      }),
    ),
  );

  it.effect("validates the Scotty token and uses the shared keyed digest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* fixture;
        const snapshot = yield* resolveProductionWith(files.environment, SCOTTY_TOKEN_SOURCE_ID);
        const { digestKey } = deriveLocalSecretKeys(Buffer.from(rootText, "base64url"));
        assert.strictEqual(snapshot.plaintext, scottyToken);
        assert.strictEqual(snapshot.keyedDigest, keyedSecretDigest(scottyToken, digestKey));

        const invalidValues = [
          "a".repeat(63),
          "A".repeat(64),
          `${scottyToken}\n`,
          `${"b".repeat(32)} ${"b".repeat(32)}`,
        ];
        for (const plaintext of invalidValues) {
          yield* Effect.promise(() => writeFile(files.scotty, plaintext, { mode: 0o600 }));
          const text = yield* failureText(
            resolveProductionWith(files.environment, SCOTTY_TOKEN_SOURCE_ID),
          );
          assert.match(text, /invalid-scotty/u);
          assert.ok(!text.includes(plaintext));
        }
      }),
    ),
  );

  it.effect("enforces the secure file boundary for the Scotty token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* fixture;
        const target = join(files.directory, "scotty-token-target");
        const cases: Array<readonly [string, () => Promise<void>]> = [
          ["insecure-mode", () => chmod(files.scotty, 0o640)],
          [
            "open-failed",
            async () => {
              await writeFile(target, scottyToken, { mode: 0o600 });
              await rm(files.scotty);
              await symlink(target, files.scotty);
            },
          ],
          [
            "value-too-large",
            () => writeFile(files.scotty, "a".repeat(SECRET_VALUE_MAX_BYTES + 1), { mode: 0o600 }),
          ],
          [
            "not-regular-file",
            async () => {
              await rm(files.scotty);
              await mkdir(files.scotty);
            },
          ],
        ];
        for (const [code, mutate] of cases) {
          yield* Effect.promise(async () => {
            await rm(files.scotty, { force: true, recursive: true });
            await writeFile(files.scotty, scottyToken, { mode: 0o600 });
            await mutate();
          });
          const text = yield* failureText(
            resolveProductionWith(files.environment, SCOTTY_TOKEN_SOURCE_ID),
          );
          assert.ok(text.includes(code), `${code}: ${text}`);
          assert.ok(!text.includes(scottyToken));
          assert.ok(!text.includes(files.scotty));
        }

        yield* Effect.promise(() => rm(files.scotty, { force: true, recursive: true }));
        yield* Effect.promise(() => writeFile(files.scotty, scottyToken, { mode: 0o600 }));
        const wrongOwner = yield* failureText(
          Effect.gen(function* () {
            const source = yield* SecretSource;
            return yield* source.resolve(SCOTTY_TOKEN_SOURCE_ID);
          }).pipe(Effect.provide(localProductionSecretSourceLayer(files.environment, uid + 1))),
        );
        assert.match(wrongOwner, /wrong-owner/u);
        assert.ok(!wrongOwner.includes(scottyToken));
      }),
    ),
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
