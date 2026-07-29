import { join } from "node:path";
import {
  parsePiAuthJsonOption,
  piProviderMetadata,
  type PiCredential,
} from "../../protocol/pi-auth";
import { Effect, Option } from "effect";
import { CliError, EXIT } from "./core";
import { sha256Hex } from "./dependencies";
import { decodeCloudflareApiEnvelope, decodeJsonValue } from "./schemas";
import { CliRuntime, FileSystem, HttpTransport, ProcessRunner } from "./services";
import { readLimited } from "./transport";

const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com/client/v4";
const DEFAULT_WORKER_NAME = "scotty-worker";

const authFailure = (message: string, hint: string): CliError =>
  new CliError("invalid_pi_auth", message, hint, EXIT.USAGE);

const syncFailure = (message: string, hint: string): CliError =>
  new CliError("auth_sync_failed", message, hint, EXIT.GENERIC);

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
        "Fix the command in Pi auth.json and retry scotty auth sync.",
      );
    return resolved;
  }
  const resolved = resolveTemplate(key, { ...runtime.env, ...providerEnvironment });
  if (resolved === undefined || resolved.length === 0)
    return yield* authFailure(
      `Pi API-key reference could not be resolved for ${providerId}`,
      "Set the referenced environment variables and retry scotty auth sync.",
    );
  return resolved;
});

export const readLocalPiAuth = Effect.fnUntraced(function* (path?: string) {
  const runtime = yield* CliRuntime;
  const fileSystem = yield* FileSystem;
  const authPath = path ?? join(runtime.home, ".pi", "agent", "auth.json");
  const source = yield* fileSystem
    .stat(authPath)
    .pipe(
      Effect.mapError(() =>
        authFailure(
          `Could not inspect ${authPath}`,
          "Check that the Pi auth file exists and is readable only by your user.",
        ),
      ),
    );
  if (!source.isFile() || (source.mode & 0o077) !== 0)
    return yield* authFailure(
      "Pi auth.json must be a private regular file",
      `Run chmod 600 ${authPath} and retry scotty auth sync.`,
    );
  const raw = yield* fileSystem
    .readLockedText(authPath)
    .pipe(
      Effect.mapError(() =>
        authFailure(
          `Could not lock and read ${authPath}`,
          "Check that the Pi auth file exists and is readable only by your user.",
        ),
      ),
    );
  const decoded = parsePiAuthJsonOption(raw);
  if (Option.isNone(decoded) || Object.keys(decoded.value).length === 0)
    return yield* authFailure(
      "Pi auth.json is missing or malformed",
      "Run Pi login, then retry scotty auth sync.",
    );

  const normalized: Record<string, PiCredential> = {};
  for (const [providerId, credential] of Object.entries(decoded.value)) {
    normalized[providerId] =
      credential.type === "oauth"
        ? credential
        : {
            ...credential,
            key: yield* resolveApiKey(providerId, credential.key, credential.env),
          };
  }
  const json = JSON.stringify(normalized);
  return {
    path: authPath,
    json,
    sourceDigest: yield* sha256Hex(json),
    providers: piProviderMetadata(normalized),
  };
});

export const uploadPiAuthSecret = Effect.fnUntraced(function* (json: string) {
  const runtime = yield* CliRuntime;
  const transport = yield* HttpTransport;
  const apiToken = runtime.env.CLOUDFLARE_API_TOKEN;
  const accountId = runtime.env.CLOUDFLARE_ACCOUNT_ID;
  const workerName = runtime.env.SCOTTY_CLOUDFLARE_WORKER_NAME ?? DEFAULT_WORKER_NAME;
  if (!apiToken)
    return yield* authFailure(
      "CLOUDFLARE_API_TOKEN is required",
      "Export a token that can edit scotty-worker secrets.",
    );
  if (!accountId || !/^[0-9a-f]{32}$/u.test(accountId))
    return yield* authFailure(
      "CLOUDFLARE_ACCOUNT_ID is required",
      "Export the 32-character Cloudflare account ID.",
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(workerName))
    return yield* authFailure(
      "SCOTTY_CLOUDFLARE_WORKER_NAME is invalid",
      "Use the deployed Worker name.",
    );

  const response = yield* transport.fetch(
    `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/scripts/${workerName}/secrets`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "PI_AUTH_JSON", text: json, type: "secret_text" }),
    },
  );
  const bytes = yield* readLimited(response);
  const jsonResponse = decodeJsonValue(new TextDecoder().decode(bytes));
  const envelope = Option.isSome(jsonResponse)
    ? decodeCloudflareApiEnvelope(jsonResponse.value)
    : Option.none();
  if (!response.ok || Option.isNone(envelope) || !envelope.value.success)
    return yield* syncFailure(
      "Cloudflare rejected PI_AUTH_JSON",
      "Check the API token permissions, account ID, Worker name, and deployed Worker version.",
    );
  return { accountId, workerName };
});
