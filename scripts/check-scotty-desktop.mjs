import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = join(root, "desktop");
const failures = [];

const requiredFiles = [
  "Cargo.toml",
  "COMET_LICENSE",
  "COMET_UPSTREAM.md",
  "GEIST_LICENSE.txt",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/macos/Info.plist",
  "crates/scotty-desktop/Cargo.toml",
  "crates/scotty-desktop/src/app_menus.rs",
  "crates/scotty-desktop/src/main.rs",
  "crates/scotty-desktop/src/sidecar.rs",
  "crates/scotty-desktop/src/theme.rs",
];

const readRequired = async (relative) => {
  try {
    return await readFile(join(desktop, relative), "utf8");
  } catch {
    failures.push(`missing desktop file: ${relative}`);
    return "";
  }
};

const files = new Map(
  await Promise.all(
    requiredFiles.map(async (relative) => [relative, await readRequired(relative)]),
  ),
);
const cargo = files.get("Cargo.toml") ?? "";
const provenance = files.get("COMET_UPSTREAM.md") ?? "";
const plist = files.get("dist/macos/Info.plist") ?? "";

const GPUI_REV = "a6c1ad501f90c9437d2553bde691958f150364c5";
const COMET_REV = "b033110d087ae0f1d1ba607b77d97624165c1986";
if (!cargo.includes(`rev = "${GPUI_REV}"`)) failures.push("desktop GPUI revision is not pinned");
if (!provenance.includes(COMET_REV)) failures.push("Comet source revision is not recorded");
for (const blob of [
  "d6d320b7368dc00608955c6bb39e0445c3732d60",
  "794540f1e93dac13518a8c5ce08d6111a120ec1b",
  "f63f0afc6390323715972b6645115485f37cc9f4",
  "f1f640b6c2c538ff85094efe3fbc840aadd09466",
  "96cb22f8bb85577f3d56c497ee82913883da0fbd",
  "b2b0618fa4ef73c5585043410a6ed9ed8a3c8e2a",
  "863b2868c15bfce525a09174b4d322c12b5d498c",
  "9885e9732ed5acb8f0ca9a98cf9f984eb3dd5de9",
  "2cb0a384d5057c3af0676e1692b89ab46478f150",
])
  if (!provenance.includes(blob)) failures.push(`missing Comet provenance blob: ${blob}`);
if (!plist.includes("dev.scotty.desktop") || !plist.includes("scotty-desktop"))
  failures.push("desktop bundle identity is incomplete");
if (!plist.includes("<string>13.0</string>"))
  failures.push("desktop bundle must require the Bun sidecar's macOS 13 minimum");
if (/"wayland"|"x11"/u.test(cargo)) failures.push("desktop GPUI features must remain macOS-only");

const gitBlobId = (content) =>
  createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
const copiedBlobs = new Map([
  ["COMET_LICENSE", "2cb0a384d5057c3af0676e1692b89ab46478f150"],
  ["crates/scotty-desktop/assets/fonts/Geist.ttf", "f63f0afc6390323715972b6645115485f37cc9f4"],
  ["crates/scotty-desktop/assets/fonts/GeistMono.ttf", "f1f640b6c2c538ff85094efe3fbc840aadd09466"],
  [
    "crates/scotty-desktop/assets/fonts/Geist-Medium.ttf",
    "96cb22f8bb85577f3d56c497ee82913883da0fbd",
  ],
  [
    "crates/scotty-desktop/assets/fonts/Geist-SemiBold.ttf",
    "b2b0618fa4ef73c5585043410a6ed9ed8a3c8e2a",
  ],
  ["crates/scotty-desktop/assets/fonts/Geist-Bold.ttf", "863b2868c15bfce525a09174b4d322c12b5d498c"],
]);
for (const [relative, expected] of copiedBlobs) {
  try {
    const actual = gitBlobId(await readFile(join(desktop, relative)));
    if (actual !== expected) failures.push(`modified copied Comet asset: ${relative}`);
  } catch {
    failures.push(`missing copied Comet asset: ${relative}`);
  }
}

const sourceFiles = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".rs", ".toml"].includes(extname(entry.name))) sourceFiles.push(path);
  }
};
await walk(join(desktop, "crates"));

const forbidden = [
  ["Comet engine ownership", /comet[_-](?:engine|harness|doc|sync|rpc)/iu],
  ["CRDT state", /\bloro\b/iu],
  ["credential account runtime", /agent[_-]accounts|workos/iu],
  ["desktop updater", /auto[_-]?update|updater/iu],
  ["Pi process ownership", /Command::new\([^\n]*["']pi["']/u],
  ["credential environment", /SCOTTY_(?:CREDENTIAL|TOKEN)|CODEX_API_KEY|GITHUB_TOKEN/u],
];
for (const path of sourceFiles) {
  const source = await readFile(path, "utf8");
  for (const [label, pattern] of forbidden)
    if (pattern.test(source)) failures.push(`${path.slice(root.length)}: forbidden ${label}`);
}

const sidecarMain = await readFile(join(root, "pi-scotty/src/desktop-sidecar-main.ts"), "utf8");
const sidecarClient = await readFile(
  join(root, "desktop/crates/scotty-desktop/src/sidecar.rs"),
  "utf8",
);
const sidecarBuild = await readFile(join(root, "scripts/build-scotty-desktop-sidecar.mjs"), "utf8");
if (!sidecarMain.includes("loadConfig") || !sidecarMain.includes("HttpConsoleTransport"))
  failures.push("desktop sidecar must reuse the paired Scotty transport boundary");
if (/process\.env\.(?:SCOTTY_CREDENTIAL|CODEX_API_KEY|GITHUB_TOKEN)/u.test(sidecarMain))
  failures.push("desktop sidecar must not accept credentials through environment variables");
if (!sidecarClient.includes("command.env_clear()"))
  failures.push("desktop client must start the sidecar with an allowlisted environment");
for (const flag of ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"])
  if (!sidecarBuild.includes(flag)) failures.push(`desktop sidecar build is missing ${flag}`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("desktop provenance, ownership, bundle, and credential-isolation checks passed");
}
