import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
  throw new Error("Scotty Desktop packaging currently requires macOS");

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = process.env.SCOTTY_DESKTOP_VERSION ?? manifest.version;
const output = resolve(root, process.argv[2] ?? "dist/Scotty.app");
const contents = join(output, "Contents");
const macos = join(contents, "MacOS");
const resources = join(contents, "Resources");
const licenses = join(resources, "licenses");

const run = (command, args, options = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} failed: ${signal ?? code ?? "unknown"}`));
    });
  });

await run("cargo", [
  "build",
  "--manifest-path",
  "desktop/Cargo.toml",
  "--package",
  "scotty-desktop",
  "--release",
  "--locked",
]);
await rm(output, { recursive: true, force: true });
await Promise.all([mkdir(macos, { recursive: true }), mkdir(licenses, { recursive: true })]);
await run(process.execPath, [
  "scripts/build-scotty-desktop-sidecar.mjs",
  join(resources, "scotty-console-sidecar"),
]);
await cp(join(root, "desktop/target/release/scotty-desktop"), join(macos, "scotty-desktop"));
await chmod(join(macos, "scotty-desktop"), 0o755);
await chmod(join(resources, "scotty-console-sidecar"), 0o755);

const plist = (await readFile(join(root, "desktop/dist/macos/Info.plist"), "utf8")).replaceAll(
  "__VERSION__",
  version,
);
await writeFile(join(contents, "Info.plist"), plist);
for (const name of ["COMET_LICENSE", "GEIST_LICENSE.txt", "THIRD_PARTY_NOTICES.md"])
  await cp(join(root, "desktop", name), join(licenses, name));

await run("plutil", ["-lint", join(contents, "Info.plist")]);
const signingIdentity = process.env.SCOTTY_CODESIGN_IDENTITY ?? "-";
for (const executable of [join(resources, "scotty-console-sidecar"), join(macos, "scotty-desktop")])
  await run("codesign", ["--force", "--sign", signingIdentity, executable]);
await run("codesign", ["--force", "--sign", signingIdentity, output]);
console.log(`Packaged development bundle ${output}`);
