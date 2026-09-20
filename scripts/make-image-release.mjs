import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };
import workerMetadata from "../worker/package.json" with { type: "json" };
import * as Schema from "effect/Schema";

export const IMAGE_PLATFORM = "linux/amd64";
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const attestationUrlPattern =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/attestations\/[1-9]\d*$/u;
const repositoryPattern =
  /^index\.docker\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

const Digest = Schema.String.check(Schema.isPattern(digestPattern));
const ImageLabels = Schema.Struct({
  "org.opencontainers.image.revision": Schema.String,
  "org.opencontainers.image.base.name": Schema.String,
  "io.scotty.image.platform": Schema.String,
  "io.scotty.compatibility.cloudflare-sandbox": Schema.String,
  "io.scotty.compatibility.cloudflare-containers": Schema.String,
  "io.scotty.compatibility.alchemy": Schema.String,
  "io.scotty.compatibility.pi": Schema.String,
  "io.scotty.compatibility.codex": Schema.String,
  "io.scotty.compatibility.node": Schema.String,
});
const ImageReleaseEnvironment = Schema.Struct({
  releaseTag: Schema.String.check(Schema.isPattern(releaseTagPattern)),
  repository: Schema.String.check(Schema.isPattern(repositoryPattern)),
  digest: Digest,
  platform: Schema.Literal(IMAGE_PLATFORM),
  testedImageId: Digest,
  publicImageId: Digest,
  revision: Schema.String.check(Schema.isPattern(revisionPattern)),
  attestationUrl: Schema.String.check(Schema.isPattern(attestationUrlPattern)),
  labelsPath: Schema.String.check(Schema.isMinLength(1)),
  manifestPath: Schema.String.check(Schema.isMinLength(1)),
});
export const decodeImageLabelsJson = Schema.decodeUnknownSync(Schema.fromJsonString(ImageLabels));
export const decodeImageReleaseEnvironment = Schema.decodeUnknownSync(ImageReleaseEnvironment);

const requireMatch = (text, pattern, description) => {
  const match = pattern.exec(text);
  if (!match?.[1]) assert.fail(`Could not read ${description} from its pinned source.`);
  return match[1];
};

export const parseDockerPushDigest = (output, releaseTag) => {
  validateImageReleaseTag(releaseTag);
  // Docker's completed push record is "<tag>: digest: <digest> size: <bytes>".
  const matches = [
    ...output.matchAll(/^([^\s]+): digest: (sha256:[0-9a-f]{64}) size: [1-9]\d*$/gmu),
  ];
  if (matches.length !== 1 || matches[0]?.[1] !== releaseTag || !matches[0]?.[2])
    assert.fail("Docker push did not report exactly one immutable image digest.");
  return matches[0][2];
};

export const validateImageReleaseTag = (releaseTag) => {
  if (!releaseTagPattern.test(releaseTag) || releaseTag !== `v${packageMetadata.version}`)
    assert.fail("Image release tag must match the package version.");
  return releaseTag;
};

export const validateImageRepository = (repository) => {
  if (typeof repository !== "string" || !repositoryPattern.test(repository))
    assert.fail(
      "SCOTTY_DOCKERHUB_REPOSITORY must be a fully-qualified index.docker.io namespace/repository without a tag or digest.",
    );
  return repository;
};

export const validatePublicationConfig = ({ repository, usernamePresent, tokenPresent }) => {
  validateImageRepository(repository);
  if (usernamePresent !== true) assert.fail("SCOTTY_DOCKERHUB_USERNAME is required.");
  if (tokenPresent !== true) assert.fail("SCOTTY_DOCKERHUB_TOKEN is required.");
  return repository;
};

export const readImageCompatibility = async (root = process.cwd()) => {
  const dockerfile = await readFile(resolve(root, "worker/container/Dockerfile"), "utf8");
  const sandboxPackage = workerMetadata.dependencies["@cloudflare/sandbox"];
  const sandboxImage = requireMatch(
    dockerfile,
    /^FROM (docker\.io\/cloudflare\/sandbox:[^\s]+) AS scotty-codex-server-build$/mu,
    "Cloudflare Sandbox base image",
  );
  const sandboxRuntimeImage = requireMatch(
    dockerfile,
    /^FROM (docker\.io\/cloudflare\/sandbox:[^\s]+) AS scotty-package-image$/mu,
    "Cloudflare Sandbox runtime image",
  );
  if (
    sandboxImage !== sandboxRuntimeImage ||
    !sandboxImage.startsWith(`docker.io/cloudflare/sandbox:${sandboxPackage}@`)
  )
    assert.fail("Cloudflare Sandbox package and pinned build/runtime images must match.");

  return {
    cloudflareSandbox: {
      packageVersion: sandboxPackage,
      image: sandboxImage,
    },
    cloudflareContainers: workerMetadata.dependencies["@cloudflare/containers"],
    alchemy: packageMetadata.dependencies.alchemy,
    pi: requireMatch(dockerfile, /^ARG PI_VERSION=([^\s]+)$/mu, "Pi version"),
    codex: requireMatch(
      dockerfile,
      /codex-package\.json"\), \{layoutVersion:1, version:"([^"]+)"/u,
      "Codex package version",
    ),
    codexArchiveSha256: requireMatch(
      dockerfile,
      /echo "([0-9a-f]{64})  \/tmp\/scotty-codex-install\/codex\.tar\.gz"/u,
      "Codex archive digest",
    ),
    node: requireMatch(dockerfile, /^ARG NODE_VERSION=([^\s]+)$/mu, "Node version"),
  };
};

const expectedLabels = (compatibility, revision) => ({
  "org.opencontainers.image.revision": revision,
  "org.opencontainers.image.base.name": compatibility.cloudflareSandbox.image,
  "io.scotty.image.platform": IMAGE_PLATFORM,
  "io.scotty.compatibility.cloudflare-sandbox": compatibility.cloudflareSandbox.packageVersion,
  "io.scotty.compatibility.cloudflare-containers": compatibility.cloudflareContainers,
  "io.scotty.compatibility.alchemy": compatibility.alchemy,
  "io.scotty.compatibility.pi": compatibility.pi,
  "io.scotty.compatibility.codex": compatibility.codex,
  "io.scotty.compatibility.node": compatibility.node,
});

export const makeImageReleaseManifest = ({
  releaseTag,
  repository,
  digest,
  platform,
  testedImageId,
  publicImageId,
  revision,
  attestationUrl,
  labels,
  compatibility,
}) => {
  validateImageReleaseTag(releaseTag);
  validatePublicationConfig({ repository, usernamePresent: true, tokenPresent: true });
  if (!digestPattern.test(digest)) assert.fail("Published image digest is invalid.");
  if (platform !== IMAGE_PLATFORM)
    assert.fail(`Published image platform must be ${IMAGE_PLATFORM}.`);
  if (!digestPattern.test(testedImageId) || publicImageId !== testedImageId)
    assert.fail("Public image configuration does not match the tested image configuration.");
  if (!revisionPattern.test(revision)) assert.fail("Image revision must be a full Git commit SHA.");
  if (typeof attestationUrl !== "string" || !attestationUrlPattern.test(attestationUrl))
    assert.fail("A GitHub provenance attestation URL is required.");
  assert.deepEqual(
    labels,
    expectedLabels(compatibility, revision),
    "Published image compatibility labels are missing or invalid.",
  );

  return {
    version: 1,
    releaseTag,
    image: {
      repository,
      digest,
      reference: `${repository}@${digest}`,
      platform,
      configDigest: testedImageId,
      revision,
    },
    compatibility,
    provenance: { attestationUrl },
  };
};

export const signImageRuntimeCompatibility = ({
  imageDigest,
  compatibility,
  privateKeyPem,
  trustedPublicKeyBase64 = "b+jhy/AX9PzwFWofyVVPDg/FR8YLVJ9FGIAAJVVPpPE=",
}) => {
  assert.ok(privateKeyPem, "SCOTTY_RELEASE_ED25519_PRIVATE_KEY is required.");
  const payload = { imageDigest, compatibility };
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "scotty-standard-image-runtime-compatibility-v1",
      imageDigest,
      compatibility.bunVersion,
      compatibility.compileTarget,
      compatibility.cpu,
      compatibility.libc,
      compatibility.cloudflareSandbox.packageVersion,
      compatibility.cloudflareSandbox.image,
    ]),
  );
  const signature = sign(null, bytes, createPrivateKey(privateKeyPem));
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(trustedPublicKeyBase64, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
  assert.ok(
    verify(null, bytes, key, signature),
    "Release signing key does not match Scotty trust root.",
  );
  return { ...payload, signature: signature.toString("base64") };
};

export const makeImageRelease = async ({
  environment = process.env,
  root = process.cwd(),
} = {}) => {
  const input = decodeImageReleaseEnvironment({
    releaseTag: environment.SCOTTY_RELEASE_TAG,
    repository: environment.SCOTTY_DOCKERHUB_REPOSITORY,
    digest: environment.SCOTTY_IMAGE_DIGEST,
    platform: environment.SCOTTY_IMAGE_PLATFORM,
    testedImageId: environment.SCOTTY_TESTED_IMAGE_ID,
    publicImageId: environment.SCOTTY_PUBLIC_IMAGE_ID,
    revision: environment.GITHUB_SHA,
    attestationUrl: environment.SCOTTY_IMAGE_ATTESTATION_URL,
    labelsPath: environment.SCOTTY_IMAGE_LABELS_PATH,
    manifestPath:
      environment.SCOTTY_IMAGE_MANIFEST_PATH ?? "dist/release/scotty-image-manifest.json",
  });
  const repository = validatePublicationConfig({
    repository: input.repository,
    usernamePresent: true,
    tokenPresent: true,
  });
  const compatibility = await readImageCompatibility(root);
  const labels = decodeImageLabelsJson(await readFile(input.labelsPath, "utf8"));
  const manifest = makeImageReleaseManifest({
    releaseTag: input.releaseTag,
    repository,
    digest: input.digest,
    platform: input.platform,
    testedImageId: input.testedImageId,
    publicImageId: input.publicImageId,
    revision: input.revision,
    attestationUrl: input.attestationUrl,
    labels,
    compatibility,
  });
  manifest.runtimeCompatibility = signImageRuntimeCompatibility({
    imageDigest: input.digest,
    compatibility: {
      bunVersion: (await readFile(resolve(root, ".bun-version"), "utf8")).trim(),
      compileTarget: "bun-linux-x64-baseline",
      cpu: "x86-64-baseline",
      libc: "glibc",
      cloudflareSandbox: compatibility.cloudflareSandbox,
    },
    privateKeyPem: environment.SCOTTY_RELEASE_ED25519_PRIVATE_KEY,
  });
  const output = resolve(input.manifestPath);
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "--docker-push-digest") {
    if (!process.argv[3]) assert.fail("--docker-push-digest requires a Docker push log path.");
    process.stdout.write(
      `${parseDockerPushDigest(await readFile(process.argv[3], "utf8"), process.env.GITHUB_REF_NAME)}\n`,
    );
  } else {
    await makeImageRelease();
  }
}
