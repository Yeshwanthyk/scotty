import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  IMAGE_PLATFORM,
  decodeImageLabelsJson,
  decodeImageReleaseEnvironment,
  makeImageReleaseManifest,
  parseDockerPushDigest,
  readImageCompatibility,
  validateImageReleaseTag,
  validatePublicationConfig,
} from "./make-image-release.mjs";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const digest = `sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;
const revision = "c".repeat(40);

const workflowRunScript = (workflow, stepName) => {
  const lines = workflow.split("\n");
  const stepIndex = lines.findIndex((line) => line === `      - name: ${stepName}`);
  assert.notEqual(stepIndex, -1, `missing workflow step: ${stepName}`);
  const runIndex = lines.findIndex((line, index) => index > stepIndex && line === "        run: |");
  assert.notEqual(runIndex, -1, `missing run script: ${stepName}`);
  const scriptLines = [];
  for (
    let index = runIndex + 1;
    index < lines.length && lines[index].startsWith("          ");
    index += 1
  )
    scriptLines.push(lines[index].slice(10));
  return `${scriptLines.join("\n")}\n`;
};

const runWorkflowScript = (script, environment) =>
  spawnSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });

const fixture = async () => {
  const compatibility = await readImageCompatibility();
  return {
    releaseTag: "v0.3.16",
    repository: "index.docker.io/example/scotty",
    digest,
    platform: IMAGE_PLATFORM,
    testedImageId: imageId,
    publicImageId: imageId,
    revision,
    attestationUrl: "https://github.com/example/scotty/attestations/123",
    compatibility,
    labels: {
      "org.opencontainers.image.revision": revision,
      "org.opencontainers.image.base.name": compatibility.cloudflareSandbox.image,
      "io.scotty.image.platform": IMAGE_PLATFORM,
      "io.scotty.compatibility.cloudflare-sandbox": compatibility.cloudflareSandbox.packageVersion,
      "io.scotty.compatibility.cloudflare-containers": compatibility.cloudflareContainers,
      "io.scotty.compatibility.alchemy": compatibility.alchemy,
      "io.scotty.compatibility.pi": compatibility.pi,
      "io.scotty.compatibility.codex": compatibility.codex,
      "io.scotty.compatibility.node": compatibility.node,
    },
  };
};

describe("S1 image release gate", () => {
  it("retains exact image compatibility metadata without changing the CLI manifest", async () => {
    const input = await fixture();
    const manifest = makeImageReleaseManifest(input);
    assert.deepEqual(manifest, {
      version: 1,
      releaseTag: input.releaseTag,
      image: {
        repository: input.repository,
        digest,
        reference: `${input.repository}@${digest}`,
        platform: "linux/amd64",
        configDigest: imageId,
        revision,
      },
      compatibility: {
        cloudflareSandbox: {
          packageVersion: "0.12.9",
          image:
            "docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe",
        },
        cloudflareContainers: "0.3.7",
        alchemy: "2.0.0-beta.76",
        pi: "0.84.0",
        codex: "0.154.0",
        codexArchiveSha256: "fc6e3e3b85f2cf7d664520ee5c66a7fe4aa12bae7d46834f47e2f165fd0d6f78",
        node: "24.21.0",
      },
      provenance: { attestationUrl: input.attestationUrl },
    });
    assert.doesNotMatch(read("scripts/make-cli-release.mjs"), /image|container|docker/iu);
  });

  it("rejects invalid or missing maintainer configuration", () => {
    assert.equal(validateImageReleaseTag("v0.3.16"), "v0.3.16");
    assert.throws(() => validateImageReleaseTag("v0.3.15"), /match the package version/u);
    assert.throws(() => validateImageReleaseTag("latest"), /match the package version/u);
    for (const repository of [
      undefined,
      "",
      "example/scotty",
      "docker.io/example/scotty",
      "index.docker.io/example/scotty:latest",
      "index.docker.io/example/scotty@sha256:abc",
    ]) {
      assert.throws(
        () => validatePublicationConfig({ repository, usernamePresent: true, tokenPresent: true }),
        /fully-qualified index\.docker\.io/u,
      );
    }
    assert.throws(
      () =>
        validatePublicationConfig({
          repository: "index.docker.io/example/scotty",
          usernamePresent: false,
          tokenPresent: true,
        }),
      /USERNAME is required/u,
    );
    assert.throws(
      () =>
        validatePublicationConfig({
          repository: "index.docker.io/example/scotty",
          usernamePresent: true,
          tokenPresent: false,
        }),
      /TOKEN is required/u,
    );
  });

  it("fails closed on digest, platform, identity, provenance, or label drift", async () => {
    const valid = await fixture();
    for (const patch of [
      { digest: "sha256:bad" },
      { platform: "linux/arm64" },
      { publicImageId: `sha256:${"d".repeat(64)}` },
      { attestationUrl: "" },
      { attestationUrl: "https://github.com/example/scotty/actions/runs/123" },
      { attestationUrl: "https://example.com/example/scotty/attestations/123" },
      { labels: { ...valid.labels, "io.scotty.compatibility.pi": "0.0.0" } },
    ]) {
      assert.throws(() => makeImageReleaseManifest({ ...valid, ...patch }));
    }
  });

  it("decodes only string-valued release labels from image inspection JSON", async () => {
    const valid = await fixture();
    const decoded = decodeImageLabelsJson(
      JSON.stringify({ ...valid.labels, untrusted: "ignored" }),
    );
    assert.deepEqual(decoded, valid.labels);
    for (const input of [
      "{",
      "null",
      "[]",
      JSON.stringify({ ...valid.labels, "io.scotty.compatibility.pi": null }),
      JSON.stringify({ ...valid.labels, "io.scotty.compatibility.pi": [] }),
      JSON.stringify({ ...valid.labels, "io.scotty.compatibility.pi": 84 }),
    ]) {
      assert.throws(() => decodeImageLabelsJson(input));
    }
  });

  it("strictly decodes manifest environment strings without retaining extra fields", () => {
    const valid = {
      releaseTag: "v0.3.16",
      repository: "index.docker.io/example/scotty",
      digest,
      platform: IMAGE_PLATFORM,
      testedImageId: imageId,
      publicImageId: imageId,
      revision,
      attestationUrl: "https://github.com/example/scotty/attestations/123",
      labelsPath: "/tmp/labels.json",
      manifestPath: "/tmp/manifest.json",
    };
    assert.deepEqual(decodeImageReleaseEnvironment({ ...valid, arbitrary: "ignored" }), valid);
    for (const patch of [
      { releaseTag: "latest" },
      { repository: "example/scotty" },
      { digest: "sha256:bad" },
      { platform: "linux/arm64" },
      { testedImageId: null },
      { publicImageId: [] },
      { revision: "short" },
      { attestationUrl: "https://github.com/example/scotty/actions/runs/123" },
      { labelsPath: "" },
      { manifestPath: 42 },
    ]) {
      assert.throws(() => decodeImageReleaseEnvironment({ ...valid, ...patch }));
    }
  });

  it("accepts only the immutable digest reported by the completed Docker push", () => {
    const output = `layer: pushed\nv0.3.16: digest: ${digest} size: 1234\n`;
    assert.equal(parseDockerPushDigest(output, "v0.3.16"), digest);
    for (const invalid of [
      "",
      `digest: ${digest} size: 1234\n`,
      `v0.3.15: digest: ${digest} size: 1234\n`,
      `v0.3.16: Digest: ${digest} size: 1234\n`,
      `v0.3.16: digest: ${digest} size: 0\n`,
      `v0.3.16: digest: sha256:bad size: 1234\n`,
      `${output}v0.3.16: digest: sha256:${"d".repeat(64)} size: 1234\n`,
    ]) {
      assert.throws(
        () => parseDockerPushDigest(invalid, "v0.3.16"),
        /exactly one immutable image digest/u,
      );
    }
  });

  it("initializes isolated Docker configuration before either image job uses Docker", () => {
    const workflow = read(".github/workflows/release-cli.yml");
    const imageStart = workflow.indexOf("  image:");
    const verifyStart = workflow.indexOf("  image-verify:");
    const attestStart = workflow.indexOf("  attest:");
    const imageJob = workflow.slice(imageStart, verifyStart);
    const verifyJob = workflow.slice(verifyStart, attestStart);

    assert.doesNotMatch(workflow, /DOCKER_CONFIG: \$\{\{ runner\.temp/u);
    assert.match(
      imageJob,
      /Initialize isolated Docker configuration[\s\S]*docker_config="\$RUNNER_TEMP\/scotty-docker-config"[\s\S]*rm -rf "\$docker_config"[\s\S]*install -d -m 0700 "\$docker_config"[\s\S]*echo "DOCKER_CONFIG=\$docker_config" >> "\$GITHUB_ENV"/u,
    );
    assert.ok(
      imageJob.indexOf("Initialize isolated Docker configuration") <
        imageJob.indexOf("actions/checkout@"),
    );
    assert.ok(
      imageJob.indexOf("Initialize isolated Docker configuration") <
        imageJob.indexOf("docker/setup-buildx-action@"),
    );
    assert.match(
      imageJob,
      /Remove any remaining publication credentials[\s\S]*if: always\(\)[\s\S]*if \[ -n "\$\{RUNNER_TEMP:-\}" \]; then[\s\S]*rm -rf "\$RUNNER_TEMP\/scotty-docker-config"/u,
    );

    assert.match(
      verifyJob,
      /Initialize anonymous Docker configuration[\s\S]*docker_config="\$RUNNER_TEMP\/scotty-public-pull-config"[\s\S]*rm -rf "\$docker_config"[\s\S]*install -d -m 0700 "\$docker_config"[\s\S]*echo "DOCKER_CONFIG=\$docker_config" >> "\$GITHUB_ENV"/u,
    );
    assert.ok(
      verifyJob.indexOf("Initialize anonymous Docker configuration") <
        verifyJob.indexOf("actions/checkout@"),
    );
    assert.ok(
      verifyJob.indexOf("Initialize anonymous Docker configuration") <
        verifyJob.indexOf("docker pull --platform"),
    );
    assert.match(verifyJob, /test ! -e "\$DOCKER_CONFIG\/config\.json"/u);
    assert.match(
      verifyJob,
      /Remove anonymous pull configuration[\s\S]*if: always\(\)[\s\S]*if \[ -n "\$\{RUNNER_TEMP:-\}" \]; then[\s\S]*rm -rf "\$RUNNER_TEMP\/scotty-public-pull-config"/u,
    );
  });

  it("cleans exact Docker configuration paths after normal and failed environment export", () => {
    const workflow = read(".github/workflows/release-cli.yml");
    for (const [initializeStep, cleanupStep, directoryName] of [
      [
        "Initialize isolated Docker configuration",
        "Remove any remaining publication credentials",
        "scotty-docker-config",
      ],
      [
        "Initialize anonymous Docker configuration",
        "Remove anonymous pull configuration",
        "scotty-public-pull-config",
      ],
    ]) {
      const initialize = workflowRunScript(workflow, initializeStep);
      const cleanup = workflowRunScript(workflow, cleanupStep);
      const root = mkdtempSync(join(tmpdir(), "scotty-docker-cleanup-"));
      try {
        const configPath = join(root, directoryName);
        const githubEnvironment = join(root, "github-environment");
        const environment = { GITHUB_ENV: githubEnvironment, RUNNER_TEMP: root };

        const initialized = runWorkflowScript(initialize, environment);
        assert.equal(initialized.status, 0, initialized.stderr);
        assert.equal(existsSync(configPath), true);
        const cleaned = runWorkflowScript(cleanup, environment);
        assert.equal(cleaned.status, 0, cleaned.stderr);
        assert.equal(existsSync(configPath), false);

        rmSync(githubEnvironment, { force: true });
        mkdirSync(githubEnvironment);
        const failed = runWorkflowScript(initialize, environment);
        assert.notEqual(failed.status, 0, "GITHUB_ENV append unexpectedly succeeded");
        assert.equal(existsSync(configPath), true);
        const cleanedAfterFailure = runWorkflowScript(cleanup, environment);
        assert.equal(cleanedAfterFailure.status, 0, cleanedAfterFailure.stderr);
        assert.equal(existsSync(configPath), false);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  });

  it("keeps credentials inside the authorized publication boundary", () => {
    const workflow = read(".github/workflows/release-cli.yml");
    const imageStart = workflow.indexOf("  image:");
    const verifyStart = workflow.indexOf("  image-verify:");
    const attestStart = workflow.indexOf("  attest:");
    const imageJob = workflow.slice(imageStart, verifyStart);
    const verifyJob = workflow.slice(verifyStart, attestStart);
    const buildStep = imageJob.slice(
      imageJob.indexOf("Build and test release image"),
      imageJob.indexOf("Publish tested image"),
    );
    assert.match(imageJob, /environment: image-release/u);
    assert.match(imageJob, /SCOTTY_IMAGE_PUBLICATION_AUTHORIZED/u);
    assert.match(imageJob, /publish-public-image/u);
    assert.equal((imageJob.match(/secrets\.SCOTTY_DOCKERHUB_USERNAME/gu) ?? []).length, 1);
    assert.equal((imageJob.match(/secrets\.SCOTTY_DOCKERHUB_TOKEN/gu) ?? []).length, 1);
    assert.doesNotMatch(buildStep, /DOCKERHUB|password|token/iu);
    assert.match(imageJob, /--password-stdin/u);
    assert.match(imageJob, /Remove publication credentials[\s\S]*rm -rf "\$DOCKER_CONFIG"/u);
    assert.match(imageJob, /docker push[\s\S]*scotty-image-push\.log/u);
    assert.match(imageJob, /--docker-push-digest/u);
    assert.doesNotMatch(imageJob, /imagetools inspect/u);
    assert.doesNotMatch(imageJob, /Create image release manifest/u);
    assert.ok(
      imageJob.indexOf("Publish tested image") <
        imageJob.indexOf("Attest published image provenance"),
    );
    assert.match(verifyJob, /needs: image/u);
    assert.match(verifyJob, /runs-on: ubuntu-latest/u);
    assert.doesNotMatch(verifyJob, /docker login|DOCKERHUB_(?:USERNAME|TOKEN)/u);
    assert.match(verifyJob, /test ! -e "\$DOCKER_CONFIG\/config\.json"/u);
    assert.match(verifyJob, /docker pull --platform "\$SCOTTY_IMAGE_PLATFORM" "\$image_ref"/u);
    assert.match(verifyJob, /test "\$public_id" = "\$SCOTTY_TESTED_IMAGE_ID"/u);
    assert.match(verifyJob, /gh attestation verify "oci:\/\/\$image_ref"/u);
    assert.match(verifyJob, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
    for (const flag of [
      "--bundle-from-oci",
      "--repo",
      "--signer-workflow",
      "--source-ref",
      "--source-digest",
      "--deny-self-hosted-runners",
    ])
      assert.ok(verifyJob.includes(flag), `missing attestation verification flag ${flag}`);
    assert.ok(
      verifyJob.indexOf("Verify anonymous public pull") <
        verifyJob.indexOf("Verify immutable image provenance"),
    );
    assert.ok(
      verifyJob.indexOf("Verify immutable image provenance") <
        verifyJob.indexOf("Create image release manifest"),
    );
    assert.match(workflow, /needs: \[attest, image-verify\]/u);
  });
});
