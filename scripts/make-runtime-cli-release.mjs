import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };
import { SCOTTY_RELEASE_PUBLIC_KEY_BASE64 } from "../cli/src/upgrade.ts";
import { RUNTIME_CLI_COMPILE_TARGET } from "./build-runtime-cli.mjs";
import { readImageCompatibility } from "./make-image-release.mjs";

export const RUNTIME_CLI_ASSET_NAME = "scotty-runtime-linux-amd64";
export const RUNTIME_CLI_MANIFEST_NAME = "scotty-runtime-manifest.json";
export const RUNTIME_CLI_SIGNING_CONTEXT = "scotty-runtime-cli-manifest-v1";

const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const LENGTH_PREFIX_BYTES = 4;
const textEncoder = new TextEncoder();

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const sandboxImagePattern = /^docker\.io\/cloudflare\/sandbox:[^\s@]+@sha256:[0-9a-f]{64}$/u;

const assertExactKeys = (value, expectedKeys, label) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is invalid.`);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expectedKeys].sort(),
    `${label} fields are invalid.`,
  );
};

const validateRuntimeCliReleasePayload = (payload) => {
  assertExactKeys(payload, ["schemaVersion", "releaseTag", "artifact", "compatibility"], "Payload");
  assert.equal(payload.schemaVersion, 1, "Runtime CLI schema version is invalid.");
  assert.match(payload.releaseTag, releaseTagPattern, "Runtime CLI release tag is invalid.");

  assertExactKeys(
    payload.artifact,
    ["name", "cliVersion", "revision", "target", "byteSize", "sha256", "installMode"],
    "Runtime CLI artifact",
  );
  assert.equal(payload.artifact.name, RUNTIME_CLI_ASSET_NAME, "Runtime CLI asset name is invalid.");
  assert.match(payload.artifact.cliVersion, semverPattern, "Runtime CLI version is invalid.");
  assert.equal(
    payload.releaseTag,
    `v${payload.artifact.cliVersion}`,
    "Runtime CLI release tag must match the CLI version.",
  );
  assert.match(
    payload.artifact.revision,
    revisionPattern,
    "Runtime CLI revision must be a full Git commit SHA.",
  );
  assert.equal(payload.artifact.target, "linux/amd64", "Runtime CLI target is invalid.");
  assert.ok(
    Number.isSafeInteger(payload.artifact.byteSize) && payload.artifact.byteSize > 0,
    "Runtime CLI byte size is invalid.",
  );
  assert.match(payload.artifact.sha256, sha256Pattern, "Runtime CLI digest is invalid.");
  assert.equal(payload.artifact.installMode, "0755", "Runtime CLI install mode is invalid.");

  assertExactKeys(
    payload.compatibility,
    ["bunVersion", "compileTarget", "cpu", "libc", "cloudflareSandbox"],
    "Runtime CLI compatibility",
  );
  assert.match(payload.compatibility.bunVersion, semverPattern, "Bun version is invalid.");
  assert.equal(
    payload.compatibility.compileTarget,
    RUNTIME_CLI_COMPILE_TARGET,
    "Runtime CLI compile target is invalid.",
  );
  assert.equal(payload.compatibility.cpu, "x86-64-baseline", "Runtime CLI CPU is invalid.");
  assert.equal(payload.compatibility.libc, "glibc", "Runtime CLI libc is invalid.");
  assertExactKeys(
    payload.compatibility.cloudflareSandbox,
    ["packageVersion", "image"],
    "Cloudflare Sandbox compatibility",
  );
  assert.match(
    payload.compatibility.cloudflareSandbox.packageVersion,
    semverPattern,
    "Cloudflare Sandbox package version is invalid.",
  );
  assert.match(
    payload.compatibility.cloudflareSandbox.image,
    sandboxImagePattern,
    "Cloudflare Sandbox base image must be digest-pinned.",
  );
  assert.ok(
    payload.compatibility.cloudflareSandbox.image.startsWith(
      `docker.io/cloudflare/sandbox:${payload.compatibility.cloudflareSandbox.packageVersion}@sha256:`,
    ),
    "Cloudflare Sandbox base image must match the package version.",
  );
  return payload;
};

const encodeLengthPrefixedFields = (fields) => {
  const length = fields.reduce((total, field) => total + LENGTH_PREFIX_BYTES + field.byteLength, 0);
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += LENGTH_PREFIX_BYTES;
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
};

export const makeRuntimeCliReleasePayload = ({
  releaseTag,
  revision,
  byteSize,
  sha256,
  bunVersion,
  cloudflareSandbox,
}) => {
  assert.match(releaseTag, releaseTagPattern, "Runtime CLI release tag is invalid.");
  assert.equal(
    releaseTag,
    `v${packageMetadata.version}`,
    "Runtime CLI release tag must match the package version.",
  );
  assert.match(revision, revisionPattern, "Runtime CLI revision must be a full Git commit SHA.");
  assert.ok(Number.isSafeInteger(byteSize) && byteSize > 0, "Runtime CLI byte size is invalid.");
  assert.match(sha256, sha256Pattern, "Runtime CLI digest is invalid.");
  assert.match(bunVersion, semverPattern, "Bun version is invalid.");
  assert.ok(
    cloudflareSandbox && typeof cloudflareSandbox === "object",
    "Cloudflare Sandbox compatibility is required.",
  );
  assert.match(
    cloudflareSandbox.packageVersion,
    semverPattern,
    "Cloudflare Sandbox package version is invalid.",
  );
  assert.match(
    cloudflareSandbox.image,
    sandboxImagePattern,
    "Cloudflare Sandbox base image must be digest-pinned.",
  );

  return validateRuntimeCliReleasePayload({
    schemaVersion: 1,
    releaseTag,
    artifact: {
      name: RUNTIME_CLI_ASSET_NAME,
      cliVersion: packageMetadata.version,
      revision,
      target: "linux/amd64",
      byteSize,
      sha256,
      installMode: "0755",
    },
    compatibility: {
      bunVersion,
      compileTarget: RUNTIME_CLI_COMPILE_TARGET,
      cpu: "x86-64-baseline",
      libc: "glibc",
      cloudflareSandbox,
    },
  });
};

/** Exact metadata bytes authenticated by the existing release Ed25519 trust root. */
export const canonicalRuntimeCliManifestBytes = (payload) =>
  encodeLengthPrefixedFields(
    [
      RUNTIME_CLI_SIGNING_CONTEXT,
      String(payload.schemaVersion),
      payload.releaseTag,
      payload.artifact.name,
      payload.artifact.cliVersion,
      payload.artifact.revision,
      payload.artifact.target,
      String(payload.artifact.byteSize),
      payload.artifact.sha256,
      payload.artifact.installMode,
      payload.compatibility.bunVersion,
      payload.compatibility.compileTarget,
      payload.compatibility.cpu,
      payload.compatibility.libc,
      payload.compatibility.cloudflareSandbox.packageVersion,
      payload.compatibility.cloudflareSandbox.image,
    ].map((field) => textEncoder.encode(field)),
  );

export const signRuntimeCliReleasePayload = ({
  payload,
  privateKeyPem,
  trustedPublicKeyBase64 = SCOTTY_RELEASE_PUBLIC_KEY_BASE64,
}) => {
  validateRuntimeCliReleasePayload(payload);
  const signedBytes = canonicalRuntimeCliManifestBytes(payload);
  const signature = sign(null, signedBytes, createPrivateKey(privateKeyPem));
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(trustedPublicKeyBase64, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
  assert.ok(
    verify(null, signedBytes, publicKey, signature),
    "The release signing key does not match the public key embedded in Scotty.",
  );
  return { ...payload, signature: signature.toString("base64") };
};

export const makeRuntimeCliRelease = async ({
  releaseTag,
  assetDirectory = "dist/release",
  revision = process.env.GITHUB_SHA,
  privateKeyPem = process.env.SCOTTY_RELEASE_ED25519_PRIVATE_KEY,
  trustedPublicKeyBase64 = SCOTTY_RELEASE_PUBLIC_KEY_BASE64,
  root = process.cwd(),
} = {}) => {
  assert.ok(privateKeyPem, "SCOTTY_RELEASE_ED25519_PRIVATE_KEY is required.");
  const directory = resolve(assetDirectory);
  const assetPath = join(directory, RUNTIME_CLI_ASSET_NAME);
  assert.equal(basename(assetPath), RUNTIME_CLI_ASSET_NAME);
  await chmod(assetPath, 0o755);
  const assetStat = await stat(assetPath);
  assert.ok(assetStat.isFile(), "Runtime CLI asset must be a regular file.");
  const bytes = await readFile(assetPath);
  const imageCompatibility = await readImageCompatibility(root);
  const payload = makeRuntimeCliReleasePayload({
    releaseTag,
    revision,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bunVersion: (await readFile(resolve(root, ".bun-version"), "utf8")).trim(),
    cloudflareSandbox: imageCompatibility.cloudflareSandbox,
  });
  const manifest = signRuntimeCliReleasePayload({
    payload,
    privateKeyPem,
    trustedPublicKeyBase64,
  });
  await writeFile(
    join(directory, RUNTIME_CLI_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o644,
    },
  );
  return manifest;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [, , releaseTag, assetDirectory] = process.argv;
  if (!releaseTag)
    throw new Error(
      "Usage: bun scripts/make-runtime-cli-release.mjs vMAJOR.MINOR.PATCH [ASSET_DIRECTORY]",
    );
  await makeRuntimeCliRelease({ releaseTag, ...(assetDirectory ? { assetDirectory } : {}) });
}
