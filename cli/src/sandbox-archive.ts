import { gunzipSync, gzipSync } from "node:zlib";
import { Result } from "effect";
import {
  SANDBOX_MAX_FILE_BYTES,
  SANDBOX_MAX_PATH_BYTES,
  compareUtf8,
  decodeBundleManifestText,
  isSafeBundlePath,
  sandboxArchiveInvalid,
  sha256Bytes,
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
  readonly bytes: Uint8Array;
}

export const parseSandboxTar = (
  bytes: Uint8Array,
): Result.Result<ReadonlyArray<ParsedTarMember>, ReturnType<typeof sandboxArchiveInvalid>> => {
  const members: ParsedTarMember[] = [];
  const seen = new Set<string>();
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
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive checksum is invalid",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    if (!Number.isFinite(size) || size < 0)
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive is malformed",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    if (size > SANDBOX_MAX_FILE_BYTES)
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive file exceeds the per-file size limit",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    if (offset + BLOCK + size > bytes.length)
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive is truncated",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    if (!isSafeBundlePath(path) || path.length > SANDBOX_MAX_PATH_BYTES)
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive contains an unsafe path",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    if (seen.has(path))
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive contains duplicate members",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    seen.add(path);
    const type = header[156];
    if (
      type === HARDLINK_TYPE ||
      type === SYMLINK_TYPE ||
      (type !== 0 && type !== FILE_TYPE && type !== DIRECTORY_TYPE)
    )
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive contains an unsupported member type",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    const isDirectory = type === DIRECTORY_TYPE;
    members.push({
      path,
      type: isDirectory ? "directory" : "file",
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

const filesFromMembers = (members: ReadonlyArray<ParsedTarMember>): Map<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>();
  for (const member of members) {
    if (member.type === "file") files.set(member.path, member.bytes);
  }
  return files;
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
  const manifestBytes = files.get("manifest.json");
  if (manifestBytes === undefined)
    return Result.fail(
      sandboxArchiveInvalid(
        "Sandbox archive is missing manifest.json",
        "Rebuild the sandbox bundle, then retry.",
      ),
    );
  const decoded = decodeBundleManifestText(decoder.decode(manifestBytes));
  if (Result.isFailure(decoded))
    return Result.fail(
      sandboxArchiveInvalid(
        "Sandbox archive manifest is invalid",
        "Rebuild the sandbox bundle, then retry.",
      ),
    );
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
      return Result.fail(
        sandboxArchiveInvalid(
          "Sandbox archive contains a file missing from the manifest",
          "Rebuild the sandbox bundle, then retry.",
        ),
      );
    if (content.byteLength !== record.size || sha256Bytes(content) !== record.digest)
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
