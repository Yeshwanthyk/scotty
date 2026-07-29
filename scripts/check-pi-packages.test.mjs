import assert from "node:assert/strict";
import test from "node:test";
import { verifyPiPackagePins } from "./check-pi-packages.mjs";

test("Pi packages are vendored, pinned, locked, and image-local", () => {
  assert.deepEqual(verifyPiPackagePins(), { vendoredPackages: 7, npmPackages: 1 });
});
