import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { copyPiScottyThemeAssets } from "./pi-scotty-theme-assets.mjs";

const root = new URL("../", import.meta.url);
const requestedOutput = process.argv[2];
const output = resolve(root.pathname, requestedOutput ?? "dist/pi-scotty");
await mkdir(dirname(output), { recursive: true });

const result = await new Promise((resolveResult, reject) => {
  const child = spawn(
    process.env.BUN_BINARY ?? "bun",
    ["build", "pi-scotty/src/main.ts", "--compile", "--outfile", output],
    { cwd: root, stdio: "inherit" },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveResult({ code, signal }));
});
if (result.code !== 0)
  throw new Error(`pi-scotty build failed: ${result.signal ?? result.code ?? "unknown"}`);
await copyPiScottyThemeAssets(dirname(output));
