import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyPiScottyThemeAssets,
  PI_CODING_AGENT_VERSION,
  PI_THEME_FILES,
  resolvePiCodingAgentPackage,
} from "./pi-scotty-theme-assets.mjs";

test("packages exact coding-agent v0.83.0 theme assets beside the binary", async () => {
  assert.equal(PI_CODING_AGENT_VERSION, "0.83.0");
  const work = await mkdtemp(join(tmpdir(), "pi-scotty-theme-test-"));
  try {
    const { themeDirectory } = await resolvePiCodingAgentPackage();
    await copyPiScottyThemeAssets(work);
    for (const file of PI_THEME_FILES) {
      const [source, copied] = await Promise.all([
        readFile(join(themeDirectory, file), "utf8"),
        readFile(join(work, "theme", file), "utf8"),
      ]);
      assert.equal(copied, source, `${file} must be copied byte-for-byte`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
