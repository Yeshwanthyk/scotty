import { gunzipSync, gzipSync } from "node:zlib";
import { sandboxBundleItemFilePath, sandboxBundleItemRoot } from "../../protocol/sandbox-bundle";
import { Result } from "effect";
import {
  SANDBOX_MAX_FILE_BYTES,
  SANDBOX_MAX_PATH_BYTES,
  compareUtf8,
  decodeBundleManifestText,
  isSafeBundlePath,
  itemContentDigest,
  sandboxArchiveInvalid,
  sha256Bytes,
  type SandboxBundleItemManifest,
  type SandboxBundleManifest,
  type SandboxFileModeClass,
} from "./sandbox-bundle";

export interface TarMember {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly modeClass: SandboxFileModeClass;
  readonly bytes: Uint8Array;
}

const BLOCK = 512;
const FILE_TYPE = 48;
const DIRECTORY_TYPE = 53;
const HARDLINK_TYPE = 49;
const SYMLINK_TYPE = 50;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const writeBytes = (header: Uint8Array, offset: number, value: string, length: number): void => {
  const bytes = encoder.encode(value);
  header.set(bytes.subarray(0, Math.min(bytes.length, length)), offset);
};

const writeOctal = (header: Uint8Array, offset: number, length: number, value: number): void => {
  writeBytes(header, offset, value.toString(8).padStart(length - 1, "0"), length - 1);
};

const splitTarName = (
  path: string,
): { readonly name: string; readonly prefix: string } | undefined => {
  if (path.length <= 100) return { name: path, prefix: "" };
  for (let index = path.length - 1; index >= 0; index--) {
    if (path[index] !== "/") continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return { name, prefix };
  }
  return undefined;
};

const headerChecksum = (header: Uint8Array): number => {
  let sum = 0;
  for (let index = 0; index < header.length; index++)
    sum += index >= 148 && index < 156 ? 32 : header[index];
  return sum;
};

const fileMode = (member: TarMember): number => {
  if (member.type === "directory") return 0o755;
  return member.modeClass === "executable" ? 0o755 : 0o644;
};

export const encodeUstarArchive = (members: ReadonlyArray<TarMember>): Uint8Array => {
  const sorted = [...members].sort((left, right) => compareUtf8(left.path, right.path));
  const chunks: Uint8Array[] = [];
  for (const member of sorted) {
    const split = splitTarName(member.path);
    const header = new Uint8Array(BLOCK);
    if (split === undefined) writeBytes(header, 0, member.path, 100);
    else {
      writeBytes(header, 0, split.name, 100);
      writeBytes(header, 345, split.prefix, 155);
    }
    writeOctal(header, 100, 8, fileMode(member));
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, member.type === "file" ? member.bytes.byteLength : 0);
    writeOctal(header, 136, 12, 0);
    header[156] = member.type === "directory" ? DIRECTORY_TYPE : FILE_TYPE;
    writeBytes(header, 257, "ustar", 6);
    writeBytes(header, 263, "00", 2);
    const checksum = headerChecksum(header);
    writeBytes(header, 148, checksum.toString(8).padStart(6, "0"), 6);
    header[154] = 0;
    header[155] = 32;
    chunks.push(header);
    if (member.type === "file" && member.bytes.byteLength > 0) {
      chunks.push(member.bytes);
      const padding = (BLOCK - (member.bytes.byteLength % BLOCK)) % BLOCK;
      if (padding > 0) chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return tar;
};

export const gzipDeterministic = (bytes: Uint8Array): Uint8Array => {
  const gzipped = gzipSync(bytes, { level: 9 });
  gzipped[4] = 0;
  gzipped[5] = 0;
  gzipped[6] = 0;
  gzipped[7] = 0;
  gzipped[9] = 255;
  return new Uint8Array(gzipped);
};

export const createDeterministicTarGz = (
  members: ReadonlyArray<TarMember>,
): { readonly tar: Uint8Array; readonly archive: Uint8Array; readonly digest: string } => {
  const tar = encodeUstarArchive(members);
  return { tar, archive: gzipDeterministic(tar), digest: sha256Bytes(tar) };
};

const field = (header: Uint8Array, start: number, length: number): string => {
  const value = decoder.decode(header.subarray(start, start + length));
  const terminator = value.indexOf("\0");
  return terminator === -1 ? value : value.slice(0, terminator);
};

export interface ParsedTarMember {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly modeClass: SandboxFileModeClass;
  readonly bytes: Uint8Array;
}

type ArchiveResult<A> = Result.Result<A, ReturnType<typeof sandboxArchiveInvalid>>;

type DecodedTarHeader = {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly type: number;
};

const invalidArchive = (message: string): ArchiveResult<never> =>
  Result.fail(sandboxArchiveInvalid(message, "Rebuild the sandbox bundle, then retry."));

const decodeTarMemberHeader = (
  bytes: Uint8Array,
  offset: number,
): ArchiveResult<DecodedTarHeader> => {
  const header = bytes.subarray(offset, offset + BLOCK);
  const name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  const sizeText = field(header, 124, 12).trim();
  const size = Number.parseInt(sizeText || "0", 8);
  const checksumText = field(header, 148, 8).trim();
  const expectedChecksum = Number.parseInt(checksumText || "0", 8);
  if (!Number.isFinite(expectedChecksum) || expectedChecksum !== headerChecksum(header))
    return invalidArchive("Sandbox archive checksum is invalid");
  const mode = Number.parseInt(field(header, 100, 8).trim() || "0", 8);
  if (!Number.isFinite(mode) || mode < 0 || mode > 0o7777)
    return invalidArchive("Sandbox archive contains an unsupported mode");
  if (!Number.isFinite(size) || size < 0) return invalidArchive("Sandbox archive is malformed");
  if (size > SANDBOX_MAX_FILE_BYTES)
    return invalidArchive("Sandbox archive file exceeds the per-file size limit");
  if (offset + BLOCK + size > bytes.length) return invalidArchive("Sandbox archive is truncated");
  if (!isSafeBundlePath(path) || path.length > SANDBOX_MAX_PATH_BYTES)
    return invalidArchive("Sandbox archive contains an unsafe path");
  return Result.succeed({
    path,
    size,
    mode,
    type: header[156],
  });
};

export const parseSandboxTar = (
  bytes: Uint8Array,
): Result.Result<ReadonlyArray<ParsedTarMember>, ReturnType<typeof sandboxArchiveInvalid>> => {
  const members: ParsedTarMember[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const header = decodeTarMemberHeader(bytes, offset);
    if (Result.isFailure(header)) return Result.fail(header.failure);
    const { path, size, mode, type } = header.success;
    if (seen.has(path)) return invalidArchive("Sandbox archive contains duplicate members");
    seen.add(path);
    if (
      type === HARDLINK_TYPE ||
      type === SYMLINK_TYPE ||
      (type !== 0 && type !== FILE_TYPE && type !== DIRECTORY_TYPE)
    )
      return invalidArchive("Sandbox archive contains an unsupported member type");
    const isDirectory = type === DIRECTORY_TYPE;
    members.push({
      path,
      type: isDirectory ? "directory" : "file",
      modeClass: !isDirectory && (mode & 0o111) !== 0 ? "executable" : "regular",
      bytes: isDirectory ? new Uint8Array() : bytes.slice(offset + BLOCK, offset + BLOCK + size),
    });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return Result.succeed(members);
};

export const gunzipSandboxArchive = (
  bytes: Uint8Array,
): Result.Result<Uint8Array, ReturnType<typeof sandboxArchiveInvalid>> => {
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: zlib gunzipSync throws on truncated or hostile gzip
  try {
    return Result.succeed(new Uint8Array(gunzipSync(bytes)));
  } catch {
    return Result.fail(
      sandboxArchiveInvalid(
        "Sandbox archive is not valid gzip",
        "Rebuild the sandbox bundle, then retry.",
      ),
    );
  }
};

const filesFromMembers = (members: ReadonlyArray<ParsedTarMember>): Map<string, ParsedTarMember> =>
  new Map(members.map((member) => [member.path, member]));

type ExpectedSandboxFile = {
  readonly size: number;
  readonly digest: string;
  readonly modeClass?: SandboxFileModeClass;
};

const parentDirectories = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/");
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index += 1)
    directories.push(parts.slice(0, index).join("/"));
  return directories;
};

const expectedFiles = (
  manifest: SandboxBundleManifest,
  members: ReadonlyMap<string, ParsedTarMember>,
): Result.Result<Map<string, ExpectedSandboxFile>, ReturnType<typeof sandboxArchiveInvalid>> =>
  expectedManifestFiles(manifest, members).pipe(Result.map(({ files }) => files));

const collectExpectedItem = (
  item: SandboxBundleItemManifest,
  members: ReadonlyMap<string, ParsedTarMember>,
  expected: Map<string, ExpectedSandboxFile>,
  directories: Set<string>,
  seenItems: Set<string>,
): ArchiveResult<undefined> => {
  const itemKey = `${item.kind}\0${item.name}`;
  if (seenItems.has(itemKey))
    return invalidArchive("Sandbox archive manifest contains duplicate bundle items");
  seenItems.add(itemKey);
  if (["skill", "package"].includes(item.kind) && item.shape !== "directory")
    return invalidArchive("Sandbox archive item shape does not match its kind");
  const itemRoot = `${sandboxBundleItemRoot(item.kind)}/${item.name}`;
  const itemMember = members.get(itemRoot);
  if (item.shape === "file") {
    if (item.files.length !== 1 || item.files[0]?.path !== item.name)
      return invalidArchive("Sandbox archive manifest file item does not match its name");
    if (itemMember?.type !== "file")
      return invalidArchive("Sandbox archive file item is not materialized at its name");
  } else {
    directories.add(itemRoot);
    for (const parent of parentDirectories(itemRoot)) directories.add(parent);
    if (itemMember?.type === "file" || (item.files.length === 0 && itemMember === undefined))
      return invalidArchive("Sandbox archive directory item is not materialized at its name");
  }
  if (itemContentDigest(item.files) !== item.digest)
    return invalidArchive("Sandbox archive item digest does not match its manifest files");
  for (const file of item.files) {
    if (!isSafeBundlePath(file.path))
      return invalidArchive("Sandbox archive manifest contains an unsafe file path");
    const archivePath = sandboxBundleItemFilePath(item, file.path);
    if (expected.has(archivePath))
      return invalidArchive("Sandbox archive manifest contains duplicate file paths");
    expected.set(archivePath, {
      size: file.size,
      digest: file.digest,
      modeClass: file.modeClass,
    });
    for (const parent of parentDirectories(archivePath)) directories.add(parent);
  }
  return Result.succeed(undefined);
};

const validateManifestMember = (
  path: string,
  member: ParsedTarMember,
  directories: ReadonlySet<string>,
  members: ReadonlyMap<string, ParsedTarMember>,
): ArchiveResult<undefined> => {
  if (path === "manifest.json") return Result.succeed(undefined);
  if (member.type === "directory" && !directories.has(path))
    return invalidArchive("Sandbox archive contains an unlisted directory");
  if (member.type === "file") {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      if (members.get(parts.slice(0, index).join("/"))?.type === "file")
        return invalidArchive("Sandbox archive file shape is incoherent");
  }
  return Result.succeed(undefined);
};

const expectedManifestFiles = (
  manifest: SandboxBundleManifest,
  members: ReadonlyMap<string, ParsedTarMember>,
): Result.Result<
  { readonly files: Map<string, ExpectedSandboxFile>; readonly directories: ReadonlySet<string> },
  ReturnType<typeof sandboxArchiveInvalid>
> => {
  const expected = new Map<string, ExpectedSandboxFile>();
  const directories = new Set<string>();
  const seenItems = new Set<string>();
  for (const item of manifest.items) {
    const result = collectExpectedItem(item, members, expected, directories, seenItems);
    if (Result.isFailure(result)) return Result.fail(result.failure);
  }
  for (const [path, member] of members) {
    const result = validateManifestMember(path, member, directories, members);
    if (Result.isFailure(result)) return Result.fail(result.failure);
  }
  return Result.succeed({ files: expected, directories });
};

export const validateSandboxArchive = (
  bytes: Uint8Array,
): Result.Result<
  { readonly digest: string; readonly manifest: SandboxBundleManifest },
  ReturnType<typeof sandboxArchiveInvalid>
> => {
  const tar = gunzipSandboxArchive(bytes);
  if (Result.isFailure(tar)) return Result.fail(tar.failure);
  const digest = sha256Bytes(tar.success);
  const parsed = parseSandboxTar(tar.success);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const files = filesFromMembers(parsed.success);
  const manifestMember = files.get("manifest.json");
  if (manifestMember === undefined || manifestMember.type !== "file")
    return Result.fail(
      sandboxArchiveInvalid(
        "Sandbox archive is missing manifest.json",
        "Rebuild the sandbox bundle, then retry.",
      ),
    );
  const decoded = decodeBundleManifestText(decoder.decode(manifestMember.bytes));
  if (Result.isFailure(decoded))
    return Result.fail(
      sandboxArchiveInvalid(
        "Sandbox archive manifest is invalid",
        "Rebuild the sandbox bundle, then retry.",
      ),
    );
  const manifest = decoded.success;
  const expectedResult = expectedFiles(manifest, files);
  if (Result.isFailure(expectedResult)) return Result.fail(expectedResult.failure);
  const expected = expectedResult.success;
  for (const [path, member] of files) {
    if (path === "manifest.json" || member.type !== "file") continue;
    const record = expected.get(path);
    if (record === undefined)
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive contains a file missing from the manifest",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    if (
      member.bytes.byteLength !== record.size ||
      sha256Bytes(member.bytes) !== record.digest ||
      (record.modeClass !== undefined && member.modeClass !== record.modeClass)
    )
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive file digest does not match the manifest",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    expected.delete(path);
  }
  if (expected.size > 0)
    return Result.fail(
      sandboxArchiveInvalid(
        "Sandbox archive manifest lists a file that is not present",
        "Rebuild the sandbox bundle, then retry.",
      ),
    );
  return Result.succeed({ digest, manifest });
};
