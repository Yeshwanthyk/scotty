import { createPrivateKey, createPublicKey, createHash, sign, verify } from "node:crypto";
import { chmod, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import {
  SCOTTY_RELEASE_PUBLIC_KEY_BASE64,
  canonicalUpgradeManifestBytes,
} from "../cli/src/upgrade.ts";

const [, , releaseTag, assetDirectory = "dist/release"] = process.argv;
if (!releaseTag || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(releaseTag))
  throw new Error("Usage: bun scripts/make-cli-release.mjs vMAJOR.MINOR.PATCH [ASSET_DIRECTORY]");
if (releaseTag !== `v${packageMetadata.version}`)
  throw new Error(
    `Release tag ${releaseTag} does not match package version ${packageMetadata.version}.`,
  );

const directory = resolve(assetDirectory);
const targetPattern = /^scotty-(darwin|linux)-(arm64|x64)$/u;
const entries = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && targetPattern.test(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name));
if (entries.length !== 4)
  throw new Error("The release must contain darwin/linux arm64/x64 CLI assets.");

const assets = [];
for (const entry of entries) {
  const match = targetPattern.exec(entry.name);
  if (!match) continue;
  const bytes = await Bun.file(join(directory, entry.name)).arrayBuffer();
  assets.push({
    platform: match[1],
    architecture: match[2],
    name: basename(entry.name),
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
  });
  await chmod(join(directory, entry.name), 0o755);
}

const privateKeyPem = process.env.SCOTTY_RELEASE_ED25519_PRIVATE_KEY;
if (!privateKeyPem) throw new Error("SCOTTY_RELEASE_ED25519_PRIVATE_KEY is required.");
const payload = { version: 1, releaseTag, assets };
const signedBytes = canonicalUpgradeManifestBytes(payload);
const signature = sign(null, signedBytes, createPrivateKey(privateKeyPem));
const publicKey = createPublicKey({
  key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(SCOTTY_RELEASE_PUBLIC_KEY_BASE64, "base64"),
  ]),
  format: "der",
  type: "spki",
});
if (!verify(null, signedBytes, publicKey, signature))
  throw new Error("The release signing key does not match the public key embedded in Scotty.");
const manifest = { ...payload, signature: signature.toString("base64") };
await writeFile(
  join(directory, "scotty-upgrade-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
