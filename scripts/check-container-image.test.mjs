import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CONTAINER_CONTEXT_PATH, CONTAINER_IMAGE_BUDGET } from "../cli/src/deployment-packaging.ts";
import { CLEAN_ROOM_CACHE_SCOPE, CLEAN_ROOM_CLI_TARGET } from "./check-cli-clean-room.mjs";
import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_ABSENT_PI_PACKAGES,
  CONTAINER_IMAGE_CACHE_SCOPE,
  CONTAINER_IMAGE_PI_PACKAGES,
  CONTAINER_IMAGE_PLATFORM,
  checkContainerImage,
  containerImageCodexPackagingArgs,
  containerImageCodexVersionArgs,
  containerImageBuildArgs,
  containerImageInspectArgs,
  containerImagePiPackagesSmokeArgs,
  containerImagePiVersionArgs,
  containerImagePlan,
} from "./check-container-image.mjs";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("final container image gate", () => {
  it("preserves the verified Codex archive and wires the bundled native host", () => {
    const dockerfile = read("worker/container/Dockerfile");
    const start = dockerfile.indexOf("# Pin evidence and root archive layout:");
    assert.ok(start >= 0);
    const install = dockerfile.slice(start, dockerfile.indexOf("RUN apt-get update", start));
    assert.ok(
      install.includes(
        "https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-package-x86_64-unknown-linux-musl.tar.gz",
      ),
    );
    const digest = "a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821";
    assert.ok(install.includes(`${digest}  /tmp/scotty-codex-install/codex.tar.gz`));
    const ordered = [
      "sha256sum --check --strict",
      "mkdir /opt/codex",
      "tar -xzf /tmp/scotty-codex-install/codex.tar.gz -C /opt/codex",
      'a.deepEqual(require("/opt/codex/codex-package.json"), {layoutVersion:1, version:"0.153.4", target:"x86_64-unknown-linux-musl", variant:"codex", entrypoint:"bin/codex", resourcesDir:"codex-resources", pathDir:"codex-path"})',
      "test -x /opt/codex/bin/codex-code-mode-host",
      "test -x /opt/codex/codex-path/rg",
      "test -x /opt/codex/codex-resources/bwrap",
      "test -x /opt/codex/codex-resources/zsh/bin/zsh",
      'test -z "$(find /opt/codex -perm /6000 -print -quit)"',
      "ln -s /opt/codex/bin/codex /usr/local/bin/codex",
      `test "$(stat -Lc '%a' /usr/local/bin/codex)" = "755"`,
      'test "$(env -i HOME=/tmp/scotty-codex-install/home CODEX_HOME=/tmp/scotty-codex-install/codex-home PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/codex --version)" = "codex-cli 0.153.4"',
      "rm -rf /tmp/scotty-codex-install",
    ];
    let previous = -1;
    for (const command of ordered) {
      const index = install.indexOf(command);
      assert.ok(index > previous, `missing or out-of-order: ${command}`);
      previous = index;
    }
    assert.doesNotMatch(install, /--strip-components|install -m|chmod.*[2467][0-7]{3}/u);
    assert.doesNotMatch(dockerfile, /if command -v codex|ARG CODEX/u);
    const aptInstall = dockerfile.slice(
      dockerfile.indexOf("RUN apt-get update"),
      dockerfile.indexOf("&& sed -i"),
    );
    assert.doesNotMatch(aptInstall, /\b(?:bubblewrap|bwrap)\b/u);
    assert.doesNotMatch(dockerfile, /--privileged|--cap-add|seccomp|chmod [2467][0-7]{3}/u);
    assert.match(dockerfile, /ARG PI_VERSION=0\.84\.0/u);
    assert.ok(
      dockerfile.includes(
        "RUN bun build worker/src/agent/codex/main.ts --target=node --format=esm --outfile=/out/scotty-codex-host.mjs",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "COPY --from=scotty-cli-build /out/scotty-codex-host.mjs /usr/local/bin/scotty-codex-host.mjs",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "COPY worker/container/scotty-codex-session.mjs /usr/local/bin/scotty-codex-session",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "RUN bun build worker/src/agent/codex/server.ts --target=node --format=esm --outfile=/out/scotty-codex-server.mjs",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "COPY --from=scotty-cli-build /out/scotty-codex-server.mjs /usr/local/bin/scotty-codex-server.mjs",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "COPY worker/container/scotty-codex-server.mjs /usr/local/bin/scotty-codex-server",
      ),
    );
    assert.equal(
      read("worker/container/scotty-codex-server.mjs"),
      '#!/usr/bin/env node\nimport { runServer } from "./scotty-codex-server.mjs";\n\nrunServer(process.argv.slice(2));\n',
    );
    assert.ok(
      containerImageCodexPackagingArgs(containerImagePlan())
        .join(" ")
        .includes("prepared-generation"),
    );
    assert.ok(dockerfile.includes('test "$(pi --version)" = "${PI_VERSION}"'));
    assert.match(
      dockerfile,
      /COPY worker\/container\/scotty-pi-session\.mjs \/usr\/local\/bin\/scotty-pi-session/u,
    );
    assert.doesNotMatch(install, /npm|auth\.json|app-server --listen/u);
  });

  it("builds and loads the final linux/amd64 image, then smokes Pi packages and inspects Size", async () => {
    const prepared = [];
    const dockerCalls = [];
    const inspected = [];
    const plan = await checkContainerImage({
      root: "/repo",
      environment: {},
      prepare: async (root) => {
        prepared.push(root);
      },
      docker: (command, args) => {
        dockerCalls.push({ command, args });
      },
      inspect: async (image, options) => {
        inspected.push({ image, options });
        return 1_038_798_880;
      },
    });

    assert.deepEqual(prepared, ["/repo"]);
    assert.equal(plan.context, `/repo/${CONTAINER_CONTEXT_PATH}`);
    assert.equal(plan.dockerfile, `/repo/${CONTAINER_CONTEXT_PATH}/worker/container/Dockerfile`);
    assert.equal(plan.platform, CONTAINER_IMAGE_PLATFORM);
    assert.equal(plan.image, CONTAINER_IMAGE);
    assert.equal(plan.target, undefined);
    assert.equal(plan.cache, undefined);
    assert.deepEqual(CONTAINER_IMAGE_PI_PACKAGES, ["scotty-browser-test", "scotty-hatch"]);
    assert.deepEqual(CONTAINER_IMAGE_ABSENT_PI_PACKAGES, [
      "pi-subagents",
      "@ogulcancelik/pi-codex-compaction",
      "pi-tasks",
      "pi-workflows",
      "pi-background-terminals",
      "pi-askuser",
      "pi-web-access",
      "pi-amp-ui",
    ]);
    assert.deepEqual(dockerCalls, [
      { command: "docker", args: containerImageBuildArgs(plan) },
      { command: "docker", args: containerImagePiVersionArgs(plan) },
      { command: "docker", args: containerImagePiPackagesSmokeArgs(plan) },
      { command: "docker", args: containerImageCodexVersionArgs(plan) },
      { command: "docker", args: containerImageCodexPackagingArgs(plan) },
    ]);
    assert.deepEqual(containerImageBuildArgs(plan), [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--load",
      "-t",
      "scotty-container:ci",
      "-f",
      plan.dockerfile,
      plan.context,
    ]);
    assert.equal(containerImageBuildArgs(plan).includes("--target"), false);
    assert.notEqual(CLEAN_ROOM_CLI_TARGET, undefined);
    assert.match(containerImagePiVersionArgs(plan).join(" "), /--entrypoint pi/u);
    const piPackagesSmokeCommand = containerImagePiPackagesSmokeArgs(plan).join(" ");
    assert.match(piPackagesSmokeCommand, /pi list/u);
    for (const name of CONTAINER_IMAGE_PI_PACKAGES) {
      assert.match(piPackagesSmokeCommand, new RegExp(name, "u"));
    }
    for (const name of CONTAINER_IMAGE_ABSENT_PI_PACKAGES) {
      assert.ok(
        piPackagesSmokeCommand.includes(
          `grep -F -- ${JSON.stringify(name)} /tmp/scotty-pi-packages.list`,
        ),
      );
      assert.ok(
        piPackagesSmokeCommand.includes(
          `test ! -e ${JSON.stringify(`/opt/scotty/pi-packages/sources/${name}`)}`,
        ),
      );
    }
    const dockerfile = read("worker/container/Dockerfile");
    assert.doesNotMatch(dockerfile, /project-container-pi-install/u);
    assert.match(dockerfile, /RUN mkdir -p \/workspace \/opt\/scotty\/skills/u);
    assert.doesNotMatch(dockerfile, /COPY worker\/container\/skills\/(?:bundled|licenses)/u);
    assert.match(
      dockerfile,
      /find \/opt\/scotty\/skills -mindepth 1 -maxdepth 1 -type d \| wc -l\)" -eq 0/u,
    );
    for (const name of CONTAINER_IMAGE_ABSENT_PI_PACKAGES) {
      assert.ok(piPackagesSmokeCommand.includes(`grep -F -- ${JSON.stringify(name)}`));
      assert.ok(
        piPackagesSmokeCommand.includes(
          `test ! -e ${JSON.stringify(`/opt/scotty/pi-packages/sources/${name}`)}`,
        ),
      );
      assert.ok(dockerfile.includes(name));
      assert.ok(
        piPackagesSmokeCommand.includes(
          `test ! -e ${JSON.stringify(`/opt/scotty/pi-packages/npm/node_modules/${name}`)}`,
        ),
      );
    }
    for (const name of CONTAINER_IMAGE_PI_PACKAGES) assert.ok(dockerfile.includes(name));
    assert.doesNotMatch(dockerfile, /locks\/pi-web-access\/package-lock\.json/u);
    const codexSmoke = containerImageCodexVersionArgs(plan).join(" ");
    assert.match(codexSmoke, /env -i HOME=\/tmp\/scotty-codex-smoke\/home CODEX_HOME=/u);
    assert.ok(codexSmoke.includes('/usr/local/bin/codex --version)" = "codex-cli 0.153.4"'));
    assert.ok(codexSmoke.includes(`stat -Lc '%a' /usr/local/bin/codex`));
    assert.ok(codexSmoke.includes("test -x /opt/codex/codex-resources/bwrap"));
    assert.ok(codexSmoke.includes("! command -v bwrap"));
    assert.ok(codexSmoke.includes("find /opt/codex -perm /6000"));
    assert.ok(codexSmoke.includes("! dpkg-query"));
    assert.doesNotMatch(codexSmoke, /--as-pid-1|--perms/u);
    assert.doesNotMatch(codexSmoke, /--volume|--mount|auth\.json|app-server/u);
    assert.deepEqual(containerImageInspectArgs(plan), [
      "image",
      "inspect",
      "scotty-container:ci",
      "--format",
      "{{.Size}}",
    ]);
    assert.deepEqual(
      inspected.map(({ image }) => image),
      ["scotty-container:ci"],
    );
    assert.deepEqual(inspected[0].options.inspectArgs, containerImageInspectArgs(plan));
  });

  it("fails closed when image inspect is missing or over budget", async () => {
    await assert.rejects(
      checkContainerImage({
        root: "/repo",
        environment: {},
        prepare: async () => {},
        docker: () => {},
        inspect: async () => {
          throw new Error(
            `Failed to ${CONTAINER_IMAGE_BUDGET.metric} for ${CONTAINER_IMAGE}: No such object`,
          );
        },
      }),
      /Failed to docker image inspect Size/u,
    );
    await assert.rejects(
      checkContainerImage({
        root: "/repo",
        environment: {},
        prepare: async () => {},
        docker: () => {},
        inspect: async () => {
          throw new Error(
            `Container image ${CONTAINER_IMAGE_BUDGET.metric} is ${CONTAINER_IMAGE_BUDGET.maxBytes + 1} bytes; budget is ${CONTAINER_IMAGE_BUDGET.maxBytes} bytes`,
          );
        },
      }),
      /docker image inspect Size is \d+ bytes; budget is/u,
    );
  });

  it("reuses the CLI-stage GHA cache and writes a distinct full-image scope", () => {
    const plan = containerImagePlan("/repo", {
      GITHUB_ACTIONS: "true",
      ACTIONS_CACHE_URL: "https://results.example/cache/",
    });
    assert.deepEqual(plan.cache, {
      from: [
        `type=gha,scope=${CONTAINER_IMAGE_CACHE_SCOPE}`,
        `type=gha,scope=${CLEAN_ROOM_CACHE_SCOPE}`,
      ],
      to: `type=gha,mode=max,scope=${CONTAINER_IMAGE_CACHE_SCOPE},ignore-error=true`,
    });
    const args = containerImageBuildArgs(plan);
    assert.equal(args.includes("--target"), false);
    assert.ok(args.includes("--cache-from"));
    assert.ok(args.includes("--cache-to"));
    assert.ok(args.includes(`type=gha,scope=${CLEAN_ROOM_CACHE_SCOPE}`));
    assert.ok(args.includes(`type=gha,scope=${CONTAINER_IMAGE_CACHE_SCOPE}`));
  });

  it("keeps the explicit full-image command available without running it in PR CI", () => {
    const pkg = JSON.parse(read("package.json"));
    const ci = read(".github/workflows/ci.yml");

    assert.equal(pkg.scripts["check:container-image"], "node scripts/check-container-image.mjs");
    assert.equal(pkg.scripts["check:cli-clean-room"], "node scripts/check-cli-clean-room.mjs");
    assert.doesNotMatch(pkg.scripts.check, /check:container-image/u);
    assert.doesNotMatch(pkg.scripts.check, /check:cli-clean-room/u);
    assert.match(ci, /npm run check:cli-clean-room/u);
    assert.match(ci, /cli-clean-room:/u);
    assert.doesNotMatch(ci, /container-image:/u);
    assert.doesNotMatch(ci, /npm run check:container-image/u);
  });
});
