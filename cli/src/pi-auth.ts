import { join } from "node:path";
import {
  parsePiAuthJsonOption,
  piProviderMetadata,
  type PiCredential,
} from "../../protocol/pi-auth";
import { Effect, Option } from "effect";
import { CliError, EXIT } from "./core";
import { sha256Hex } from "./dependencies";
import { CliRuntime, FileSystem, ProcessRunner } from "./services";

const authFailure = (message: string, hint: string): CliError =>
  new CliError("invalid_pi_auth", message, hint, EXIT.USAGE);

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
      "Run Pi login, then retry scotty auth sync.",
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
      type: "oauth",
      refresh: codex.refresh,
      access: codex.access,
      expires: codex.expires,
      ...(codex.accountId === undefined ? {} : { accountId: codex.accountId }),
    };
  if (Object.keys(normalized).length === 0)
    return yield* authFailure(
      "Pi auth.json has no credential supported by Scotty",
      "Sign in to OpenAI or OpenAI Codex with Pi, then retry scotty auth sync.",
    );
  const json = JSON.stringify(normalized);
  return {
    path: authPath,
    json,
    sourceDigest: yield* sha256Hex(json),
    providers: piProviderMetadata(normalized),
  };
});
