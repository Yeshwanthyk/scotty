import { spawnSync } from "node:child_process";
import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url)));
const expected = packageJson.dependencies?.effect;

if (typeof expected !== "string" || !/^\d/.test(expected)) {
  throw new Error("The root effect dependency must be pinned to an exact version");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["ls", "effect", "--all", "--json"], {
  cwd: new URL("../..", import.meta.url),
  encoding: "utf8",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const tree = JSON.parse(result.stdout);
const versions = new Set();

function collect(dependencies) {
  if (!dependencies) return;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (name === "effect" && typeof dependency.version === "string") {
      versions.add(dependency.version);
    }
    collect(dependency.dependencies);
  }
}

collect(tree.dependencies);

if (versions.size !== 1 || !versions.has(expected)) {
  const installed = versions.size === 0 ? "none" : [...versions].sort().join(", ");
  throw new Error(`Expected only effect@${expected}; installed versions: ${installed}`);
}

process.stdout.write(`Effect version check passed: only effect@${expected} is installed.\n`);
