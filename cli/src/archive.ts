import { basename, join, resolve } from "node:path";
import { Effect, Option, Result } from "effect";
import { CliError, EXIT, type GlobalOptions } from "./core";
import { credentials, secureWrite } from "./dependencies";
import { decodeDownMetadata } from "./schemas";
import { CliRuntime, ProcessRunner } from "./services";
import { invalidResponse, optionalString, redact, rolloutThreadId } from "./pure";
import { apiRequest, decodeJson } from "./transport";

export function parseTar(bytes: Uint8Array): Result.Result<Map<string, Uint8Array>, CliError> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => {
      const value = decoder.decode(header.subarray(start, start + length));
      const terminator = value.indexOf("\0");
      return terminator === -1 ? value : value.slice(0, terminator);
    };
    const name = field(0, 100);
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = field(124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const checksumText = field(148, 8).trim();
    const expectedChecksum = Number.parseInt(checksumText || "0", 8);
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index++)
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    if (!Number.isFinite(expectedChecksum) || expectedChecksum !== actualChecksum)
      return Result.fail(
        new CliError(
          "invalid_archive",
          "Beam-down archive checksum is invalid",
          "Retry down or inspect the Worker.",
          EXIT.GENERIC,
        ),
      );
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > bytes.length)
      return Result.fail(
        new CliError(
          "invalid_archive",
          "Beam-down archive is malformed",
          "Retry down or inspect the Worker.",
          EXIT.GENERIC,
        ),
      );
    if (!safeRelativePath(path))
      return Result.fail(
        new CliError(
          "invalid_archive",
          "Beam-down archive contains an unsafe path",
          "Inspect the Worker before retrying.",
          EXIT.GENERIC,
        ),
      );
    const type = header[156];
    if (type === 0 || type === 48) {
      if (files.has(path))
        return Result.fail(
          new CliError(
            "invalid_archive",
            "Beam-down archive contains duplicate entries",
            "Inspect the Worker before retrying.",
            EXIT.GENERIC,
          ),
        );
      files.set(path, bytes.slice(offset + 512, offset + 512 + size));
      if (files.size > 2)
        return Result.fail(
          new CliError(
            "invalid_archive",
            "Beam-down archive contains unexpected files",
            "Inspect the Worker before retrying.",
            EXIT.GENERIC,
          ),
        );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return Result.succeed(files);
}

export function safeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.includes("\0") &&
    !normalized.split("/").includes("..")
  );
}

export function validGitRef(branch: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/") &&
    !branch.includes("//")
  );
}

export function rolloutDestination(
  home: string,
  archivePath: string,
): Result.Result<string, CliError> {
  const file = basename(archivePath);
  if (!file.endsWith(".jsonl") || file === ".jsonl")
    return Result.fail(
      new CliError(
        "invalid_rollout",
        "Beam-down rollout filename is invalid",
        "The branch was fetched, but the rollout was not installed.",
        EXIT.GENERIC,
      ),
    );
  const normalized = archivePath.replace(/\\/g, "/");
  const nested = normalized.match(/(?:^|\/)sessions\/(\d{4})\/(\d{2})\/(\d{2})\/[^/]+$/);
  const dated = file.match(/(?:rollout-)?(\d{4})-(\d{2})-(\d{2})T/);
  const parts = nested?.slice(1, 4) ?? dated?.slice(1, 4);
  if (!parts)
    return Result.fail(
      new CliError(
        "invalid_rollout",
        "Beam-down rollout has no recognizable date",
        "The branch was fetched, but the rollout was not installed.",
        EXIT.GENERIC,
      ),
    );
  return Result.succeed(join(home, ".codex", "sessions", parts[0], parts[1], parts[2], file));
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export const handleDown = Effect.fnUntraced(function* (id: string, options: GlobalOptions) {
  const runtime = yield* CliRuntime;
  const processRunner = yield* ProcessRunner;
  const auth = yield* credentials(options);
  const { response, bytes } = yield* apiRequest(
    auth,
    `/api/sessions/${encodeURIComponent(id)}/down`,
  );
  const contentType = response.headers.get("content-type") || "";
  let metadataValue: unknown;
  let rollout: { path: string; bytes: Uint8Array } | undefined;
  if (contentType.includes("json")) {
    metadataValue = yield* decodeJson(bytes);
  } else {
    const files = yield* Effect.fromResult(parseTar(bytes));
    const metadataBytes = files.get("metadata.json");
    if (!metadataBytes)
      return yield* new CliError(
        "invalid_archive",
        "Beam-down archive has no canonical metadata.json",
        "Retry down or inspect the Worker.",
        EXIT.GENERIC,
      );
    metadataValue = yield* decodeJson(metadataBytes);
    const rolloutEntries = [...files.entries()].filter(([path]) => path.endsWith(".jsonl"));
    if (rolloutEntries.length > 1)
      return yield* new CliError(
        "invalid_archive",
        "Beam-down archive contains multiple rollouts",
        "Inspect the Worker before retrying.",
        EXIT.GENERIC,
      );
    const rolloutEntry = rolloutEntries[0];
    if (rolloutEntry) rollout = { path: rolloutEntry[0], bytes: rolloutEntry[1] };
  }
  const decodedMetadata = decodeDownMetadata(metadataValue);
  if (Option.isNone(decodedMetadata)) return yield* invalidResponse();
  const metadata = decodedMetadata.value;
  if (contentType.includes("json")) {
    const encoded = optionalString(metadata.rolloutBase64);
    const name = optionalString(metadata.rolloutName);
    if (encoded && name) rollout = { path: name, bytes: Uint8Array.fromBase64(encoded) };
  }
  const declaredRolloutPath = optionalString(metadata.rolloutPath);
  const declaredRolloutFile = optionalString(metadata.rolloutFile);
  for (const declared of [declaredRolloutPath, declaredRolloutFile]) {
    if (declared && !safeRelativePath(declared))
      return yield* new CliError(
        "invalid_archive",
        "Beam-down metadata contains an unsafe rollout path",
        "Inspect the Worker before retrying.",
        EXIT.GENERIC,
      );
    if (declared && rollout && basename(declared) !== basename(rollout.path))
      return yield* new CliError(
        "invalid_archive",
        "Beam-down metadata does not match the rollout file",
        "Retry down or inspect the Worker.",
        EXIT.GENERIC,
      );
  }
  if (rollout && declaredRolloutPath) rollout.path = declaredRolloutPath;
  const { branch, sha } = metadata;
  if (!validGitRef(branch))
    return yield* new CliError(
      "invalid_response",
      "Server returned an unsafe branch name",
      "Inspect the Worker before retrying.",
      EXIT.GENERIC,
    );
  if (!/^[0-9a-f]{40}$/i.test(sha))
    return yield* new CliError(
      "invalid_response",
      "Server returned an invalid commit SHA",
      "Inspect the Worker before retrying.",
      EXIT.GENERIC,
    );
  const fetched = yield* processRunner.run(["git", "fetch", "origin", branch]);
  if (fetched.exitCode !== 0)
    return yield* new CliError(
      "git_fetch_failed",
      "Could not fetch the session branch",
      redact(fetched.stderr.trim() || `Run git fetch origin ${branch} manually.`, [auth.token]),
      EXIT.GENERIC,
    );
  const resolved = yield* processRunner.run(["git", "rev-parse", "FETCH_HEAD"]);
  if (resolved.exitCode !== 0 || resolved.stdout.trim().toLowerCase() !== sha.toLowerCase()) {
    return yield* new CliError(
      "sha_mismatch",
      "Fetched branch does not match the beam-down manifest",
      "Do not install the rollout; inspect the remote branch and Worker.",
      EXIT.GENERIC,
    );
  }

  let rolloutPath: string | null = null;
  let resumeCmd: string | null = null;
  if (rollout) {
    const installed = yield* Effect.result(
      Effect.gen(function* () {
        rolloutPath = yield* Effect.fromResult(rolloutDestination(runtime.home, rollout.path));
        yield* secureWrite(rolloutPath, new TextDecoder().decode(rollout.bytes));
        const threadId = optionalString(metadata.codexThreadId) ?? rolloutThreadId(rolloutPath);
        if (threadId)
          resumeCmd = `codex resume ${shellQuote(threadId)} -C ${shellQuote(resolve(runtime.cwd))}`;
      }),
    );
    if (Result.isFailure(installed)) {
      if (installed.failure.code !== "invalid_rollout") return yield* installed.failure;
      runtime.stderr(`warning: ${installed.failure.message}; branch ${branch} was fetched\n`);
    }
  }
  return { branch, sha, rolloutPath, resumeCmd };
});
