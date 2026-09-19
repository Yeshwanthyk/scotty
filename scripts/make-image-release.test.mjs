import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  validateImageRepository,
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
    releaseTag: "v0.3.19",
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
    assert.equal(validateImageReleaseTag("v0.3.19"), "v0.3.19");
    assert.throws(() => validateImageReleaseTag("v0.3.18"), /match the package version/u);
    assert.throws(() => validateImageReleaseTag("latest"), /match the package version/u);
    assert.equal(
      validateImageRepository("index.docker.io/example/scotty"),
      "index.docker.io/example/scotty",
    );
    for (const repository of [
      undefined,
      "",
      "example/scotty",
      "docker.io/example/scotty",
      "index.docker.io/example/scotty:latest",
      "index.docker.io/example/scotty@sha256:abc",
    ]) {
      assert.throws(
        () => validateImageRepository(repository),
        /fully-qualified index\.docker\.io/u,
      );
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
      releaseTag: "v0.3.19",
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
    const output = `layer: pushed\nv0.3.19: digest: ${digest} size: 1234\n`;
    assert.equal(parseDockerPushDigest(output, "v0.3.19"), digest);
    for (const invalid of [
      "",
      `digest: ${digest} size: 1234\n`,
      `v0.3.18: digest: ${digest} size: 1234\n`,
      `v0.3.19: Digest: ${digest} size: 1234\n`,
      `v0.3.19: digest: ${digest} size: 0\n`,
      `v0.3.19: digest: sha256:bad size: 1234\n`,
      `${output}v0.3.19: digest: sha256:${"d".repeat(64)} size: 1234\n`,
    ]) {
      assert.throws(
        () => parseDockerPushDigest(invalid, "v0.3.19"),
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
      /Initialize isolated Docker configuration[\s\S]*publish_root="\$RUNNER_TEMP\/scotty-image-publication"[\s\S]*rm -rf "\$publish_root"[\s\S]*install -d -m 0700 "\$publish_root" "\$publish_root\/\.docker"[\s\S]*echo "DOCKER_CONFIG=\$publish_root\/\.docker" >> "\$GITHUB_ENV"/u,
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
      /Remove any remaining publication credentials[\s\S]*if: always\(\)[\s\S]*rm -rf "\$RUNNER_TEMP\/scotty-image-publication"/u,
    );

    assert.match(
      verifyJob,
      /Initialize anonymous Docker configuration[\s\S]*verification_root="\$RUNNER_TEMP\/scotty-anonymous-verification"[\s\S]*docker_config="\$verification_root\/\.docker"[\s\S]*printf '%s\\n' '\{"auths":\{\}\}' > "\$docker_config\/config\.json"[\s\S]*chmod 0600 "\$docker_config\/config\.json"[\s\S]*echo "DOCKER_CONFIG=\$docker_config" >> "\$GITHUB_ENV"/u,
    );
    assert.ok(
      verifyJob.indexOf("Initialize anonymous Docker configuration") <
        verifyJob.indexOf("actions/checkout@"),
    );
    assert.ok(
      verifyJob.indexOf("Initialize anonymous Docker configuration") <
        verifyJob.indexOf("docker pull --platform"),
    );
    assert.equal((verifyJob.match(/assert\.equal\(isAnonymousConfig, true,/gu) ?? []).length, 2);
    assert.doesNotMatch(verifyJob, /JSON\.parse/u);
    assert.match(
      verifyJob,
      /Remove anonymous pull configuration[\s\S]*if: always\(\)[\s\S]*rm -rf "\$RUNNER_TEMP\/scotty-anonymous-verification"/u,
    );
  });

  it("cleans owned roots after normal and failed environment export", () => {
    const workflow = read(".github/workflows/release-cli.yml");
    for (const [initializeStep, cleanupStep, directoryName] of [
      [
        "Initialize isolated Docker configuration",
        "Remove any remaining publication credentials",
        "scotty-image-publication",
      ],
      [
        "Initialize anonymous Docker configuration",
        "Remove anonymous pull configuration",
        "scotty-anonymous-verification",
      ],
    ]) {
      const initialize = workflowRunScript(workflow, initializeStep);
      const cleanup = workflowRunScript(workflow, cleanupStep);
      const root = mkdtempSync(join(tmpdir(), "scotty-docker-cleanup-"));
      try {
        const ownedPath = join(root, directoryName);
        const configPath = join(ownedPath, ".docker");
        const githubEnvironment = join(root, "github-environment");
        const environment = { GITHUB_ENV: githubEnvironment, RUNNER_TEMP: root };

        const initialized = runWorkflowScript(initialize, environment);
        assert.equal(initialized.status, 0, initialized.stderr);
        assert.equal(existsSync(configPath), true);
        if (directoryName === "scotty-anonymous-verification") {
          assert.deepEqual(JSON.parse(readFileSync(join(configPath, "config.json"), "utf8")), {
            auths: {},
          });
        }
        const cleaned = runWorkflowScript(cleanup, environment);
        assert.equal(cleaned.status, 0, cleaned.stderr);
        assert.equal(existsSync(ownedPath), false);

        rmSync(githubEnvironment, { force: true });
        mkdirSync(githubEnvironment);
        const failed = runWorkflowScript(initialize, environment);
        assert.notEqual(failed.status, 0, "GITHUB_ENV append unexpectedly succeeded");
        assert.equal(existsSync(ownedPath), true);
        const cleanedAfterFailure = runWorkflowScript(cleanup, environment);
        assert.equal(cleanedAfterFailure.status, 0, cleanedAfterFailure.stderr);
        assert.equal(existsSync(ownedPath), false);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  });

  it("rejects polluted anonymous configuration before Docker or gh without leaking it", () => {
    const workflow = read(".github/workflows/release-cli.yml");
    const scripts = [
      workflowRunScript(
        workflow,
        "Verify anonymous public pull and tested identity on a fresh runner",
      ),
      workflowRunScript(workflow, "Verify immutable image provenance"),
    ];
    const root = mkdtempSync(join(tmpdir(), "scotty-anonymous-config-"));
    try {
      const bin = join(root, "bin");
      const verificationRoot = join(root, "scotty-anonymous-verification");
      const dockerConfig = join(verificationRoot, ".docker");
      const clientLog = join(root, "client-log");
      const syntheticUsername = "synthetic-user-must-not-leak";
      const syntheticPassword = "synthetic-password-must-not-leak";
      const syntheticAuth = Buffer.from(`${syntheticUsername}:${syntheticPassword}`).toString(
        "base64",
      );
      mkdirSync(bin);
      mkdirSync(verificationRoot);
      mkdirSync(dockerConfig);
      writeFileSync(
        join(dockerConfig, "config.json"),
        `${JSON.stringify({ auths: { "index.docker.io": { auth: syntheticAuth } } })}\n`,
      );
      for (const client of ["docker", "gh"]) {
        const executable = join(bin, client);
        writeFileSync(executable, `#!/bin/bash\nprintf '%s\\n' '${client}' >> "$CLIENT_LOG"\n`);
        chmodSync(executable, 0o755);
      }
      const environment = {
        CLIENT_LOG: clientLog,
        DOCKER_CONFIG: dockerConfig,
        HOME: verificationRoot,
        PATH: `${bin}:${process.env.PATH}`,
        SCOTTY_DOCKERHUB_REPOSITORY: "index.docker.io/example/scotty",
        SCOTTY_IMAGE_DIGEST: digest,
      };

      for (const script of scripts) {
        const result = runWorkflowScript(script, environment);
        assert.notEqual(result.status, 0, "polluted configuration unexpectedly passed");
        const output = `${result.stdout}\n${result.stderr}`;
        assert.match(output, /Anonymous Docker configuration is not empty/u);
        for (const secret of [syntheticUsername, syntheticPassword, syntheticAuth])
          assert.equal(output.includes(secret), false, "polluted credential leaked");
        assert.equal(existsSync(clientLog), false, "registry client ran before rejection");
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses canonical Docker Hub auth arguments and sends only the synthetic token on stdin", () => {
    const workflow = read(".github/workflows/release-cli.yml");
    const publish = workflowRunScript(workflow, "Publish tested image");
    const cleanup = workflowRunScript(workflow, "Remove publication credentials");
    const root = mkdtempSync(join(tmpdir(), "scotty-docker-auth-"));
    try {
      const bin = join(root, "bin");
      const publicationRoot = join(root, "scotty-image-publication");
      const dockerConfig = join(publicationRoot, ".docker");
      mkdirSync(bin);
      mkdirSync(publicationRoot);
      mkdirSync(dockerConfig);
      const docker = join(bin, "docker");
      writeFileSync(
        docker,
        `#!/bin/bash
set -euo pipefail
command="$1"
shift
printf '%s\\n' "$@" > "$STUB_LOG.$command.args"
case "$command" in
  login) cat > "$STUB_LOG.login.stdin" ;;
  push)
    reference=""
    for argument in "$@"; do reference="$argument"; done
    printf '%s: digest: sha256:%064d size: 1234\\n' "\${reference##*:}" 0
    ;;
esac
`,
      );
      chmodSync(docker, 0o755);
      const environment = {
        DOCKER_CONFIG: dockerConfig,
        GITHUB_OUTPUT: join(root, "github-output"),
        HOME: publicationRoot,
        GITHUB_REF_NAME: "v0.3.19",
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        SCOTTY_CONTAINER_IMAGE: "scotty-container:release",
        SCOTTY_DOCKERHUB_REPOSITORY: "index.docker.io/synthetic-user/scotty",
        SCOTTY_DOCKERHUB_TOKEN: "synthetic-token",
        SCOTTY_DOCKERHUB_USERNAME: "synthetic-user",
        SCOTTY_IMAGE_PLATFORM: IMAGE_PLATFORM,
        STUB_LOG: join(root, "docker"),
      };

      const published = runWorkflowScript(publish, environment);
      assert.equal(published.status, 0, published.stderr);
      assert.deepEqual(
        readFileSync(`${environment.STUB_LOG}.login.args`, "utf8").trim().split("\n"),
        ["--username", "synthetic-user", "--password-stdin"],
      );
      assert.equal(readFileSync(`${environment.STUB_LOG}.login.stdin`, "utf8"), "synthetic-token");
      assert.doesNotMatch(
        readFileSync(`${environment.STUB_LOG}.login.args`, "utf8"),
        /index\.docker\.io|synthetic-token/u,
      );
      assert.match(readFileSync(environment.GITHUB_OUTPUT, "utf8"), /^digest=sha256:[0-9]{64}$/mu);

      const cleaned = runWorkflowScript(cleanup, environment);
      assert.equal(cleaned.status, 0, cleaned.stderr);
      assert.equal(readFileSync(`${environment.STUB_LOG}.logout.args`, "utf8").trim(), "");
      assert.equal(existsSync(publicationRoot), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps credentials inside the authorized publication boundary", () => {
    const workflow = read(".github/workflows/release-cli.yml");
    const imageStart = workflow.indexOf("  image:");
    const verifyStart = workflow.indexOf("  image-verify:");
    const attestStart = workflow.indexOf("  attest:");
    const imageJob = workflow.slice(imageStart, verifyStart);
    const verifyJob = workflow.slice(verifyStart, attestStart);
    const imageOutputs = imageJob.slice(
      imageJob.indexOf("    outputs:"),
      imageJob.indexOf("    permissions:"),
    );
    const buildStep = imageJob.slice(
      imageJob.indexOf("Build and test release image"),
      imageJob.indexOf("Publish tested image"),
    );
    const publishStep = imageJob.slice(
      imageJob.indexOf("Publish tested image"),
      imageJob.indexOf("Attest published image provenance"),
    );
    const attestationStep = imageJob.slice(
      imageJob.indexOf("Attest published image provenance"),
      imageJob.indexOf("Record image attestation receipt"),
    );
    assert.match(imageJob, /environment: image-release/u);
    assert.match(imageJob, /SCOTTY_IMAGE_PUBLICATION_AUTHORIZED/u);
    assert.match(imageJob, /publish-public-image/u);
    assert.equal((imageJob.match(/secrets\.SCOTTY_DOCKERHUB_USERNAME/gu) ?? []).length, 1);
    assert.equal((imageJob.match(/secrets\.SCOTTY_DOCKERHUB_TOKEN/gu) ?? []).length, 1);
    assert.doesNotMatch(buildStep, /HOME:|DOCKERHUB|password|token/iu);
    assert.match(publishStep, /HOME: \$\{\{ runner\.temp \}\}\/scotty-image-publication/u);
    assert.match(
      attestationStep,
      /actions\/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a[\s\S]*HOME: \$\{\{ runner\.temp \}\}\/scotty-image-publication/u,
    );
    assert.equal(
      (imageJob.match(/HOME: \$\{\{ runner\.temp \}\}\/scotty-image-publication/gu) ?? []).length,
      3,
    );
    assert.match(imageJob, /--password-stdin/u);
    assert.match(
      imageJob,
      /docker login \\\n\s+--username "\$SCOTTY_DOCKERHUB_USERNAME" --password-stdin/u,
    );
    assert.doesNotMatch(imageJob, /docker login index\.docker\.io/u);
    assert.match(imageJob, /docker logout \|\| true/u);
    assert.doesNotMatch(imageJob, /docker logout index\.docker\.io/u);
    assert.match(imageOutputs, /digest: \$\{\{ steps\.published-image\.outputs\.digest \}\}/u);
    assert.match(imageOutputs, /tested_image_id:/u);
    assert.match(imageJob, /tested_image_id[\s\S]*\^sha256:\[0-9a-f\]\{64\}\$/u);
    assert.doesNotMatch(imageOutputs, /repository|attestation/u);
    assert.match(imageJob, /name: image-attestation-receipt/u);
    assert.match(
      imageJob,
      /Remove publication credentials[\s\S]*rm -rf "\$RUNNER_TEMP\/scotty-image-publication"/u,
    );
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
    assert.match(verifyJob, /environment: image-release/u);
    assert.match(
      verifyJob,
      /SCOTTY_DOCKERHUB_REPOSITORY: \$\{\{ vars\.SCOTTY_DOCKERHUB_REPOSITORY \}\}/u,
    );
    assert.doesNotMatch(
      verifyJob,
      /needs\.image\.outputs\.(?:repository|attestation_url)|secrets\.SCOTTY_DOCKERHUB/u,
    );
    assert.equal(
      (verifyJob.match(/HOME: \$\{\{ runner\.temp \}\}\/scotty-anonymous-verification/gu) ?? [])
        .length,
      2,
    );
    assert.match(verifyJob, /validateImageRepository/u);
    assert.ok(
      verifyJob.indexOf("Validate maintainer repository for anonymous verification") <
        verifyJob.indexOf("docker pull --platform"),
    );
    assert.match(verifyJob, /name: image-attestation-receipt/u);
    assert.match(
      verifyJob,
      /SCOTTY_IMAGE_ATTESTATION_URL="\$\(cat dist\/image-attestation\/scotty-image-attestation-url\)"/u,
    );
    assert.doesNotMatch(verifyJob, /docker login|DOCKERHUB_(?:USERNAME|TOKEN)/u);
    assert.equal((verifyJob.match(/assert\.equal\(isAnonymousConfig, true,/gu) ?? []).length, 2);
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
