import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import {
  decodeCredentialDeclarationsOption,
  decodeCredentialGrantOption,
  decodeCredentialNameOption,
  decodePiAuthCredentialDeclarationOption,
  formatManagedHandle,
  isCredentialName,
  parseManagedHandle,
} from "../../protocol/credentials";
import {
  CredentialRegistryGrantResultSchema,
  CredentialRegistryResolveInputSchema,
  CredentialRegistryResolvedCredentialSchema,
  CredentialRegistrySyncInputSchema,
  EncryptedCredentialEnvelopeSchema,
  decodeEncryptedCredentialEnvelopeResult,
} from "../src/credential-contracts";
import {
  CredentialCrypto,
  CREDENTIAL_ENVELOPE_IV_BYTES,
  CREDENTIAL_WRAPPING_KEY_BYTES,
  constantTimeEqual,
  credentialAssociatedData,
  credentialCryptoLayer,
  decodeWrappingKey,
  installationWrappingKeyLayer,
  directWorkerSecretInstallationWrappingKeyLayer,
  type CredentialCryptoFailure,
} from "../src/credential-crypto";

const INSTALLATION = "test-installation";
const NAME = "openai";
const VERSION = "version_a";
const KEY = Uint8Array.from({ length: CREDENTIAL_WRAPPING_KEY_BYTES }, (_, index) => index + 1);
const SECRET = "provider-credential-must-not-escape";

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const fixedCryptoLayer = credentialCryptoLayer.pipe(
  Layer.provide(installationWrappingKeyLayer(() => Effect.succeed(Uint8Array.from(KEY)))),
);

const decodeSyncInputOption = Schema.decodeUnknownOption(CredentialRegistrySyncInputSchema, {
  onExcessProperty: "error",
});
const decodeGrantResultOption = Schema.decodeUnknownOption(CredentialRegistryGrantResultSchema, {
  onExcessProperty: "error",
});
const decodeResolvedCredentialOption = Schema.decodeUnknownOption(
  CredentialRegistryResolvedCredentialSchema,
  { onExcessProperty: "error" },
);
const decodeResolveInputOption = Schema.decodeUnknownOption(CredentialRegistryResolveInputSchema, {
  onExcessProperty: "error",
});
const decodeEnvelopeOption = Schema.decodeUnknownOption(EncryptedCredentialEnvelopeSchema);

const failure = <A>(result: Result.Result<A, CredentialCryptoFailure>): CredentialCryptoFailure => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("credential protocol contracts", () => {
  it("accepts only strict names and the pi-auth global declaration vocabulary", () => {
    for (const name of ["openai", "openai-codex", "a1"]) {
      assert.ok(Option.isSome(decodeCredentialNameOption(name)));
      assert.isTrue(isCredentialName(name));
    }
    for (const name of ["", "OpenAI", "open_ai", "-openai", "openai-", "a".repeat(65)]) {
      assert.isFalse(isCredentialName(name));
    }

    const declaration = {
      kind: "pi-auth",
      source: "~/.pi/agent/auth.json",
      scope: "global",
    } as const;
    assert.ok(Option.isSome(decodePiAuthCredentialDeclarationOption(declaration)));
    assert.ok(
      Option.isNone(
        decodePiAuthCredentialDeclarationOption({ ...declaration, scope: "repository" }),
      ),
    );
    assert.ok(
      Option.isNone(
        decodePiAuthCredentialDeclarationOption({ ...declaration, unexpected: "value" }),
      ),
    );
    assert.ok(Option.isNone(decodeCredentialDeclarationsOption({ "bad/name": declaration })));
    assert.ok(Option.isNone(decodeCredentialDeclarationsOption({ OPENAI: declaration })));
  });

  it("formats managed handles canonically and rejects lookalikes", () => {
    const handle = { name: NAME, provider: "openai-codex", slot: "access" } as const;
    const formatted = formatManagedHandle(handle);
    assert.strictEqual(formatted, "scotty-managed://openai/openai-codex/access");
    assert.deepStrictEqual(parseManagedHandle(formatted), Option.some(handle));
    for (const value of [
      "scotty-managed://openai/openai-codex/access/extra",
      "scotty-managed://openai/openai-codex/api_key",
      "scotty-managed://OpenAI/openai-codex/access",
      "scotty-managed://openai/openai-codex/access%2Fextra",
      "scotty-managed:/openai/openai-codex/access",
    ]) {
      assert.ok(Option.isNone(parseManagedHandle(value)));
    }
  });

  it("keeps registry envelopes and RPC contracts bounded and non-secret", () => {
    const envelope = {
      version: 1,
      kind: "pi-auth",
      iv: bytesToBase64Url(new Uint8Array(CREDENTIAL_ENVELOPE_IV_BYTES)),
      ciphertext: bytesToBase64Url(Uint8Array.from([1, 2, 3])),
      keyedDigest: bytesToBase64Url(new Uint8Array(32)),
    } as const;
    assert.ok(Result.isSuccess(decodeEncryptedCredentialEnvelopeResult(envelope)));
    assert.ok(
      Result.isFailure(decodeEncryptedCredentialEnvelopeResult({ ...envelope, iv: "not base64!" })),
    );
    assert.ok(
      Result.isFailure(decodeEncryptedCredentialEnvelopeResult({ ...envelope, secret: SECRET })),
    );

    const grant = {
      name: NAME,
      kind: "pi-auth",
      versionRef: VERSION,
      handleSlots: [{ provider: "openai-codex", slot: "access" }],
    } as const;
    assert.ok(Option.isSome(decodeCredentialGrantOption(grant)));
    assert.ok(Option.isSome(decodeCredentialGrantOption({ ...grant, expires: 1_777_777_777_123 })));
    assert.ok(
      Option.isSome(
        decodeSyncInputOption({
          version: 1,
          credentials: [
            {
              name: NAME,
              kind: "pi-auth",
              scope: "global",
              versionRef: VERSION,
              envelope,
            },
          ],
        }),
      ),
    );
    assert.ok(
      Option.isSome(
        decodeGrantResultOption({ version: 1, sessionId: "a0b1c2d3e4f5", grants: [grant] }),
      ),
    );
    assert.ok(
      Option.isSome(
        decodeResolveInputOption({
          version: 1,
          sessionId: "a0b1c2d3e4f5",
          name: NAME,
          kind: "pi-auth",
          versionRef: VERSION,
          handle: "scotty-managed://openai/openai-codex/access",
        }),
      ),
    );
    const wire = { version: 1 as const, value: SECRET };
    const transported = structuredClone(wire);
    assert.deepStrictEqual(transported, wire);
    assert.ok(Option.isSome(decodeResolvedCredentialOption(transported)));
    assert.ok(Option.isNone(decodeResolvedCredentialOption({ version: 1, value: "" })));
    assert.ok(
      Option.isNone(
        decodeResolvedCredentialOption({ version: 1, value: "x".repeat(256 * 1024 + 1) }),
      ),
    );
    assert.ok(
      Option.isSome(
        decodeEnvelopeOption({
          ...envelope,
          kind: "github-cli",
        }),
      ),
    );
  });
});

describe("credential cryptography", () => {
  it.effect("decodes the direct Worker secret lazily and fails closed", () => {
    const layer = directWorkerSecretInstallationWrappingKeyLayer(bytesToBase64Url(KEY));
    const effect = Effect.gen(function* () {
      const decoded = yield* decodeWrappingKey(bytesToBase64Url(KEY));
      assert.deepStrictEqual(decoded, KEY);
      const crypto = yield* CredentialCrypto;
      yield* crypto.encrypt(INSTALLATION, NAME, VERSION, "pi-auth", Redacted.make(SECRET));
      yield* crypto.encrypt(INSTALLATION, NAME, VERSION, "pi-auth", Redacted.make(SECRET));
      for (const malformed of [
        "",
        "not base64!",
        bytesToBase64Url(new Uint8Array(CREDENTIAL_WRAPPING_KEY_BYTES - 1)),
        null,
      ]) {
        const result = yield* Effect.result(decodeWrappingKey(malformed));
        assert.deepInclude(failure(result), {
          reason: "wrapping_key_unavailable",
          message: "Installation wrapping key is unavailable",
        });
      }
    });
    return effect.pipe(Effect.provide(credentialCryptoLayer.pipe(Layer.provide(layer))));
  });

  it.effect("round-trips with random IVs, a stable keyed digest, and context-bound AAD", () =>
    Effect.gen(function* () {
      const crypto = yield* CredentialCrypto;
      const first = yield* crypto.encrypt(
        INSTALLATION,
        NAME,
        VERSION,
        "pi-auth",
        Redacted.make(SECRET),
      );
      const second = yield* crypto.encrypt(
        INSTALLATION,
        NAME,
        VERSION,
        "pi-auth",
        Redacted.make(SECRET),
      );
      assert.strictEqual(first.version, 1);
      assert.strictEqual(first.kind, "pi-auth");
      assert.notStrictEqual(first.iv, second.iv);
      assert.notStrictEqual(first.ciphertext, second.ciphertext);
      assert.strictEqual(first.keyedDigest, second.keyedDigest);
      assert.strictEqual(first.iv.length, 16);
      assert.strictEqual(
        yield* crypto
          .decrypt(INSTALLATION, NAME, VERSION, "pi-auth", first)
          .pipe(Effect.map(Redacted.value)),
        SECRET,
      );
      for (const context of [
        ["other-installation", NAME, VERSION, "pi-auth"],
        [INSTALLATION, "other", VERSION, "pi-auth"],
        [INSTALLATION, NAME, "other-version", "pi-auth"],
        [INSTALLATION, NAME, VERSION, "github-cli"],
      ] as const) {
        const result = yield* Effect.result(
          crypto.decrypt(context[0], context[1], context[2], context[3], first),
        );
        assert.deepInclude(failure(result), {
          reason: "crypto_failed",
          message: "Credential cryptographic operation failed",
        });
      }
      assert.ok(!JSON.stringify(first).includes(SECRET));
      assert.isFalse(
        constantTimeEqual(
          credentialAssociatedData({
            installation: INSTALLATION,
            name: NAME,
            version: VERSION,
            kind: "pi-auth",
          }),
          credentialAssociatedData({
            installation: INSTALLATION,
            name: NAME,
            version: "other-version",
            kind: "pi-auth",
          }),
        ),
      );
    }).pipe(Effect.provide(fixedCryptoLayer)),
  );

  it.effect("rejects tampering, wrong keys, and missing wrapping keys with fixed failures", () =>
    Effect.gen(function* () {
      const encrypted = yield* Effect.provide(
        Effect.flatMap(CredentialCrypto, (crypto) =>
          crypto.encrypt(INSTALLATION, NAME, VERSION, "pi-auth", Redacted.make(SECRET)),
        ),
        fixedCryptoLayer,
      );
      const tamperedDigest = yield* Effect.provide(
        Effect.result(
          Effect.flatMap(CredentialCrypto, (crypto) =>
            crypto.decrypt(INSTALLATION, NAME, VERSION, "pi-auth", {
              ...encrypted,
              keyedDigest: bytesToBase64Url(new Uint8Array(32)),
            }),
          ),
        ),
        fixedCryptoLayer,
      );
      assert.deepInclude(failure(tamperedDigest), {
        reason: "crypto_failed",
        message: "Credential cryptographic operation failed",
      });
      const tamperedKind = yield* Effect.provide(
        Effect.result(
          Effect.flatMap(CredentialCrypto, (crypto) =>
            crypto.decrypt(INSTALLATION, NAME, VERSION, "pi-auth", {
              ...encrypted,
              kind: "github-cli",
            }),
          ),
        ),
        fixedCryptoLayer,
      );
      assert.deepInclude(failure(tamperedKind), {
        reason: "crypto_failed",
        message: "Credential cryptographic operation failed",
      });
      const wrongKey = Uint8Array.from(KEY, (byte) => byte ^ 0xff);
      const wrongKeyLayer = credentialCryptoLayer.pipe(
        Layer.provide(installationWrappingKeyLayer(() => Effect.succeed(wrongKey))),
      );
      const wrongKeyResult = yield* Effect.provide(
        Effect.result(
          Effect.flatMap(CredentialCrypto, (crypto) =>
            crypto.decrypt(INSTALLATION, NAME, VERSION, "pi-auth", encrypted),
          ),
        ),
        wrongKeyLayer,
      );
      assert.deepInclude(failure(wrongKeyResult), {
        reason: "crypto_failed",
        message: "Credential cryptographic operation failed",
      });
      const missingKeyResult = yield* Effect.provide(
        Effect.result(
          Effect.flatMap(CredentialCrypto, (crypto) =>
            crypto.decrypt(INSTALLATION, NAME, VERSION, "pi-auth", encrypted),
          ),
        ),
        credentialCryptoLayer.pipe(
          Layer.provide(directWorkerSecretInstallationWrappingKeyLayer(undefined)),
        ),
      );
      assert.deepInclude(failure(missingKeyResult), {
        reason: "wrapping_key_unavailable",
        message: "Installation wrapping key is unavailable",
      });
      assert.ok(!JSON.stringify(failure(tamperedDigest)).includes(SECRET));
      assert.ok(!JSON.stringify(failure(tamperedKind)).includes(SECRET));
      assert.ok(!JSON.stringify(failure(wrongKeyResult)).includes(SECRET));
      assert.ok(!JSON.stringify(failure(missingKeyResult)).includes(SECRET));
    }),
  );

  it("compares bytes without content-dependent early exit", () => {
    assert.isTrue(constantTimeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3])));
    assert.isFalse(constantTimeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4])));
    assert.isFalse(constantTimeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2])));
  });
});
