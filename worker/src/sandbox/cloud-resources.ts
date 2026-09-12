import { Effect, Result, Schema } from "effect";
import {
  sandboxBundleItemDigestMaterial,
  sandboxBundleItemFilePath,
} from "../../../protocol/sandbox-bundle";
import type { CloudResourceKind, CloudResourcePut } from "../../../protocol/cloud-resources";
import { sha256BytesHex } from "../shared/digest";
import {
  SANDBOX_MAX_BUNDLE_FILES,
  SANDBOX_MAX_FILE_BYTES,
  SANDBOX_MAX_PATH_BYTES,
  isSafeBundlePath,
  validateSandboxArchive,
  type ParsedTarMember,
} from "./archive";
import { SandboxBundleManifestSchema, type SandboxBundleManifest } from "./config-contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_RESOURCE_BODY_BYTES = 16 * 1024 * 1024;
export { MAX_RESOURCE_BODY_BYTES };
const sensitiveExact = new Set([
  ".aws",
  ".dockerconfigjson",
  ".envrc",
  ".git",
  ".git-credentials",
  ".hg",
  ".netrc",
  ".npm",
  ".npmrc",
  ".pypirc",
  ".ssh",
  ".svn",
  "access_token",
  "auth",
  "auth.json",
  "credentials",
  "credentials.json",
  "refresh_token",
  "token",
  "token.json",
  "tokens.json",
]);
const sensitivePath = (part: string): boolean =>
  sensitiveExact.has(part) ||
  part === ".env" ||
  part.startsWith(".env.") ||
  part.endsWith(".env") ||
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.+\.(?:key|pem|p12|pfx))$/u.test(part) ||
  part === "history" ||
  part.endsWith("_history") ||
  part.endsWith(".history") ||
  part === "log" ||
  part === "logs" ||
  part.endsWith(".log");
const decodeManifest = Schema.decodeUnknownResult(SandboxBundleManifestSchema, {
  onExcessProperty: "error",
});
const PiPackageJsonSchema = Schema.Struct({
  name: Schema.String,
  pi: Schema.Struct({
    extensions: Schema.optionalKey(Schema.Array(Schema.String)),
    skills: Schema.optionalKey(Schema.Array(Schema.String)),
    prompts: Schema.optionalKey(Schema.Array(Schema.String)),
    themes: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodePiPackageJson = Schema.decodeUnknownResult(Schema.fromJsonString(PiPackageJsonSchema), {
  onExcessProperty: "ignore",
});

export interface ResourceBundle {
  readonly manifest: SandboxBundleManifest;
  readonly members: ReadonlyArray<ParsedTarMember>;
}

const compare = (left: string, right: string): number => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};

const decodeBase64 = (content: string): Uint8Array | undefined => {
  if (
    content.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content)
  )
    return undefined;
  return Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
};

const validPreparedPackage = (
  name: string,
  files: ReadonlyArray<CloudResourcePut["files"][number]>,
  seen: ReadonlySet<string>,
): boolean => {
  const packageFile = files.find((file) => file.path === "package.json");
  if (packageFile === undefined) return false;
  const bytes = decodeBase64(packageFile.contentBase64);
  if (bytes === undefined) return false;
  const decoded = decodePiPackageJson(decoder.decode(bytes));
  if (Result.isFailure(decoded) || decoded.success.name !== name) return false;
  const pi = decoded.success.pi;
  if (
    ![pi.extensions, pi.skills, pi.prompts, pi.themes].some(
      (field) => field !== undefined && field.length > 0,
    )
  )
    return false;
  const hasDependencies =
    Object.keys(decoded.success.dependencies ?? {}).length > 0 ||
    Object.keys(decoded.success.optionalDependencies ?? {}).length > 0;
  return (
    !hasDependencies ||
    (seen.has("package-lock.json") && [...seen].some((path) => path.startsWith("node_modules/")))
  );
};

// oxlint-disable-next-line eslint/complexity -- one bounded pass validates each uploaded path, digest, and package contract
export const validateResourceFiles = async (
  kind: CloudResourceKind,
  name: string,
  input: CloudResourcePut,
): Promise<
  | {
      readonly item: SandboxBundleManifest["items"][number];
      readonly members: ReadonlyArray<ParsedTarMember>;
    }
  | undefined
> => {
  if ((kind === "skill" || kind === "package") && input.shape !== "directory") return undefined;
  if (input.files.length === 0 || input.files.length > SANDBOX_MAX_BUNDLE_FILES) return undefined;
  if (input.shape === "file" && (input.files.length !== 1 || input.files[0]?.path !== name))
    return undefined;
  const seen = new Set<string>();
  const members: ParsedTarMember[] = [];
  const records: Array<{
    path: string;
    size: number;
    modeClass: "regular" | "executable";
    digest: string;
  }> = [];
  let total = 0;
  for (const file of input.files) {
    if (
      !isSafeBundlePath(file.path) ||
      encoder.encode(file.path).length > SANDBOX_MAX_PATH_BYTES ||
      seen.has(file.path) ||
      file.path.split("/").some(sensitivePath)
    )
      return undefined;
    seen.add(file.path);
    const bytes = decodeBase64(file.contentBase64);
    if (bytes === undefined || bytes.byteLength > SANDBOX_MAX_FILE_BYTES) return undefined;
    total += bytes.byteLength;
    if (total > 64 * 1024 * 1024) return undefined;
    records.push({
      path: file.path,
      size: bytes.byteLength,
      modeClass: file.modeClass,
      digest: await sha256BytesHex(bytes),
    });
    members.push({
      path: sandboxBundleItemFilePath({ kind, name, shape: input.shape }, file.path),
      type: "file",
      modeClass: file.modeClass,
      bytes,
    });
  }
  if (kind === "skill" && !seen.has("SKILL.md")) return undefined;
  if (kind === "package" && !validPreparedPackage(name, input.files, seen)) return undefined;
  records.sort((a, b) => compare(a.path, b.path));
  const digest = await sha256BytesHex(encoder.encode(sandboxBundleItemDigestMaterial(records)));
  const item = { kind, name, shape: input.shape, digest, files: records };
  const decoded = decodeManifest({ items: [item] });
  if (Result.isFailure(decoded)) return undefined;
  return { item: decoded.success.items[0], members };
};

const writeText = (header: Uint8Array, start: number, size: number, value: string): void => {
  header.set(encoder.encode(value).subarray(0, size), start);
};
const octal = (header: Uint8Array, start: number, size: number, value: number): void =>
  writeText(header, start, size - 1, value.toString(8).padStart(size - 1, "0"));
const tarName = (path: string): { name: string; prefix: string } | undefined => {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100)
      return { name, prefix };
  }
  return undefined;
};
const parentPaths = (path: string): string[] => {
  const parts = path.split("/");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
};

// oxlint-disable-next-line eslint/complexity -- USTAR encoding checks each member and writes one canonical archive
const buildResourceBundleBytes = async (
  manifest: SandboxBundleManifest,
  files: ReadonlyArray<ParsedTarMember>,
): Promise<{ digest: string; gzipBytes: Uint8Array; manifestJson: string } | undefined> => {
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  const byPath = new Map<string, ParsedTarMember>();
  byPath.set("manifest.json", {
    path: "manifest.json",
    type: "file",
    modeClass: "regular",
    bytes: encoder.encode(manifestJson),
  });
  for (const file of files) {
    if (
      file.type !== "file" ||
      !isSafeBundlePath(file.path) ||
      tarName(file.path) === undefined ||
      byPath.has(file.path)
    )
      return undefined;
    byPath.set(file.path, file);
    for (const parent of parentPaths(file.path))
      if (!byPath.has(parent))
        byPath.set(parent, {
          path: parent,
          type: "directory",
          modeClass: "regular",
          bytes: new Uint8Array(),
        });
  }
  const chunks: Uint8Array[] = [];
  for (const member of [...byPath.values()].sort((a, b) => compare(a.path, b.path))) {
    const split = tarName(member.path);
    if (split === undefined) return undefined;
    const header = new Uint8Array(512);
    writeText(header, 0, 100, split.name);
    writeText(header, 345, 155, split.prefix);
    octal(
      header,
      100,
      8,
      member.type === "directory" || member.modeClass === "executable" ? 0o755 : 0o644,
    );
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, member.type === "file" ? member.bytes.length : 0);
    octal(header, 136, 12, 0);
    header[156] = member.type === "directory" ? 53 : 48;
    writeText(header, 257, 6, "ustar");
    writeText(header, 263, 2, "00");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1)
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    writeText(header, 148, 6, checksum.toString(8).padStart(6, "0"));
    header[155] = 32;
    chunks.push(header);
    if (member.type === "file") {
      chunks.push(member.bytes);
      const padding = (512 - (member.bytes.length % 512)) % 512;
      if (padding > 0) chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(1024));
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.length;
  }
  if (tar.length > 96 * 1024 * 1024) return undefined;
  const digest = await sha256BytesHex(tar);
  const compressed = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
  const gzipBytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  return { digest, gzipBytes, manifestJson };
};

export const buildResourceBundle = Effect.fnUntraced(function* (
  manifest: SandboxBundleManifest,
  files: ReadonlyArray<ParsedTarMember>,
) {
  const built = yield* Effect.promise(() => buildResourceBundleBytes(manifest, files));
  if (built === undefined) return undefined;
  const validation = yield* validateSandboxArchive(built.gzipBytes, built.digest).pipe(
    Effect.result,
  );
  return Result.isSuccess(validation) ? built : undefined;
});

export const resourceFiles = (
  bundle: ResourceBundle,
  kind: CloudResourceKind,
  name: string,
): ReadonlyArray<ParsedTarMember> => {
  const item = bundle.manifest.items.find((entry) => entry.kind === kind && entry.name === name);
  if (item === undefined) return [];
  const paths = new Set(item.files.map((file) => sandboxBundleItemFilePath(item, file.path)));
  return bundle.members.filter((member) => member.type === "file" && paths.has(member.path));
};

export const base64Content = (bytes: Uint8Array): string => {
  let output = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(output);
};
