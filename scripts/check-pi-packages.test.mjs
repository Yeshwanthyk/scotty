import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyPiPackagePins } from "./check-pi-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "worker/container/pi-packages/manifest.json";

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function readManifest(repository = root) {
  return JSON.parse(readFileSync(join(repository, manifestPath), "utf8"));
}

function writeManifest(repository, manifest) {
  writeFileSync(join(repository, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
}

function withIndexFixture(run) {
  const fixture = mkdtempSync(join(tmpdir(), "scotty-pi-package-pins-"));
  try {
    execFileSync("git", ["-C", root, "checkout-index", "--all", `--prefix=${fixture}/`]);
    copyFileSync(
      join(root, "worker/container/pi-packages/settings.json"),
      join(fixture, "worker/container/pi-packages/settings.json"),
    );
    copyFileSync(
      join(root, "worker/src/container-auth.ts"),
      join(fixture, "worker/src/container-auth.ts"),
    );
    copyFileSync(join(root, manifestPath), join(fixture, manifestPath));
    git(fixture, "init", "--quiet");
    git(fixture, "add", "--force", ".");
    git(
      fixture,
      "-c",
      "user.name=Scotty Tests",
      "-c",
      "user.email=scotty-tests@example.invalid",
      "commit",
      "--quiet",
      "--message=fixture",
    );
    return run(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("Pi packages are externally vendored or first-party, pinned, locked, and image-local", () => {
  assert.deepEqual(verifyPiPackagePins(), {
    vendoredPackages: 6,
    firstPartyPackages: 2,
    npmPackages: 1,
  });
});

test("schema v3 identifies first-party source without external commit provenance", () => {
  const manifest = readManifest();
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.firstParty.length, 2);
  assert.deepEqual(
    manifest.firstParty.map((entry) => entry.name),
    ["scotty-browser-test", "scotty-hatch"],
  );
  for (const entry of manifest.firstParty) {
    assert.deepEqual(Object.keys(entry), [
      "name",
      "order",
      "sourceSha256",
      "sourcePath",
      "imagePath",
    ]);
    assert.equal(Object.hasOwn(entry, "repository"), false);
    assert.equal(Object.hasOwn(entry, "commit"), false);
  }
});

test("first-party entries reject forged external commit provenance", () => {
  withIndexFixture((fixture) => {
    const manifest = readManifest(fixture);
    manifest.firstParty[0].repository = "https://github.com/Yeshwanthyk/scotty.git";
    manifest.firstParty[0].commit = git(fixture, "rev-parse", "HEAD");
    writeManifest(fixture, manifest);

    assert.throws(
      () => verifyPiPackagePins(fixture),
      /firstParty\[0\]\.repository is not allowed/u,
    );
  });
});

test("externally vendored commits are full IDs and match locally available source", () => {
  withIndexFixture((fixture) => {
    const manifest = readManifest(fixture);
    manifest.vendored[0].commit = "main";
    writeManifest(fixture, manifest);
    assert.throws(
      () => verifyPiPackagePins(fixture),
      /vendored\[0\]\.commit must be a full lowercase Git commit ID/u,
    );

    manifest.vendored[0].commit = git(fixture, "rev-parse", "HEAD");
    writeManifest(fixture, manifest);
    assert.throws(
      () => verifyPiPackagePins(fixture),
      /vendored\[0\]\.commit does not (?:contain|match) /u,
    );
  });
});

test("source digests use staged blobs despite vendored and first-party worktree drift", () => {
  withIndexFixture((fixture) => {
    for (const sourcePath of [
      "worker/container/pi-packages/sources/scotty-browser-test/README.md",
      "worker/container/pi-packages/sources/scotty-hatch/README.md",
    ]) {
      appendFileSync(join(fixture, sourcePath), "\nunstaged test drift\n");
      assert.doesNotThrow(() => verifyPiPackagePins(fixture));

      git(fixture, "add", "--force", sourcePath);
      assert.throws(
        () => verifyPiPackagePins(fixture),
        new RegExp(`${dirname(sourcePath)} source digest is`, "u"),
      );
      git(fixture, "reset", "--hard", "--quiet", "HEAD");
    }
  });
});

test("the first-party browser test package stays bounded and browser-authority free", () => {
  const source = readFileSync(
    "worker/container/pi-packages/sources/scotty-browser-test/index.ts",
    "utf8",
  );
  const dockerfile = readFileSync("worker/container/Dockerfile", "utf8");

  assert.equal((source.match(/registerTool\(/gu) ?? []).length, 1);
  assert.match(source, /name: "scotty_browser_test"/u);
  assert.match(source, /https:\/\/scotty\.internal\/api\/evidence\/jobs/u);
  assert.match(source, /64 \* 1_024/u);
  for (const forbidden of [
    "agent-browser",
    "playwright",
    "puppeteer",
    "chromium",
    "x-api-key",
    "authorization",
    "SCOTTY_SESSION_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ]) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.match(dockerfile, /scotty-browser-test/u);
  assert.doesNotMatch(dockerfile, /(?:apt-get|npm install)[^\n]*(?:chromium|agent-browser)/iu);
});

test("the first-party Hatch package stays source-bound, process-scoped, and credential-free", () => {
  const source = readFileSync("worker/container/pi-packages/sources/scotty-hatch/index.ts", "utf8");
  const dockerfile = readFileSync("worker/container/Dockerfile", "utf8");

  assert.equal((source.match(/registerTool\(/gu) ?? []).length, 1);
  assert.match(source, /name: "scotty_hatch"/u);
  assert.match(source, /https:\/\/scotty\.internal\/api\/hatch/u);
  assert.match(source, /detached: true/u);
  assert.match(source, /shell: false/u);
  assert.match(source, /process\.kill\(-pid, signal\)/u);
  assert.match(source, /"SIGTERM"/u);
  assert.match(source, /"SIGKILL"/u);
  assert.match(source, /64 \* 1_024/u);
  for (const forbidden of [
    "SCOTTY_SESSION_ID",
    "GH_TOKEN",
    "GITHUB_SENTINEL",
    'authorization"',
    "x-api-key",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(dockerfile, /scotty-hatch/u);
});
