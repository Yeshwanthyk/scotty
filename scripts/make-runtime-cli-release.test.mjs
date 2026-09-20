import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  RUNTIME_CLI_ASSET_NAME,
  RUNTIME_CLI_SIGNING_CONTEXT,
  canonicalRuntimeCliManifestBytes,
  makeRuntimeCliRelease,
  makeRuntimeCliReleasePayload,
  signRuntimeCliReleasePayload,
} from "./make-runtime-cli-release.mjs";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const releaseTag = `v${version}`;
const revision = "a".repeat(40);
const digest = "b".repeat(64);
const cloudflareSandbox = {
  packageVersion: "0.12.9",
  image:
    "docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe",
};
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyBase64: rawPublicKey.toString("base64"),
  };
};
const payload = (patch = {}) =>
  makeRuntimeCliReleasePayload({
    releaseTag,
    revision,
    byteSize: 123,
    sha256: digest,
    bunVersion: "1.3.13",
    cloudflareSandbox,
    ...patch,
  });

const decodeSignature = (value) => Buffer.from(value, "base64");

describe("S2b runtime CLI release", () => {
  it("binds the executable identity, target, size, digest, mode, and compatibility", () => {
    assert.deepEqual(payload(), {
      schemaVersion: 1,
      releaseTag,
      artifact: {
        name: RUNTIME_CLI_ASSET_NAME,
        cliVersion: version,
        revision,
        target: "linux/amd64",
        byteSize: 123,
        sha256: digest,
        installMode: "0755",
      },
      compatibility: {
        bunVersion: "1.3.13",
        compileTarget: "bun-linux-x64-baseline",
        cpu: "x86-64-baseline",
        libc: "glibc",
        cloudflareSandbox,
      },
    });
  });

  it("authenticates every contract field under a runtime-specific signing context", () => {
    const keys = keyPair();
    const signed = signRuntimeCliReleasePayload({
      payload: payload(),
      privateKeyPem: keys.privateKeyPem,
      trustedPublicKeyBase64: keys.publicKeyBase64,
    });
    assert.equal(RUNTIME_CLI_SIGNING_CONTEXT, "scotty-runtime-cli-manifest-v1");
    assert.equal(
      verify(
        null,
        canonicalRuntimeCliManifestBytes(signed),
        createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(keys.publicKeyBase64, "base64"),
          ]),
          format: "der",
          type: "spki",
        }),
        decodeSignature(signed.signature),
      ),
      true,
    );

    for (const changed of [
      { ...signed, releaseTag: `${releaseTag}-tampered` },
      { ...signed, artifact: { ...signed.artifact, revision: "c".repeat(40) } },
      { ...signed, artifact: { ...signed.artifact, target: "linux/arm64" } },
      { ...signed, artifact: { ...signed.artifact, byteSize: 124 } },
      { ...signed, artifact: { ...signed.artifact, sha256: "d".repeat(64) } },
      { ...signed, compatibility: { ...signed.compatibility, libc: "musl" } },
      {
        ...signed,
        compatibility: {
          ...signed.compatibility,
          cloudflareSandbox: { ...cloudflareSandbox, packageVersion: "0.13.0" },
        },
      },
    ]) {
      assert.equal(
        verify(
          null,
          canonicalRuntimeCliManifestBytes(changed),
          createPublicKey({
            key: Buffer.concat([
              Buffer.from("302a300506032b6570032100", "hex"),
              Buffer.from(keys.publicKeyBase64, "base64"),
            ]),
            format: "der",
            type: "spki",
          }),
          decodeSignature(signed.signature),
        ),
        false,
      );
    }
  });

  it("rejects malformed release claims", () => {
    for (const patch of [
      { releaseTag: "latest" },
      { releaseTag: `${releaseTag}-mismatch` },
      { revision: "short" },
      { byteSize: 0 },
      { sha256: "bad" },
      { bunVersion: "latest" },
      {
        cloudflareSandbox: { ...cloudflareSandbox, packageVersion: "00.12.9" },
      },
      {
        cloudflareSandbox: { ...cloudflareSandbox, packageVersion: "0.13.0" },
      },
      { cloudflareSandbox: { ...cloudflareSandbox, image: "cloudflare/sandbox:latest" } },
    ]) {
      assert.throws(() => payload(patch));
    }
  });

  it("accepts safe-integer sizes above the former managed CLI cap", () => {
    const byteSize = 128 * 1024 * 1024 + 1;
    assert.equal(payload({ byteSize }).artifact.byteSize, byteSize);
  });

  it("validates the complete payload again at the public signing entry", () => {
    const keys = keyPair();
    const valid = payload();
    const invalidPayloads = [
      { ...valid, schemaVersion: 2 },
      { ...valid, artifact: { ...valid.artifact, target: "linux/arm64" } },
      {
        ...valid,
        compatibility: {
          ...valid.compatibility,
          cloudflareSandbox: {
            ...valid.compatibility.cloudflareSandbox,
            packageVersion: "00.12.9",
          },
        },
      },
      {
        ...valid,
        compatibility: {
          ...valid.compatibility,
          cloudflareSandbox: {
            ...valid.compatibility.cloudflareSandbox,
            packageVersion: "0.13.0",
          },
        },
      },
      {
        ...valid,
        compatibility: {
          ...valid.compatibility,
          cloudflareSandbox: { ...cloudflareSandbox, extra: true },
        },
      },
    ];

    for (const invalid of invalidPayloads) {
      assert.throws(() =>
        signRuntimeCliReleasePayload({
          payload: invalid,
          privateKeyPem: keys.privateKeyPem,
          trustedPublicKeyBase64: keys.publicKeyBase64,
        }),
      );
    }
  });

  it("measures, hashes, chmods, and signs the exact release asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-runtime-release-"));
    const keys = keyPair();
    try {
      const asset = join(directory, RUNTIME_CLI_ASSET_NAME);
      await writeFile(asset, "runtime-cli", { mode: 0o600 });
      const manifest = await makeRuntimeCliRelease({
        releaseTag,
        assetDirectory: directory,
        revision,
        privateKeyPem: keys.privateKeyPem,
        trustedPublicKeyBase64: keys.publicKeyBase64,
      });
      assert.equal(manifest.artifact.byteSize, 11);
      assert.equal(
        manifest.artifact.sha256,
        "4cf8728efc238ec3915aa4d9a74abc158d92819820204a1427cd7503f9e6ade9",
      );
      assert.equal((await stat(asset)).mode & 0o777, 0o755);
      const written = JSON.parse(
        await readFile(join(directory, "scotty-runtime-manifest.json"), "utf8"),
      );
      assert.deepEqual(written, manifest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("builds, attests, signs, and checks the runtime artifact in the supported image", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release-cli.yml", import.meta.url),
      "utf8",
    );
    const runtimeStart = workflow.indexOf("  runtime-cli:");
    const imageStart = workflow.indexOf("  image:");
    const attestStart = workflow.indexOf("  attest:");
    const releaseStart = workflow.indexOf("  release:");
    assert.ok(runtimeStart > 0 && imageStart > runtimeStart);
    const runtimeJob = workflow.slice(runtimeStart, imageStart);
    const imageJob = workflow.slice(imageStart, workflow.indexOf("  image-verify:"));
    const attestJob = workflow.slice(attestStart, releaseStart);
    const releaseJob = workflow.slice(releaseStart);
    assert.match(runtimeJob, /build-runtime-cli\.mjs dist\/release\/scotty-runtime-linux-amd64/u);
    assert.match(runtimeJob, /embeddedDeployment, false/u);
    assert.match(imageJob, /needs: \[verify, runtime-cli\]/u);
    assert.match(imageJob, /--platform "\$SCOTTY_IMAGE_PLATFORM"/u);
    assert.match(attestJob, /name: scotty-runtime-linux-amd64/u);
    assert.match(releaseJob, /make-cli-release\.mjs/u);
    assert.match(releaseJob, /make-runtime-cli-release\.mjs/u);
  });

  it("keeps the host build and updater manifest contracts separate", async () => {
    const buildSource = await readFile(new URL("./build-runtime-cli.mjs", import.meta.url), "utf8");
    const hostReleaseSource = await readFile(
      new URL("./make-cli-release.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      buildSource,
      /deployment-packaging|Archive|ui:build|bundleDeploymentWorkers/u,
    );
    assert.match(buildSource, /cli", "scotty\.ts/u);
    assert.match(hostReleaseSource, /scotty-upgrade-manifest\.json/u);
    assert.doesNotMatch(hostReleaseSource, /runtime/iu);
  });
});
