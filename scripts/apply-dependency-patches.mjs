import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEPENDENCY_PATCHES = Object.freeze([
  "patches/alchemy+2.0.0-beta.76.patch",
  "patches/@alchemy.run+cloudflare-runtime+2.0.0-beta.76.patch",
]);

export const defaultGitApply = (args, patch, cwd = root) =>
  spawnSync("git", ["apply", ...args, patch], {
    cwd,
    encoding: "utf8",
  });

export const listedPatchFileNames = () =>
  DEPENDENCY_PATCHES.map((patch) => patch.slice("patches/".length)).sort();

export const onDiskPatchFileNames = (cwd = root) =>
  readdirSync(join(cwd, "patches"))
    .filter((name) => name.endsWith(".patch"))
    .sort();

export const assertPatchInventory = (cwd = root) => {
  const listed = listedPatchFileNames();
  const onDisk = onDiskPatchFileNames(cwd);
  if (JSON.stringify(listed) !== JSON.stringify(onDisk)) {
    throw new Error(
      [
        "Patch inventory drifted from patches/.",
        `Listed: ${listed.join(", ") || "(none)"}`,
        `On disk: ${onDisk.join(", ") || "(none)"}`,
      ].join("\n"),
    );
  }
};

export const verifyDependencyPatches = ({
  mode = "apply",
  gitApply = defaultGitApply,
  cwd = root,
} = {}) => {
  assertPatchInventory(cwd);
  for (const patch of DEPENDENCY_PATCHES) {
    const applicable = gitApply(["--check"], patch, cwd);
    const alreadyApplied = gitApply(["--reverse", "--check"], patch, cwd);
    if (alreadyApplied.status === 0) {
      console.log(mode === "check" ? `Verified ${patch}` : `Already applied ${patch}`);
      continue;
    }
    if (mode === "check") {
      throw new Error(
        applicable.status === 0
          ? `${patch} is not applied.`
          : [
              `${patch} does not apply cleanly to the installed dependency.`,
              "Forward check:",
              applicable.stderr,
              "Reverse check:",
              alreadyApplied.stderr,
            ].join("\n"),
      );
    }
    if (applicable.status === 0) {
      const applied = gitApply(["--whitespace=nowarn"], patch, cwd);
      if (applied.status !== 0) {
        throw new Error(`Could not apply ${patch}:\n${applied.stderr}`);
      }
      console.log(`Applied ${patch}`);
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
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  verifyDependencyPatches({
    mode: process.argv.includes("--check") ? "check" : "apply",
  });
}
