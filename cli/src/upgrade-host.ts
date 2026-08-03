import { chmod, lstat, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { Effect, Option, Schema } from "effect";
import type { CliUpgradeRequest, CliUpgradeResult } from "./services.ts";
import {
  SCOTTY_RELEASE_PUBLIC_KEY_BASE64,
  UpgradeManifestSchema,
  selectUpgradeAsset,
  verifyUpgradeAsset,
  verifyUpgradeManifest,
  type UpgradeArchitecture,
  type UpgradePlatform,
} from "./upgrade.ts";

const RELEASE_API = "https://api.github.com/repos/Yeshwanthyk/scotty/releases/latest";
const MANIFEST_ASSET_NAME = "scotty-upgrade-manifest.json";
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

const GitHubReleaseSchema = Schema.Struct({
  tag_name: Schema.NonEmptyString,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      browser_download_url: Schema.NonEmptyString,
      size: Schema.Finite,
    }),
  ),
});

const decodeReleaseJson = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubReleaseSchema), {
  onExcessProperty: "ignore",
});
const decodeManifestJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(UpgradeManifestSchema),
  { onExcessProperty: "error" },
);

class CliUpgradeHostError extends Schema.TaggedErrorClass<CliUpgradeHostError>(
  "CliUpgradeHostError",
)("CliUpgradeHostError", { reason: Schema.String }) {
  override readonly message = "The Scotty CLI upgrade failed";
}

const reject = (reason: string): never => {
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise updater reports one stable host failure to its Effect service adapter
  throw new CliUpgradeHostError({ reason });
};

const decodeBase64 = (value: string): Uint8Array => {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) return reject("The embedded release key is invalid.");
  return new Uint8Array(bytes);
};

const readBoundedResponse = async (
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> => {
  if (!response.ok) return reject(`GitHub returned HTTP ${response.status} during CLI upgrade.`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes)
    return reject("The CLI upgrade download is larger than the allowed limit.");
  if (!response.body) return reject("The CLI upgrade download has no response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      return reject("The CLI upgrade download is larger than the allowed limit.");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const fetchBytes = async (url: string, maximumBytes: number): Promise<Uint8Array> => {
  // oxlint-disable-next-line scotty/no-raw-fetch -- boundary: standalone CLI updater owns GitHub release downloads
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "scotty-cli-updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  return readBoundedResponse(response, maximumBytes);
};

const semver = (value: string): readonly [number, number, number] | undefined => {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

const compareVersions = (left: readonly number[], right: readonly number[]): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const target = (
  platform: NodeJS.Platform,
  architecture: string,
): { readonly platform: UpgradePlatform; readonly architecture: UpgradeArchitecture } => {
  if (platform !== "darwin" && platform !== "linux")
    return reject(`CLI upgrade does not support platform ${platform}.`);
  if (architecture !== "arm64" && architecture !== "x64")
    return reject(`CLI upgrade does not support architecture ${architecture}.`);
  return { platform, architecture };
};

const releaseJson = async (): Promise<typeof GitHubReleaseSchema.Type> => {
  const bytes = await fetchBytes(RELEASE_API, MAX_MANIFEST_BYTES);
  const decoded = decodeReleaseJson(new TextDecoder().decode(bytes));
  if (Option.isNone(decoded)) return reject("GitHub returned invalid release metadata.");
  if (decoded.value.draft || decoded.value.prerelease)
    return reject("GitHub did not return a stable Scotty release.");
  return decoded.value;
};

const assetUrl = (
  release: typeof GitHubReleaseSchema.Type,
  name: string,
  maximumBytes: number,
): string => {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) return reject(`The release is missing ${name}.`);
  if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > maximumBytes)
    return reject(`The release asset ${name} has an invalid size.`);
  return asset.browser_download_url;
};

const replaceExecutable = async (
  executablePath: string,
  bytes: Uint8Array,
  expectedVersion: string,
): Promise<void> => {
  const info = await lstat(executablePath);
  if (!info.isFile() || info.isSymbolicLink())
    return reject("The current Scotty executable is not a replaceable regular file.");
  const directory = dirname(executablePath);
  const temporary = join(directory, `.scotty-upgrade-${process.pid}-${crypto.randomUUID()}`);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: updater cleans its same-directory temporary executable on every exit
  try {
    const file = await open(temporary, "wx", info.mode & 0o777);
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: updater closes the temporary executable before probing it
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temporary, info.mode & 0o777);
    const child = Bun.spawn([temporary, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0 || stdout.trim() !== expectedVersion)
      return reject(
        `The downloaded CLI failed its version check${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
      );
    await rename(temporary, executablePath);
    const directoryHandle = await open(directory, "r");
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: directory fsync finalizes the atomic executable replacement
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
};

export async function upgradeCli(request: CliUpgradeRequest): Promise<CliUpgradeResult> {
  if (["bun", "node", "node.exe"].includes(basename(request.executablePath)))
    return reject(
      "CLI upgrade must run from the compiled Scotty executable, not a source runtime.",
    );
  const current = semver(request.currentVersion);
  if (!current) return reject("The current CLI version is invalid.");
  const selectedTarget = target(request.platform, request.architecture);
  const executable = await stat(request.executablePath);
  if (!executable.isFile()) return reject("The current Scotty executable could not be found.");

  const release = await releaseJson();
  const next = semver(release.tag_name);
  if (!next) return reject("The release tag is not a valid stable version.");
  if (compareVersions(next, current) <= 0)
    return {
      previousVersion: request.currentVersion,
      version: request.currentVersion,
      updated: false,
    };

  const manifestBytes = await fetchBytes(
    assetUrl(release, MANIFEST_ASSET_NAME, MAX_MANIFEST_BYTES),
    MAX_MANIFEST_BYTES,
  );
  const manifestJson = decodeManifestJson(new TextDecoder().decode(manifestBytes));
  if (Option.isNone(manifestJson)) return reject("The signed release manifest is malformed.");
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: standalone updater owns pure manifest verification execution
  const manifest = await Effect.runPromise(
    verifyUpgradeManifest({
      manifest: manifestJson.value,
      trustedManifestPublicKey: decodeBase64(SCOTTY_RELEASE_PUBLIC_KEY_BASE64),
    }),
  );
  if (manifest.releaseTag !== release.tag_name)
    return reject("The signed manifest does not match the GitHub release tag.");
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: standalone updater owns pure target selection execution
  const selected = await Effect.runPromise(selectUpgradeAsset(manifest, selectedTarget));
  const executableBytes = await fetchBytes(
    assetUrl(release, selected.name, MAX_EXECUTABLE_BYTES),
    MAX_EXECUTABLE_BYTES,
  );
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: standalone updater owns pure asset verification execution
  await Effect.runPromise(verifyUpgradeAsset(selected, executableBytes));

  const releaseVersion = release.tag_name.replace(/^v/u, "");
  const releaseLock = await lockfile.lock(request.executablePath, {
    realpath: true,
    retries: { retries: 0 },
  });
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: updater releases its process lock after replacement or failure
  try {
    await replaceExecutable(request.executablePath, executableBytes, releaseVersion);
  } finally {
    await releaseLock();
  }
  return {
    previousVersion: request.currentVersion,
    version: releaseVersion,
    updated: true,
  };
}
