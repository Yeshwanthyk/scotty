import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "worker/container/pi-packages/manifest.json";
const settingsPath = "worker/container/pi-packages/settings.json";
const npmLockPath = "worker/container/pi-packages/npm/package-lock.json";
const containerAuthPath = "worker/src/container-auth.ts";
const gitMaxBuffer = 64 * 1_024 * 1_024;

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function fail(message) {
  throw new Error(`Pi package pin check failed: ${message}`);
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function requireKeys(value, label, required, optional = []) {
  const entry = requireRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(entry, key)) fail(`${label}.${key} is required`);
  }
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
  }
  return entry;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a string`);
  return value;
}

function requireOrder(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function requireSourceSha256(value, label) {
  const sourceSha256 = requireString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(sourceSha256)) fail(`${label} must be a lowercase SHA-256 digest`);
  return sourceSha256;
}

function requireRepository(value, label) {
  const repository = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(repository);
  } catch {
    fail(`${label} must be an absolute HTTPS Git repository URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.endsWith(".git")
  )
    fail(`${label} must be an absolute HTTPS Git repository URL ending in .git`);
  return repository;
}

function requireCommit(value, label) {
  const commit = requireString(value, label);
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail(`${label} must be a full lowercase Git commit ID`);
  return commit;
}

function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], { maxBuffer: gitMaxBuffer, ...options });
}

function assertRepositoryIndex(root) {
  const repositoryRoot = git(root, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (realpathSync(repositoryRoot) !== realpathSync(root))
    fail(`verification root ${root} must be the current Git repository root`);
}

function stagedFiles(root, sourcePath) {
  const output = git(root, ["ls-files", "--stage", "-z", "--", sourcePath], {
    encoding: "utf8",
  });
  const entries = output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/u);
      if (!match?.[1] || !match[2] || !match[3] || !match[4])
        fail(`${sourcePath} has an unexpected Git index entry`);
      if (match[3] !== "0") fail(`${sourcePath} has an unresolved Git index entry`);
      return { mode: match[1], objectId: match[2], trackedPath: match[4] };
    });
  if (entries.length === 0) fail(`${sourcePath} must contain tracked source files`);
  if (entries.some(({ mode }) => mode === "160000"))
    fail(`${sourcePath} must be stored as ordinary files, not a gitlink`);
  return entries;
}

function indexBlob(root, objectId) {
  return git(root, ["cat-file", "blob", objectId]);
}

function trackedIndexBlob(root, trackedPath) {
  const entries = stagedFiles(root, trackedPath);
  const entry = entries.find((candidate) => candidate.trackedPath === trackedPath);
  if (entries.length !== 1 || !entry) fail(`${trackedPath} must be a tracked ordinary file`);
  return indexBlob(root, entry.objectId);
}

function readIndexJson(root, trackedPath) {
  return JSON.parse(trackedIndexBlob(root, trackedPath).toString("utf8"));
}

function sourceDigest(root, sourcePath, entries) {
  const sourceHash = createHash("sha256");
  for (const { mode, objectId, trackedPath } of entries) {
    const content = indexBlob(root, objectId);
    sourceHash.update(mode);
    sourceHash.update("\0");
    sourceHash.update(trackedPath.slice(sourcePath.length + 1));
    sourceHash.update("\0");
    sourceHash.update(String(content.length));
    sourceHash.update("\0");
    sourceHash.update(content);
  }
  return sourceHash.digest("hex");
}

function verifyLocallyAvailableCommit(root, label, commit, entries, sourcePath) {
  const objectType = spawnSync("git", ["-C", root, "cat-file", "-t", commit], {
    encoding: "utf8",
  });
  if (objectType.status !== 0) return;
  if (objectType.stdout.trim() !== "commit") fail(`${label}.commit must identify a Git commit`);

  for (const { mode, trackedPath, objectId } of entries) {
    const relativePath = trackedPath.slice(sourcePath.length + 1);
    const treeOutput = git(root, ["ls-tree", "-z", commit, "--", relativePath], {
      encoding: "utf8",
    });
    const treeEntry = treeOutput.endsWith("\0") ? treeOutput.slice(0, -1) : treeOutput;
    const match = treeEntry.match(/^([0-7]{6}) blob ([0-9a-f]{40,64})\t(.+)$/u);
    if (!match?.[1] || !match[2] || match[3] !== relativePath)
      fail(`${label}.commit does not contain ${relativePath}`);
    if (match[1] !== mode || !indexBlob(root, match[2]).equals(indexBlob(root, objectId)))
      fail(`${label}.commit does not match the indexed source at ${relativePath}`);
  }
}

function verifySourcePackage(root, entry, label, kind) {
  const allowedKeys = ["name", "order", "sourceSha256", "sourcePath", "imagePath"];
  const packageEntry = requireKeys(
    entry,
    label,
    kind === "vendored" ? [...allowedKeys, "repository", "commit"] : allowedKeys,
    kind === "vendored" ? ["lockPath"] : [],
  );
  const name = requireString(packageEntry.name, `${label}.name`);
  const order = requireOrder(packageEntry.order, `${label}.order`);
  const sourceSha256 = requireSourceSha256(packageEntry.sourceSha256, `${label}.sourceSha256`);
  const sourcePath = requireString(packageEntry.sourcePath, `${label}.sourcePath`);
  const imagePath = requireString(packageEntry.imagePath, `${label}.imagePath`);
  const sourceRoot = join(root, sourcePath);
  if (existsSync(join(sourceRoot, ".git")))
    fail(`${sourcePath} must not contain nested Git metadata`);

  const files = stagedFiles(root, sourcePath);
  if (!files.some(({ trackedPath }) => trackedPath === `${sourcePath}/package.json`))
    fail(`${sourcePath}/package.json must be tracked`);
  const packageJson = readIndexJson(root, `${sourcePath}/package.json`);
  if (packageJson.name !== name)
    fail(`${sourcePath}/package.json is ${String(packageJson.name)}, expected ${name}`);
  const lockPath =
    typeof packageEntry.lockPath === "string"
      ? packageEntry.lockPath
      : `${sourcePath}/package-lock.json`;
  const packageLock = readIndexJson(root, lockPath);
  for (const dependencyField of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (
      !isDeepStrictEqual(
        packageLock.packages?.[""]?.[dependencyField] ?? {},
        packageJson[dependencyField] ?? {},
      )
    )
      fail(`${lockPath} root ${dependencyField} do not match ${sourcePath}/package.json`);
  }

  const actualSourceSha256 = sourceDigest(root, sourcePath, files);
  if (actualSourceSha256 !== sourceSha256)
    fail(`${sourcePath} source digest is ${actualSourceSha256}, expected ${sourceSha256}`);

  if (kind === "vendored") {
    requireRepository(packageEntry.repository, `${label}.repository`);
    const commit = requireCommit(packageEntry.commit, `${label}.commit`);
    verifyLocallyAvailableCommit(root, label, commit, files, sourcePath);
  }

  return { order, imagePath };
}

function packagePathsFromContainerAuth(root) {
  const source = readFileSync(join(root, containerAuthPath), "utf8");
  const declaration = source.match(/export const PI_PACKAGES = \[([\s\S]*?)\] as const;/u);
  if (!declaration?.[1]) fail(`${containerAuthPath} must declare PI_PACKAGES as a literal array`);
  return [...declaration[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

export function verifyPiPackagePins(root = scriptRoot) {
  assertRepositoryIndex(root);
  const manifest = requireKeys(readJson(root, manifestPath), manifestPath, [
    "schemaVersion",
    "vendored",
    "firstParty",
    "npm",
  ]);
  if (manifest.schemaVersion !== 3) fail(`${manifestPath} has an unsupported schemaVersion`);
  if (
    !Array.isArray(manifest.vendored) ||
    !Array.isArray(manifest.firstParty) ||
    !Array.isArray(manifest.npm)
  )
    fail(`${manifestPath} must contain vendored, firstParty, and npm arrays`);

  const configured = [];
  for (const [index, entry] of manifest.vendored.entries()) {
    configured.push(verifySourcePackage(root, entry, `vendored[${index}]`, "vendored"));
  }
  for (const [index, entry] of manifest.firstParty.entries()) {
    configured.push(verifySourcePackage(root, entry, `firstParty[${index}]`, "firstParty"));
  }

  const npmLock = readJson(root, npmLockPath);
  for (const [index, value] of manifest.npm.entries()) {
    const label = `npm[${index}]`;
    const entry = requireKeys(value, label, ["name", "order", "version", "integrity", "imagePath"]);
    const name = requireString(entry.name, `${label}.name`);
    const order = requireOrder(entry.order, `${label}.order`);
    const version = requireString(entry.version, `${label}.version`);
    const integrity = requireString(entry.integrity, `${label}.integrity`);
    const imagePath = requireString(entry.imagePath, `${label}.imagePath`);
    const locked = npmLock.packages?.[`node_modules/${name}`];
    if (locked?.version !== version) fail(`${name} lock version must be ${version}`);
    if (locked?.integrity !== integrity) fail(`${name} lock integrity does not match the manifest`);
    configured.push({ order, imagePath });
  }

  configured.sort((left, right) => left.order - right.order);
  const expectedPaths = configured.map(({ imagePath }) => imagePath);
  if (new Set(configured.map(({ order }) => order)).size !== configured.length)
    fail("package load orders must be unique");
  if (configured.some(({ order }, index) => order !== index))
    fail("package load orders must be contiguous from zero");
  if (expectedPaths.some((path) => !path.startsWith("/opt/scotty/pi-packages/")))
    fail("every runtime package must be an image-local /opt/scotty/pi-packages path");

  const settings = readJson(root, settingsPath);
  if (JSON.stringify(settings.packages) !== JSON.stringify(expectedPaths))
    fail(`${settingsPath} package order does not match the pin manifest`);
  const containerAuthPaths = packagePathsFromContainerAuth(root);
  if (JSON.stringify(containerAuthPaths) !== JSON.stringify(expectedPaths))
    fail(`${containerAuthPath} PI_PACKAGES does not match the pin manifest`);

  return {
    vendoredPackages: manifest.vendored.length,
    firstPartyPackages: manifest.firstParty.length,
    npmPackages: manifest.npm.length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = verifyPiPackagePins();
  console.log(
    `Verified ${result.vendoredPackages} externally vendored Pi packages, ${result.firstPartyPackages} first-party Pi package, and ${result.npmPackages} pinned Pi npm package.`,
  );
}
