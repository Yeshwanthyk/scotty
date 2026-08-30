import { Data, Effect, Result, Schema } from "effect";
import {
  sandboxBundleItemDigestMaterial,
  sandboxBundleItemFilePath,
  sandboxBundleItemRoot,
} from "../../../protocol/sandbox-bundle";
import { sha256BytesHex } from "../shared/digest";
import { SandboxBundleManifestSchema, type SandboxBundleManifest } from "./config-contracts";

export const SANDBOX_MAX_FILE_BYTES = 8_388_608;
export const SANDBOX_MAX_BUNDLE_FILES = 8_192;
export const SANDBOX_MAX_PATH_BYTES = 240;
export const SANDBOX_MAX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;

export class SandboxArchiveInvalid extends Data.TaggedError("SandboxArchiveInvalid")<{
  readonly message: string;
}> {}

export interface ParsedTarMember {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly modeClass: "regular" | "executable";
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
const isUnsupportedTarMemberType = (type: number): boolean =>
  type === HARDLINK_TYPE ||
  type === SYMLINK_TYPE ||
  (type !== 0 && type !== FILE_TYPE && type !== DIRECTORY_TYPE);

type ParsedTarMemberResult = {
  readonly member: ParsedTarMember;
  readonly fileCount: number;
  readonly nextOffset: number;
};

const parseTarMember = (
  bytes: Uint8Array,
  offset: number,
  seen: Set<string>,
  fileCount: number,
): Result.Result<ParsedTarMemberResult, SandboxArchiveInvalid> => {
  const header = bytes.subarray(offset, offset + BLOCK);
  const name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  const sizeText = field(header, 124, 12).trim();
  const size = Number.parseInt(sizeText.padEnd(1, "0"), 8);
  const checksumText = field(header, 148, 8).trim();
  const expectedChecksum = Number.parseInt(checksumText.padEnd(1, "0"), 8);
  if (!Number.isFinite(expectedChecksum) || expectedChecksum !== headerChecksum(header))
    return Result.fail(sandboxArchiveInvalid("Sandbox archive checksum is invalid"));
  const mode = Number.parseInt(field(header, 100, 8).trim().padEnd(1, "0"), 8);
  if (!Number.isFinite(mode) || mode < 0 || mode > 0o7777)
    return Result.fail(sandboxArchiveInvalid("Sandbox archive contains an unsupported mode"));
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
  if (isUnsupportedTarMemberType(type))
    return Result.fail(
      sandboxArchiveInvalid("Sandbox archive contains an unsupported member type"),
    );
  const nextFileCount = fileCount + Number(type !== DIRECTORY_TYPE);
  if (nextFileCount > SANDBOX_MAX_BUNDLE_FILES + 1)
    return Result.fail(sandboxArchiveInvalid("Sandbox archive exceeds the file-count limit"));
  const isDirectory = type === DIRECTORY_TYPE;
  return Result.succeed({
    member: {
      path,
      type: isDirectory ? "directory" : "file",
      modeClass: !isDirectory && (mode & 0o111) !== 0 ? "executable" : "regular",
      bytes: isDirectory ? new Uint8Array() : bytes.slice(offset + BLOCK, offset + BLOCK + size),
    },
    fileCount: nextFileCount,
    nextOffset: offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK,
  });
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
    const parsed = parseTarMember(bytes, offset, seen, fileCount);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    members.push(parsed.success.member);
    fileCount = parsed.success.fileCount;
    offset = parsed.success.nextOffset;
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
        const stream = new Blob([Uint8Array.from(bytes)])
          .stream()
          .pipeThrough(new DecompressionStream("gzip"));
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

const filesFromMembers = (members: ReadonlyArray<ParsedTarMember>): Map<string, ParsedTarMember> =>
  new Map(members.map((member) => [member.path, member]));

type ExpectedSandboxFile = {
  readonly size: number;
  readonly digest: string;
  readonly modeClass?: "regular" | "executable";
};

const parentDirectories = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/");
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index += 1)
    directories.push(parts.slice(0, index).join("/"));
  return directories;
};

type SandboxBundleItem = SandboxBundleManifest["items"][number];

type ManifestValidationState = {
  readonly expected: Map<string, ExpectedSandboxFile>;
  readonly directories: Set<string>;
  readonly seenItems: Set<string>;
};

const collectExpectedItem = Effect.fnUntraced(function* (
  item: SandboxBundleItem,
  members: ReadonlyMap<string, ParsedTarMember>,
  state: ManifestValidationState,
) {
  const itemKey = `${item.kind}\0${item.name}`;
  if (state.seenItems.has(itemKey))
    return yield* Effect.fail(
      sandboxArchiveInvalid("Sandbox archive manifest contains duplicate bundle items"),
    );
  state.seenItems.add(itemKey);
  if (["skill", "package"].includes(item.kind) && item.shape !== "directory")
    return yield* Effect.fail(
      sandboxArchiveInvalid("Sandbox archive item shape does not match its kind"),
    );
  const itemRoot = `${sandboxBundleItemRoot(item.kind)}/${item.name}`;
  const itemMember = members.get(itemRoot);
  if (item.shape === "file") {
    if (item.files.length !== 1 || item.files[0]?.path !== item.name)
      return yield* Effect.fail(
        sandboxArchiveInvalid("Sandbox archive manifest file item does not match its name"),
      );
    if (itemMember?.type !== "file")
      return yield* Effect.fail(
        sandboxArchiveInvalid("Sandbox archive file item is not materialized at its name"),
      );
  } else {
    state.directories.add(itemRoot);
    for (const parent of parentDirectories(itemRoot)) state.directories.add(parent);
    if (itemMember?.type === "file" || (item.files.length === 0 && itemMember === undefined))
      return yield* Effect.fail(
        sandboxArchiveInvalid("Sandbox archive directory item is not materialized at its name"),
      );
  }
  const itemDigest = yield* Effect.tryPromise({
    try: () =>
      sha256BytesHex(new TextEncoder().encode(sandboxBundleItemDigestMaterial(item.files))),
    catch: () => sandboxArchiveInvalid("Sandbox archive item digest computation failed"),
  });
  if (itemDigest !== item.digest)
    return yield* Effect.fail(
      sandboxArchiveInvalid("Sandbox archive item digest does not match its manifest files"),
    );
  for (const file of item.files) {
    if (!isSafeBundlePath(file.path))
      return yield* Effect.fail(
        sandboxArchiveInvalid("Sandbox archive manifest contains an unsafe file path"),
      );
    const archivePath = sandboxBundleItemFilePath(item, file.path);
    if (state.expected.has(archivePath))
      return yield* Effect.fail(
        sandboxArchiveInvalid("Sandbox archive manifest contains duplicate file paths"),
      );
    state.expected.set(archivePath, {
      size: file.size,
      digest: file.digest,
      modeClass: file.modeClass,
    });
    for (const parent of parentDirectories(archivePath)) state.directories.add(parent);
  }
});

const validateManifestMember = Effect.fnUntraced(function* (
  path: string,
  member: ParsedTarMember,
  directories: ReadonlySet<string>,
  members: ReadonlyMap<string, ParsedTarMember>,
) {
  if (path === "manifest.json") return;
  if (member.type === "directory" && !directories.has(path))
    return yield* Effect.fail(
      sandboxArchiveInvalid("Sandbox archive contains an unlisted directory"),
    );
  if (member.type === "file") {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      if (members.get(parts.slice(0, index).join("/"))?.type === "file")
        return yield* Effect.fail(
          sandboxArchiveInvalid("Sandbox archive file shape is incoherent"),
        );
  }
});

const validateManifest = Effect.fnUntraced(function* (
  manifest: SandboxBundleManifest,
  members: ReadonlyMap<string, ParsedTarMember>,
) {
  const state: ManifestValidationState = {
    expected: new Map<string, ExpectedSandboxFile>(),
    directories: new Set<string>(),
    seenItems: new Set<string>(),
  };
  for (const item of manifest.items) yield* collectExpectedItem(item, members, state);
  for (const [path, member] of members)
    yield* validateManifestMember(path, member, state.directories, members);
  return { files: state.expected };
});

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
    const manifestMember = files.get("manifest.json");
    if (manifestMember === undefined || manifestMember.type !== "file")
      return yield* Effect.fail(sandboxArchiveInvalid("Sandbox archive is missing manifest.json"));
    const manifestText = decoder.decode(manifestMember.bytes);
    const decoded = decodeBundleManifestText(manifestText);
    if (Result.isFailure(decoded))
      return yield* Effect.fail(sandboxArchiveInvalid("Sandbox archive manifest is invalid"));
    const manifest = decoded.success;
    const expected = (yield* validateManifest(manifest, files)).files;
    for (const [path, member] of files) {
      if (path === "manifest.json" || member.type !== "file") continue;
      const record = expected.get(path);
      if (record === undefined)
        return yield* Effect.fail(
          sandboxArchiveInvalid("Sandbox archive contains a file missing from the manifest"),
        );
      const contentDigest = yield* Effect.tryPromise({
        try: () => sha256BytesHex(member.bytes),
        catch: () => sandboxArchiveInvalid("Sandbox archive file digest computation failed"),
      });
      if (
        member.bytes.byteLength !== record.size ||
        contentDigest !== record.digest ||
        (record.modeClass !== undefined && member.modeClass !== record.modeClass)
      )
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
