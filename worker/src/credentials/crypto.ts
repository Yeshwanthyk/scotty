import { Context, Data, Effect, Layer, Redacted, Result, Schema } from "effect";
import {
  CredentialEncryptionContextSchema,
  decodeEncryptedCredentialEnvelopeResult,
  type CredentialEncryptionContext,
  type EncryptedCredentialEnvelope,
} from "./contracts";
import type { CredentialKind } from "../../../protocol/credentials";

const encoder = new TextEncoder();
const WRAPPING_KEY_BYTES = 32;
const IV_BYTES = 12;
const DIGEST_BYTES = 32;
const HKDF_SALT = encoder.encode("scotty/credential-authority");

export const CREDENTIAL_WRAPPING_KEY_BYTES = WRAPPING_KEY_BYTES;
export const CREDENTIAL_ENVELOPE_IV_BYTES = IV_BYTES;

export type CredentialCryptoFailureReason = "wrapping_key_unavailable" | "crypto_failed";

export class CredentialCryptoFailure extends Data.TaggedError("CredentialCryptoFailure")<{
  readonly reason: CredentialCryptoFailureReason;
  readonly message: string;
}> {}

export interface InstallationWrappingKeyShape {
  readonly get: Effect.Effect<Uint8Array, CredentialCryptoFailure>;
}

export class InstallationWrappingKey extends Context.Service<
  InstallationWrappingKey,
  InstallationWrappingKeyShape
>()("scotty/InstallationWrappingKey") {}

type DirectWorkerSecret = string;

export interface CredentialCryptoShape {
  readonly encrypt: (
    installation: string,
    name: string,
    version: string,
    kind: CredentialKind,
    plaintext: Redacted.Redacted<string>,
  ) => Effect.Effect<EncryptedCredentialEnvelope, CredentialCryptoFailure>;
  readonly decrypt: (
    installation: string,
    name: string,
    version: string,
    kind: CredentialKind,
    encrypted: unknown,
  ) => Effect.Effect<Redacted.Redacted<string>, CredentialCryptoFailure>;
}

export class CredentialCrypto extends Context.Service<CredentialCrypto, CredentialCryptoShape>()(
  "scotty/CredentialCrypto",
) {}

export const installationWrappingKeyLayer = (
  getKey: () => Effect.Effect<Uint8Array, CredentialCryptoFailure>,
): Layer.Layer<InstallationWrappingKey> =>
  Layer.succeed(InstallationWrappingKey)(
    InstallationWrappingKey.of({ get: Effect.suspend(getKey) }),
  );

export const directWorkerSecretInstallationWrappingKeyLayer = (
  secret: DirectWorkerSecret | undefined,
): Layer.Layer<InstallationWrappingKey> =>
  installationWrappingKeyLayer(() => {
    if (secret === undefined) return Effect.fail(wrappingKeyUnavailable());
    return decodeWrappingKey(secret);
  });

export const credentialCryptoLayer: Layer.Layer<CredentialCrypto, never, InstallationWrappingKey> =
  Layer.effect(
    CredentialCrypto,
    Effect.gen(function* () {
      const wrappingKey = yield* InstallationWrappingKey;
      return CredentialCrypto.of({
        encrypt: Effect.fnUntraced(function* (installation, name, version, kind, plaintext) {
          const context = yield* encryptionContext(installation, name, version, kind);
          const keys = yield* deriveKeys(wrappingKey.get);
          const iv = yield* randomBytes(IV_BYTES);
          const value = encoder.encode(Redacted.value(plaintext));
          const ciphertext = yield* cryptoPromise(() =>
            crypto.subtle.encrypt(
              {
                name: "AES-GCM",
                iv: ownedBuffer(iv),
                additionalData: ownedBuffer(credentialAssociatedData(context)),
                tagLength: 128,
              },
              keys.encryption,
              ownedBuffer(value),
            ),
          );
          const digest = yield* cryptoPromise(() =>
            crypto.subtle.sign("HMAC", keys.digest, ownedBuffer(value)),
          );
          return {
            kind: context.kind,
            iv: bytesToBase64Url(iv),
            ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
            keyedDigest: bytesToBase64Url(new Uint8Array(digest)),
          };
        }),
        decrypt: Effect.fnUntraced(function* (installation, name, version, kind, encrypted) {
          const context = yield* encryptionContext(installation, name, version, kind);
          const envelope = yield* decodeEnvelope(encrypted);
          if (envelope.kind !== context.kind) return yield* cryptoFailed();
          const iv = yield* decodeBase64Url(envelope.iv);
          const ciphertext = yield* decodeBase64Url(envelope.ciphertext);
          const keyedDigest = yield* decodeBase64Url(envelope.keyedDigest);
          if (iv.byteLength !== IV_BYTES || keyedDigest.byteLength !== DIGEST_BYTES)
            return yield* cryptoFailed();

          const keys = yield* deriveKeys(wrappingKey.get);
          const cleartext = yield* cryptoPromise(() =>
            crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: ownedBuffer(iv),
                additionalData: ownedBuffer(credentialAssociatedData(context)),
                tagLength: 128,
              },
              keys.encryption,
              ownedBuffer(ciphertext),
            ),
          );
          const plaintext = yield* Effect.try({
            try: () =>
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(cleartext),
            catch: cryptoFailure,
          });
          const digest = yield* cryptoPromise(() =>
            crypto.subtle.sign("HMAC", keys.digest, encoder.encode(plaintext)),
          );
          if (!constantTimeEqual(new Uint8Array(digest), keyedDigest)) return yield* cryptoFailed();
          return Redacted.make(plaintext);
        }),
      });
    }),
  );

export const decodeWrappingKey = (
  value: unknown,
): Effect.Effect<Uint8Array, CredentialCryptoFailure> =>
  decodeBase64Url(value).pipe(
    Effect.flatMap((bytes) =>
      bytes.byteLength === WRAPPING_KEY_BYTES
        ? Effect.succeed(bytes)
        : Effect.fail(wrappingKeyUnavailable()),
    ),
    Effect.mapError(() => wrappingKeyUnavailable()),
  );

export const credentialAssociatedData = (context: CredentialEncryptionContext): Uint8Array =>
  encoder.encode(
    `scotty/credential\u0000${context.installation}\u0000${context.name}\u0000${context.version}\u0000${context.kind}`,
  );

export const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

interface DerivedKeys {
  readonly encryption: CryptoKey;
  readonly digest: CryptoKey;
}

const encryptionContext = (
  installation: string,
  name: string,
  version: string,
  kind: CredentialKind,
): Effect.Effect<CredentialEncryptionContext, CredentialCryptoFailure> =>
  Effect.fromResult(
    Result.mapError(decodeEncryptionContext({ installation, name, version, kind }), cryptoFailure),
  );

const decodeEncryptionContext = Schema.decodeUnknownResult(CredentialEncryptionContextSchema, {
  onExcessProperty: "error",
});

const decodeEnvelope = (
  value: unknown,
): Effect.Effect<EncryptedCredentialEnvelope, CredentialCryptoFailure> =>
  Effect.fromResult(Result.mapError(decodeEncryptedCredentialEnvelopeResult(value), cryptoFailure));

const deriveKeys = Effect.fnUntraced(function* (
  keyEffect: Effect.Effect<Uint8Array, CredentialCryptoFailure>,
) {
  const keyBytes = yield* keyEffect.pipe(Effect.mapError(() => wrappingKeyUnavailable()));
  if (keyBytes.byteLength !== WRAPPING_KEY_BYTES) return yield* wrappingKeyUnavailable();

  const source = yield* cryptoPromise(() =>
    crypto.subtle.importKey("raw", ownedBuffer(keyBytes), "HKDF", false, ["deriveKey"]),
  );
  const encryption = yield* cryptoPromise(() =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: ownedBuffer(HKDF_SALT),
        info: encoder.encode("aes-gcm"),
      },
      source,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
  );
  const digest = yield* cryptoPromise(() =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: ownedBuffer(HKDF_SALT),
        info: encoder.encode("keyed-digest"),
      },
      source,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    ),
  );
  return { encryption, digest } satisfies DerivedKeys;
});

const randomBytes = (length: number): Effect.Effect<Uint8Array, CredentialCryptoFailure> =>
  Effect.try({
    try: () => crypto.getRandomValues(new Uint8Array(length)),
    catch: cryptoFailure,
  });

const cryptoPromise = <A>(operation: () => Promise<A>): Effect.Effect<A, CredentialCryptoFailure> =>
  Effect.tryPromise({ try: operation, catch: cryptoFailure });

const cryptoFailed = (): Effect.Effect<never, CredentialCryptoFailure> =>
  Effect.fail(cryptoFailure());

const wrappingKeyUnavailable = (): CredentialCryptoFailure =>
  new CredentialCryptoFailure({
    reason: "wrapping_key_unavailable",
    message: "Installation wrapping key is unavailable",
  });

const cryptoFailure = (): CredentialCryptoFailure =>
  new CredentialCryptoFailure({
    reason: "crypto_failed",
    message: "Credential cryptographic operation failed",
  });

const decodeBase64Url = (value: unknown): Effect.Effect<Uint8Array, CredentialCryptoFailure> => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1)
    return Effect.fail(cryptoFailure());
  return Effect.try({
    try: () => {
      const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
      const binary = atob(padded);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    },
    catch: cryptoFailure,
  }).pipe(
    Effect.flatMap((bytes) =>
      bytesToBase64Url(bytes) === value ? Effect.succeed(bytes) : Effect.fail(cryptoFailure()),
    ),
  );
};

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};
