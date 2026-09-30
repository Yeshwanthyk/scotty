// Builds the scotty binary for each platform, with the release and SKILL.md inside it
// (cli/binary.ts). Run `npm run compile` after `npm run ui:build`; the binaries land in dist/bin.
// The macOS ones are signed only when this runs on macOS.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease } from "./release.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = process.argv.slice(2);
const platforms = targets.length > 0 ? targets : ["darwin-arm64", "darwin-x64", "linux-x64"];

const release = join(root, "dist/release");
await buildRelease(release);
const pack: Record<string, string> = {};
const files = execFileSync("find", [release, "-type", "f"], { encoding: "utf8" });
for (const path of files.split("\n").filter((line) => line !== ""))
  pack[`release/${relative(release, path)}`] = (await readFile(path)).toString("base64");
pack["SKILL.md"] = (await readFile(join(root, "skills/scotty/SKILL.md"))).toString("base64");
await writeFile(join(root, "dist/release.pack"), JSON.stringify(pack));

for (const platform of platforms) {
  const out = `dist/bin/scotty-${platform}`;
  execFileSync(
    "bun",
    ["build", "--compile", `--target=bun-${platform}`, "cli/binary.ts", "--outfile", out],
    { cwd: root, stdio: "inherit" },
  );
  // A binary built for the other Mac architecture carries a broken signature; macOS on Apple
  // silicon runs nothing unsigned.
  if (platform.startsWith("darwin-") && process.platform === "darwin")
    execFileSync("codesign", ["--force", "--sign", "-", out], { cwd: root, stdio: "inherit" });
}
