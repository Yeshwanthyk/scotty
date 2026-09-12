import { join } from "node:path";
import {
  digestPiAuthProviders,
  parsePiAuthJsonOption,
  piProviderMetadata,
  type PiCredential,
} from "../../protocol/pi-auth";
import { Effect, Option, Schema, Result } from "effect";
import { CliError, EXIT } from "./core";
import { CliRuntime, FileSystem, ProcessRunner } from "./services";

const authFailure = (message: string, hint: string): CliError =>
  new CliError("invalid_pi_auth", message, hint, EXIT.USAGE);

const NativeCodexTokenSchema = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  account_id: Schema.optionalKey(Schema.NonEmptyString),
  id_token: Schema.optionalKey(Schema.NonEmptyString),
  expires: Schema.optionalKey(Schema.Finite),
});
const NativeCodexAuthSchema = Schema.Struct({
  tokens: NativeCodexTokenSchema,
  expires: Schema.optionalKey(Schema.Finite),
});
const decodeNativeCodexAuth = Schema.decodeUnknownResult(
  Schema.fromJsonString(NativeCodexAuthSchema),
  {
    onExcessProperty: "preserve",
  },
);
const decodeJwtPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.optionalKey(Schema.Number) })),
  { onExcessProperty: "preserve" },
);

const jwtExpiryMillis = Effect.fnUntraced(function* (token: string) {
  const encoded = token.split(".")[1];
  if (encoded === undefined) return undefined;
  const normalized = encoded
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const text = yield* Effect.try({ try: () => atob(normalized), catch: () => undefined });
  if (text === undefined) return undefined;
  const payload = decodeJwtPayload(
    new TextDecoder().decode(Uint8Array.from(text, (character) => character.codePointAt(0) ?? 0)),
  );
  if (
    Option.isNone(payload) ||
    payload.value.exp === undefined ||
    !Number.isFinite(payload.value.exp)
  )
    return undefined;
  return payload.value.exp * 1_000;
});

export const readLocalCodexAuth = Effect.fnUntraced(function* (path?: string) {
  const runtime = yield* CliRuntime;
  const fileSystem = yield* FileSystem;
  const authPath = path ?? join(runtime.home, ".codex", "auth.json");
  const raw = yield* fileSystem
    .readPrivateText(authPath)
    .pipe(
      Effect.mapError(() =>
        authFailure(
          "Codex auth.json must be a readable private regular file",
          `Use a non-symlinked mode-0600 file at ${authPath}.`,
        ),
      ),
    );
  const decoded = decodeNativeCodexAuth(raw);
  if (Result.isFailure(decoded))
    return yield* authFailure(
      "Codex auth.json has no supported OAuth credential",
      "Run Codex login, then retry scotty sync.",
    );
  const token = decoded.success.tokens;
  const jwtExpiry = yield* jwtExpiryMillis(token.access_token);
  const expires = token.expires ?? decoded.success.expires ?? jwtExpiry;
  if (expires === undefined || !Number.isFinite(expires))
    return yield* authFailure(
      "Codex auth.json has no usable token expiry",
      "Refresh Codex login and retry scotty sync.",
    );
  const providerStore = {
    "openai-codex": {
      type: "oauth" as const,
      refresh: token.refresh_token,
      access: token.access_token,
      expires,
      ...(token.account_id === undefined ? {} : { accountId: token.account_id }),
      ...(token.id_token === undefined ? {} : { idToken: token.id_token }),
    },
  };
  return {
    path: authPath,
    providerStore,
    sourceDigest: yield* Effect.tryPromise({
      try: () => digestPiAuthProviders(providerStore),
      catch: () => authFailure("Could not digest Codex auth.json", "Retry scotty sync."),
    }),
    providers: piProviderMetadata(providerStore),
  };
});

const resolveTemplate = (
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  let output = "";
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character !== "$") {
      output += character;
      index += 1;
      continue;
    }
    const next = value[index + 1];
    if (next === "$" || next === "!") {
      output += next;
      index += 2;
      continue;
    }
    const braced = next === "{";
    const remainder = value.slice(index + (braced ? 2 : 1));
    const match = braced
      ? /^([A-Za-z_][A-Za-z0-9_]*)\}/u.exec(remainder)
      : /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(remainder);
    if (!match) {
      output += "$";
      index += 1;
      continue;
    }
    const replacement = environment[match[1]];
    if (replacement === undefined || replacement.length === 0) return undefined;
    output += replacement;
    index += match[0].length + (braced ? 2 : 1);
  }
  return output;
};

const resolveApiKey = Effect.fnUntraced(function* (
  providerId: string,
  key: string | undefined,
  providerEnvironment: Readonly<Record<string, string>> | undefined,
) {
  if (key === undefined)
    return yield* authFailure(
      `Pi API-key credential ${providerId} has no stored key`,
      "Log in to that provider locally or remove it from Pi auth.json before syncing.",
    );
  const runtime = yield* CliRuntime;
  if (key.startsWith("!")) {
    const processRunner = yield* ProcessRunner;
    const result = yield* processRunner.run(["/bin/sh", "-lc", key.slice(1)]);
    const resolved = result.stdout.trim();
    if (result.exitCode !== 0 || resolved.length === 0)
      return yield* authFailure(
        `Pi API-key command failed for ${providerId}`,
        "Fix the command in Pi auth.json and retry scotty sync.",
      );
    return resolved;
  }
  const resolved = resolveTemplate(key, { ...runtime.env, ...providerEnvironment });
  if (resolved === undefined || resolved.length === 0)
    return yield* authFailure(
      `Pi API-key reference could not be resolved for ${providerId}`,
      "Set the referenced environment variables and retry scotty sync.",
    );
  return resolved;
});

export const readLocalPiAuth = Effect.fnUntraced(function* (path?: string) {
  const runtime = yield* CliRuntime;
  const fileSystem = yield* FileSystem;
  const authPath = path ?? join(runtime.home, ".pi", "agent", "auth.json");
  const raw = yield* fileSystem
    .readPrivateText(authPath)
    .pipe(
      Effect.mapError((error) =>
        error.reason === "permissions" || error.reason === "not_file" || error.reason === "symlink"
          ? authFailure(
              "Pi auth.json must be a private regular file",
              `Use a non-symlinked mode-0600 file at ${authPath}.`,
            )
          : authFailure(
              `Could not read ${authPath}`,
              "Check that the Pi auth file exists and is readable only by your user.",
            ),
      ),
    );
  const decoded = parsePiAuthJsonOption(raw);
  if (Option.isNone(decoded) || Object.keys(decoded.value).length === 0)
    return yield* authFailure(
      "Pi auth.json is missing or malformed",
      "Run Pi login, then retry scotty sync.",
    );

  const normalized: Record<string, PiCredential> = {};
  const openAi = decoded.value.openai;
  if (openAi?.type === "api_key")
    normalized.openai = {
      type: "api_key",
      key: yield* resolveApiKey("openai", openAi.key, openAi.env),
    };
  const codex = decoded.value["openai-codex"];
  if (codex?.type === "oauth")
    normalized["openai-codex"] = {
      ...codex,
      type: "oauth",
      refresh: codex.refresh,
      access: codex.access,
      expires: codex.expires,
      ...(codex.accountId === undefined ? {} : { accountId: codex.accountId }),
    };
  if (Object.keys(normalized).length === 0)
    return yield* authFailure(
      "Pi auth.json has no credential supported by Scotty",
      "Sign in to OpenAI or OpenAI Codex with Pi, then retry scotty sync.",
    );
  return {
    path: authPath,
    providerStore: normalized,
    sourceDigest: yield* Effect.tryPromise({
      try: () => digestPiAuthProviders(normalized),
      catch: () =>
        authFailure(
          "Could not digest Pi auth.json",
          "Retry scotty sync. If the problem continues, update your local runtime.",
        ),
    }),
    providers: piProviderMetadata(normalized),
  };
});
