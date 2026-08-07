import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyPiPackagePins } from "./check-pi-packages.mjs";

test("Pi packages are vendored, pinned, locked, and image-local", () => {
  assert.deepEqual(verifyPiPackagePins(), { vendoredPackages: 8, npmPackages: 1 });
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
