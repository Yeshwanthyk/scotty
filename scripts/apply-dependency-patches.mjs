import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patches = ["patches/alchemy+2.0.0-beta.63.patch"];

const gitApply = (args, patch) =>
  spawnSync("git", ["apply", ...args, patch], {
    cwd: root,
    encoding: "utf8",
  });

for (const patch of patches) {
  const applicable = gitApply(["--check"], patch);
  if (applicable.status === 0) {
    const applied = gitApply(["--whitespace=nowarn"], patch);
    if (applied.status !== 0) {
      throw new Error(`Could not apply ${patch}:\n${applied.stderr}`);
    }
    console.log(`Applied ${patch}`);
    continue;
  }

  const alreadyApplied = gitApply(["--reverse", "--check"], patch);
  if (alreadyApplied.status === 0) {
    console.log(`Already applied ${patch}`);
    continue;
  }

  throw new Error(
    [
      `${patch} does not apply cleanly to the installed dependency.`,
      "Forward check:",
      applicable.stderr,
      "Reverse check:",
      alreadyApplied.stderr,
    ].join("\n"),
  );
}
