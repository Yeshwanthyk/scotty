import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "worker/container/pi-packages/manifest.json";
const settingsPath = "worker/container/pi-packages/settings.json";
const npmLockPath = "worker/container/pi-packages/npm/package-lock.json";
const containerAuthPath = "worker/src/container-auth.ts";

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function fail(message) {
  throw new Error(`Pi package pin check failed: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a string`);
  return value;
}

function requireOrder(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function packagePathsFromContainerAuth(root) {
  const source = readFileSync(join(root, containerAuthPath), "utf8");
  const declaration = source.match(/export const PI_PACKAGES = \[([\s\S]*?)\] as const;/);
  if (!declaration?.[1]) fail(`${containerAuthPath} must declare PI_PACKAGES as a literal array`);
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

export function verifyPiPackagePins(root = scriptRoot) {
  const manifest = readJson(root, manifestPath);
  if (manifest.schemaVersion !== 2) fail(`${manifestPath} has an unsupported schemaVersion`);
  if (!Array.isArray(manifest.vendored) || !Array.isArray(manifest.npm))
    fail(`${manifestPath} must contain vendored and npm arrays`);

  const configured = [];
  for (const [index, entry] of manifest.vendored.entries()) {
    const label = `vendored[${index}]`;
    const name = requireString(entry.name, `${label}.name`);
    const order = requireOrder(entry.order, `${label}.order`);
    const repository = requireString(entry.repository, `${label}.repository`);
    const commit = requireString(entry.commit, `${label}.commit`);
    const sourceSha256 = requireString(entry.sourceSha256, `${label}.sourceSha256`);
    if (!/^[0-9a-f]{64}$/.test(sourceSha256))
      fail(`${label}.sourceSha256 must be a lowercase SHA-256 digest`);
    const sourcePath = requireString(entry.sourcePath, `${label}.sourcePath`);
    const imagePath = requireString(entry.imagePath, `${label}.imagePath`);
    const sourceRoot = join(root, sourcePath);
    if (!existsSync(join(sourceRoot, "package.json"))) fail(`${sourcePath} is not vendored`);
    if (existsSync(join(sourceRoot, ".git")))
      fail(`${sourcePath} must not contain nested Git metadata`);

    const packageJson = readJson(root, `${sourcePath}/package.json`);
    if (packageJson.name !== name)
      fail(`${sourcePath}/package.json is ${String(packageJson.name)}, expected ${name}`);
    const lockPath =
      typeof entry.lockPath === "string" ? entry.lockPath : `${sourcePath}/package-lock.json`;
    if (!existsSync(join(root, lockPath))) fail(`${lockPath} does not exist`);
    const packageLock = readJson(root, lockPath);
    for (const dependencyField of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (
        !isDeepStrictEqual(
          packageLock.packages?.[""]?.[dependencyField] ?? {},
          packageJson[dependencyField] ?? {},
        )
      )
        fail(`${lockPath} root ${dependencyField} do not match ${sourcePath}/package.json`);
    }

    const stagedFiles = execFileSync("git", ["-C", root, "ls-files", "--stage", "--", sourcePath], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    if (stagedFiles.length === 0) fail(`${sourcePath} must contain tracked source files`);
    if (stagedFiles.some((line) => line.startsWith("160000 ")))
      fail(`${sourcePath} must be vendored as ordinary files, not a gitlink`);
    if (!stagedFiles.some((line) => line.endsWith(`\t${sourcePath}/package.json`)))
      fail(`${sourcePath}/package.json must be tracked`);

    const sourceHash = createHash("sha256");
    for (const line of stagedFiles) {
      const match = line.match(/^(\d+) [0-9a-f]+ \d+\t(.+)$/);
      if (!match?.[1] || !match[2]) fail(`${sourcePath} has an unexpected Git index entry`);
      const [mode, trackedPath] = [match[1], match[2]];
      const content = readFileSync(join(root, trackedPath));
      sourceHash.update(mode);
      sourceHash.update("\0");
      sourceHash.update(trackedPath.slice(sourcePath.length + 1));
      sourceHash.update("\0");
      sourceHash.update(String(content.length));
      sourceHash.update("\0");
      sourceHash.update(content);
    }
    const actualSourceSha256 = sourceHash.digest("hex");
    if (actualSourceSha256 !== sourceSha256)
      fail(`${sourcePath} source digest is ${actualSourceSha256}, expected ${sourceSha256}`);

    // Repository and commit remain immutable provenance for future vendor updates.
    void repository;
    void commit;
    configured.push({ order, imagePath });
  }

  const npmLock = readJson(root, npmLockPath);
  for (const [index, entry] of manifest.npm.entries()) {
    const label = `npm[${index}]`;
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

  return { vendoredPackages: manifest.vendored.length, npmPackages: manifest.npm.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = verifyPiPackagePins();
  console.log(
    `Verified ${result.vendoredPackages} vendored Pi packages and ${result.npmPackages} pinned Pi npm package.`,
  );
}
