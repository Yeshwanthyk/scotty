import { Data, Effect, Result, Schema } from "effect";
import { sha256BytesHex } from "./digest";
import {
  SandboxBundleManifestSchema,
  type SandboxBundleManifest,
} from "./sandbox-config-contracts";

export const SANDBOX_MAX_FILE_BYTES = 1_048_576;
export const SANDBOX_MAX_BUNDLE_FILES = 8_192;
export const SANDBOX_MAX_PATH_BYTES = 240;
export const SANDBOX_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export class SandboxArchiveInvalid extends Data.TaggedError("SandboxArchiveInvalid")<{
  readonly message: string;
}> {}

export interface ParsedTarMember {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly bytes: Uint8Array;
}

const BLOCK = 512;
const FILE_TYPE = 48;
const DIRECTORY_TYPE = 53;
const HARDLINK_TYPE = 49;
const SYMLINK_TYPE = 50;

const decoder = new TextDecoder();

const sandboxArchiveInvalid = (message: string): SandboxArchiveInvalid =>
  new SandboxArchiveInvalid({ message });

export const isSafeBundlePath = (path: string): boolean => {
  if (path.length === 0 || path.length > SANDBOX_MAX_PATH_BYTES) return false;
  if (path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
};

const field = (header: Uint8Array, start: number, length: number): string => {
  const value = decoder.decode(header.subarray(start, start + length));
  const terminator = value.indexOf("\0");
  return terminator === -1 ? value : value.slice(0, terminator);
};

const headerChecksum = (header: Uint8Array): number => {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1)
    sum += index >= 148 && index < 156 ? 32 : header[index];
  return sum;
};

export const parseSandboxTar = (
  bytes: Uint8Array,
): Result.Result<ReadonlyArray<ParsedTarMember>, SandboxArchiveInvalid> => {
  const members: ParsedTarMember[] = [];
  const seen = new Set<string>();
  let fileCount = 0;
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    const sizeText = field(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const checksumText = field(header, 148, 8).trim();
    const expectedChecksum = Number.parseInt(checksumText || "0", 8);
    if (!Number.isFinite(expectedChecksum) || expectedChecksum !== headerChecksum(header))
      return Result.fail(sandboxArchiveInvalid("Sandbox archive checksum is invalid"));
    if (!Number.isFinite(size) || size < 0)
      return Result.fail(sandboxArchiveInvalid("Sandbox archive is malformed"));
    if (size > SANDBOX_MAX_FILE_BYTES)
      return Result.fail(
        sandboxArchiveInvalid("Sandbox archive file exceeds the per-file size limit"),
      );
    if (offset + BLOCK + size > bytes.length)
      return Result.fail(sandboxArchiveInvalid("Sandbox archive is truncated"));
    if (!isSafeBundlePath(path) || path.length > SANDBOX_MAX_PATH_BYTES)
      return Result.fail(sandboxArchiveInvalid("Sandbox archive contains an unsafe path"));
    if (seen.has(path))
      return Result.fail(sandboxArchiveInvalid("Sandbox archive contains duplicate members"));
    seen.add(path);
    const type = header[156];
    if (
      type === HARDLINK_TYPE ||
      type === SYMLINK_TYPE ||
      (type !== 0 && type !== FILE_TYPE && type !== DIRECTORY_TYPE)
    )
      return Result.fail(
        sandboxArchiveInvalid("Sandbox archive contains an unsupported member type"),
      );
    const isDirectory = type === DIRECTORY_TYPE;
    if (!isDirectory) {
      fileCount += 1;
      if (fileCount > SANDBOX_MAX_BUNDLE_FILES + 1)
        return Result.fail(sandboxArchiveInvalid("Sandbox archive exceeds the file-count limit"));
    }
    members.push({
      path,
      type: isDirectory ? "directory" : "file",
      bytes: isDirectory ? new Uint8Array() : bytes.slice(offset + BLOCK, offset + BLOCK + size),
    });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return Result.succeed(members);
};

const readBoundedUncompressed = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array | undefined> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > SANDBOX_MAX_UNCOMPRESSED_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const gunzipSandboxArchive = (
  bytes: Uint8Array,
): Effect.Effect<Uint8Array, SandboxArchiveInvalid> =>
  Effect.gen(function* () {
    const uncompressed = yield* Effect.tryPromise({
      try: async () => {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        return await readBoundedUncompressed(stream);
      },
      catch: () => sandboxArchiveInvalid("Sandbox archive is not valid gzip"),
    });
    if (uncompressed === undefined)
      return yield* Effect.fail(
        sandboxArchiveInvalid("Sandbox archive exceeds the uncompressed size limit"),
      );
    return uncompressed;
  });

const decodeBundleManifestText = Schema.decodeUnknownResult(
  Schema.fromJsonString(SandboxBundleManifestSchema),
  { onExcessProperty: "error" },
);

const filesFromMembers = (members: ReadonlyArray<ParsedTarMember>): Map<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>();
  for (const member of members) {
    if (member.type === "file") files.set(member.path, member.bytes);
  }
  return files;
};

export interface ValidatedSandboxArchive {
  readonly digest: string;
  readonly manifest: SandboxBundleManifest;
  readonly manifestJson: string;
  readonly members: ReadonlyArray<ParsedTarMember>;
}

export const validateSandboxArchive = (
  gzipBytes: Uint8Array,
  expectedDigest: string,
): Effect.Effect<ValidatedSandboxArchive, SandboxArchiveInvalid> =>
  Effect.gen(function* () {
    const tar = yield* gunzipSandboxArchive(gzipBytes);
    const digest = yield* Effect.tryPromise({
      try: () => sha256BytesHex(tar),
      catch: () => sandboxArchiveInvalid("Sandbox archive digest computation failed"),
    });
    if (digest !== expectedDigest)
      return yield* Effect.fail(
        sandboxArchiveInvalid("Sandbox archive digest does not match the path digest"),
      );
    const parsed = parseSandboxTar(tar);
    if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
    const files = filesFromMembers(parsed.success);
    const manifestBytes = files.get("manifest.json");
    if (manifestBytes === undefined)
      return yield* Effect.fail(sandboxArchiveInvalid("Sandbox archive is missing manifest.json"));
    const manifestText = decoder.decode(manifestBytes);
    const decoded = decodeBundleManifestText(manifestText);
    if (Result.isFailure(decoded))
      return yield* Effect.fail(sandboxArchiveInvalid("Sandbox archive manifest is invalid"));
    const manifest = decoded.success;
    const expected = new Map<string, { readonly size: number; readonly digest: string }>();
    for (const skill of manifest.skills) {
      for (const file of skill.files)
        expected.set(`skills/${skill.name}/${file.path}`, { size: file.size, digest: file.digest });
    }
    for (const item of manifest.piPackages) {
      for (const file of item.files)
        expected.set(`pi-packages/${item.name}/${file.path}`, {
          size: file.size,
          digest: file.digest,
        });
    }
    for (const [path, content] of files) {
      if (path === "manifest.json") continue;
      const record = expected.get(path);
      if (record === undefined)
        return yield* Effect.fail(
          sandboxArchiveInvalid("Sandbox archive contains a file missing from the manifest"),
        );
      const contentDigest = yield* Effect.tryPromise({
        try: () => sha256BytesHex(content),
        catch: () => sandboxArchiveInvalid("Sandbox archive file digest computation failed"),
      });
      if (content.byteLength !== record.size || contentDigest !== record.digest)
        return yield* Effect.fail(
          sandboxArchiveInvalid("Sandbox archive file digest does not match the manifest"),
        );
      expected.delete(path);
    }
    if (expected.size > 0)
      return yield* Effect.fail(
        sandboxArchiveInvalid("Sandbox archive manifest lists a file that is not present"),
      );
    return { digest, manifest, manifestJson: manifestText, members: parsed.success };
  });
