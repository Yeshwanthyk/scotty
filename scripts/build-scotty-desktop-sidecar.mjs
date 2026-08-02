import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const requestedOutput = process.argv[2];
const output = resolve(root, requestedOutput ?? "dist/scotty-console-sidecar");
await mkdir(dirname(output), { recursive: true });

const result = await new Promise((resolveResult, reject) => {
  const child = spawn(
    process.env.BUN_BINARY ?? "bun",
    [
      "build",
      "pi-scotty/src/desktop-sidecar-main.ts",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      output,
    ],
    { cwd: root, stdio: "inherit" },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveResult({ code, signal }));
});
if (result.code !== 0)
  throw new Error(`desktop sidecar build failed: ${result.signal ?? result.code ?? "unknown"}`);
