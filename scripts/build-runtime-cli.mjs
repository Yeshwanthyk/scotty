import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_CLI_COMPILE_TARGET = "bun-linux-x64-baseline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const buildRuntimeCli = async (outputPath) => {
  const output = resolve(outputPath ?? join(root, "dist", "release", "scotty-runtime-linux-amd64"));
  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const candidateCommit = commitResult.stdout?.trim();
  const buildCommit =
    commitResult.status === 0 && /^[a-f0-9]{40}$/u.test(candidateCommit ?? "")
      ? candidateCommit
      : null;
  const statusResult = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
  });
  const buildDirty = statusResult.status === 0 ? statusResult.stdout.trim().length > 0 : null;

  await mkdir(dirname(output), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "cli", "scotty.ts")],
    target: "bun",
    define: {
      SCOTTY_BUILD_COMMIT: JSON.stringify(buildCommit),
      SCOTTY_BUILD_DIRTY: JSON.stringify(buildDirty),
    },
    compile: {
      outfile: output,
      target: RUNTIME_CLI_COMPILE_TARGET,
    },
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Runtime CLI build failed.");
  }
  return output;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(`${await buildRuntimeCli(process.argv[2])}\n`);
}
