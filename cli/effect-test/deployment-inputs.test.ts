import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_PUBLIC_ASSETS,
  CLI_SOURCE_TREES,
  CONTAINER_INPUTS,
  CONTAINER_RUNTIME_ASSETS,
  CONTAINER_STATIC_INPUTS,
  DEPLOYMENT_ARCHIVE_NAME,
  DEPLOYMENT_ENTRIES,
  DEPLOYMENT_EXCLUSIONS,
  DEPLOYMENT_INPUTS,
  DEPLOYMENT_PACKAGING,
  isCoveredByProjectInputs,
  isDeploymentArchiveFileName,
} from "../src/deployment-packaging.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const dockerfile = readFileSync(
  new URL("../../worker/container/Dockerfile", import.meta.url),
  "utf8",
);

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const listFiles = (path: string): string[] => {
  const absolute = join(repositoryRoot, path);
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = normalizePath(join(path, entry.name));
    return entry.isDirectory() ? listFiles(child) : [child];
  });
};

const listBundledScriptImports = (): string[] => {
  const pending = CLI_SOURCE_TREES.flatMap(listFiles);
  const visited = new Set<string>();
  const scripts = new Set<string>();
  while (pending.length > 0) {
    const source = pending.pop();
    if (source === undefined || visited.has(source)) continue;
    visited.add(source);
    const contents = readFileSync(join(repositoryRoot, source), "utf8");
    for (const match of contents.matchAll(/\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (!specifier?.startsWith(".")) continue;
      const target = normalizePath(
        relative(repositoryRoot, resolve(repositoryRoot, dirname(source), specifier)),
      );
      if (!target.startsWith("scripts/") || !existsSync(join(repositoryRoot, target))) continue;
      scripts.add(target);
      pending.push(target);
    }
  }
  return [...scripts].sort();
};

const listDockerfileProjectCopySources = (source: string): string[] => {
  const sources: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("COPY ") || trimmed.startsWith("COPY --from=")) continue;
    const tokens = trimmed
      .slice("COPY ".length)
      .split(/\s+/u)
      .filter((token) => !token.startsWith("--"));
    sources.push(...tokens.slice(0, -1));
  }
  return sources;
};

describe("standalone deployment archive", () => {
  it("accepts source and Bun cache-suffixed embedded filenames", () => {
    expect(isDeploymentArchiveFileName(DEPLOYMENT_ARCHIVE_NAME)).toBe(true);
    expect(isDeploymentArchiveFileName("scotty-deployment-a1b2c3.tar.gz")).toBe(true);
    expect(isDeploymentArchiveFileName("scotty-deployment.tar-dbwdbt0c.gz")).toBe(true);
  });

  it("rejects unrelated embedded files", () => {
    expect(isDeploymentArchiveFileName("other.tar-dbwdbt0c.gz")).toBe(false);
    expect(isDeploymentArchiveFileName("scotty-deployment.zip")).toBe(false);
    expect(isDeploymentArchiveFileName("scotty-deployment.tar-../../secret.gz")).toBe(false);
  });

  it("projects archive, container, and CLI source lists from one catalog", () => {
    expect(DEPLOYMENT_PACKAGING.exclusions).toEqual(["node_modules", ".git"]);
    expect(DEPLOYMENT_EXCLUSIONS).toEqual(["node_modules", ".git"]);
    expect(DEPLOYMENT_PACKAGING.contextPath).toBe(".alchemy/scotty-container-context");
    expect(DEPLOYMENT_ENTRIES.map((entry) => entry.path)).toEqual(DEPLOYMENT_INPUTS);
    expect(DEPLOYMENT_INPUTS).toContain("worker/public");
    expect(DEPLOYMENT_INPUTS).toContain("worker/prebuilt");
    expect(ARCHIVE_PUBLIC_ASSETS).toEqual(["worker/public"]);
    expect(CONTAINER_INPUTS).not.toContain("worker/public");
    expect(CONTAINER_STATIC_INPUTS).not.toContain("worker/public");
    expect(CONTAINER_RUNTIME_ASSETS).toEqual(["worker/container"]);
    expect(CONTAINER_STATIC_INPUTS).toContain("worker/container");
    expect(DEPLOYMENT_INPUTS).not.toContain("tui/package.json");
    expect(DEPLOYMENT_INPUTS).not.toContain("tui/src");
    expect(CONTAINER_INPUTS).not.toContain("tui/package.json");
    expect(CONTAINER_INPUTS).not.toContain("tui/src");
    expect(CLI_SOURCE_TREES).not.toContain("tui/src");
    expect(CONTAINER_STATIC_INPUTS).not.toContain("tui/src");
    expect(DEPLOYMENT_INPUTS).not.toContain("patches/earendil-works+pi-coding-agent+0.84.0.patch");
    expect(CONTAINER_INPUTS).not.toContain("patches/earendil-works+pi-coding-agent+0.84.0.patch");
    expect(CONTAINER_STATIC_INPUTS).not.toContain(
      "patches/earendil-works+pi-coding-agent+0.84.0.patch",
    );
    expect(CONTAINER_STATIC_INPUTS).toContain("worker/container");
    expect(
      isCoveredByProjectInputs(
        "worker/container/pi-packages/sources/scotty-hatch/package-lock.json",
        CONTAINER_STATIC_INPUTS,
      ),
    ).toBe(true);
  });

  it("covers every project COPY source across Dockerfile stages", () => {
    const sources = listDockerfileProjectCopySources(dockerfile);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).not.toContain("tui/package.json");
    expect(sources).not.toContain("tui/src");
    expect(sources).not.toContain("patches/earendil-works+pi-coding-agent+0.84.0.patch");
    expect(sources).toContain("worker/container/toolsets/standard.json");
    expect(
      sources.filter((source) => source === "worker/container/toolsets/standard.json"),
    ).toEqual(["worker/container/toolsets/standard.json"]);
    const packageImageStart = dockerfile.indexOf("AS scotty-package-image");
    const finalImageStart = dockerfile.lastIndexOf("FROM scotty-package-image");
    const finalManifestCopy =
      "COPY worker/container/toolsets/standard.json /opt/scotty/toolsets/standard.json";
    const finalManifestCopyIndex = dockerfile.indexOf(finalManifestCopy);
    expect(packageImageStart).toBeGreaterThan(-1);
    expect(finalImageStart).toBeGreaterThan(packageImageStart);
    expect(finalManifestCopyIndex).toBeGreaterThan(packageImageStart);
    expect(finalManifestCopyIndex).toBeLessThan(finalImageStart);
    expect(dockerfile.slice(0, packageImageStart)).not.toContain(
      "COPY worker/container/toolsets/standard.json",
    );
    expect(sources).toContain("protocol/pi-console-shared.mjs");
    expect(sources).toContain("worker/container/pi-packages");
    expect(sources).toContain("package.json");

    const staticSources = sources.filter((source) =>
      isCoveredByProjectInputs(source, CONTAINER_STATIC_INPUTS),
    );
    const metafileSources = sources.filter((source) =>
      isCoveredByProjectInputs(source, CLI_SOURCE_TREES),
    );
    expect(staticSources).toContain("package.json");
    expect(staticSources).toContain("worker/container/toolsets/standard.json");
    expect(staticSources).toContain("worker/container/pi-packages");
    expect(staticSources).not.toContain("tui/package.json");
    expect(staticSources).not.toContain("tui/src");
    expect(staticSources).not.toContain("protocol/pi-console-shared.mjs");
    expect(metafileSources).not.toContain("tui/src");
    expect(metafileSources).toContain("cli/src");
    expect(metafileSources).toContain("protocol/pi-console-shared.mjs");
    expect(metafileSources).not.toContain("package.json");
    expect(metafileSources).not.toContain("worker/container/toolsets/standard.json");

    for (const source of sources) {
      const staticCovered = isCoveredByProjectInputs(source, CONTAINER_STATIC_INPUTS);
      const cliCovered = isCoveredByProjectInputs(source, CLI_SOURCE_TREES);
      expect(staticCovered || cliCovered).toBe(true);
      expect(isCoveredByProjectInputs(source, CONTAINER_INPUTS)).toBe(true);
      expect(isCoveredByProjectInputs(source, DEPLOYMENT_INPUTS)).toBe(true);
    }
  });

  it("packages maintainer scripts, package metadata, and patches for the compiled CLI", () => {
    const files = [
      "scripts/apply-dependency-patches.mjs",
      "scripts/container-control-plane.mjs",
      "scripts/deploy-production.mjs",
      "scripts/is-direct-run.mjs",
      "patches/@cloudflare+sandbox+0.12.9.patch",
      "patches/alchemy+2.0.0-beta.76.patch",
      "patches/@alchemy.run+cloudflare-runtime+2.0.0-beta.76.patch",
    ] as const;
    for (const file of files) {
      expect(DEPLOYMENT_INPUTS).toContain(file);
      expect(CONTAINER_INPUTS).toContain(file);
      expect(CONTAINER_STATIC_INPUTS).toContain(file);
    }
    const npmCiIndex = dockerfile.indexOf(
      "RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
    );
    expect(npmCiIndex).toBeGreaterThan(-1);
    expect(dockerfile).not.toContain("COPY tui/package.json tui/package.json");
    expect(dockerfile).not.toContain("COPY tui/src tui/src");
    expect(dockerfile).toContain(
      "COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs",
    );
    expect(dockerfile).toContain(
      "COPY patches/@cloudflare+sandbox+0.12.9.patch patches/@cloudflare+sandbox+0.12.9.patch",
    );
    expect(dockerfile).toContain(
      "COPY patches/alchemy+2.0.0-beta.76.patch patches/alchemy+2.0.0-beta.76.patch",
    );
    expect(dockerfile).toContain(
      "COPY patches/@alchemy.run+cloudflare-runtime+2.0.0-beta.76.patch patches/@alchemy.run+cloudflare-runtime+2.0.0-beta.76.patch",
    );
    expect(
      dockerfile.indexOf(
        "COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs",
      ),
    ).toBeLessThan(npmCiIndex);
    expect(
      dockerfile.indexOf(
        "COPY patches/@cloudflare+sandbox+0.12.9.patch patches/@cloudflare+sandbox+0.12.9.patch",
      ),
    ).toBeLessThan(npmCiIndex);
    expect(
      dockerfile.indexOf(
        "COPY patches/alchemy+2.0.0-beta.76.patch patches/alchemy+2.0.0-beta.76.patch",
      ),
    ).toBeLessThan(npmCiIndex);
    expect(
      dockerfile.indexOf(
        "COPY patches/@alchemy.run+cloudflare-runtime+2.0.0-beta.76.patch patches/@alchemy.run+cloudflare-runtime+2.0.0-beta.76.patch",
      ),
    ).toBeLessThan(npmCiIndex);
    expect(dockerfile.indexOf("RUN node scripts/apply-dependency-patches.mjs")).toBeGreaterThan(
      npmCiIndex,
    );
    expect(dockerfile).toContain("COPY scripts/is-direct-run.mjs scripts/is-direct-run.mjs");
    expect(dockerfile.indexOf("RUN bun build")).toBeGreaterThan(
      dockerfile.indexOf("RUN node scripts/apply-dependency-patches.mjs"),
    );
    expect(dockerfile).not.toContain("COPY scripts/is-direct-run.mjs /tmp/is-direct-run.mjs");
  });

  it("catalogs and COPYs every maintainer script reachable from the bundled source graph", () => {
    const bundledScripts = listBundledScriptImports();
    expect(bundledScripts).toEqual(
      expect.arrayContaining([
        "scripts/container-control-plane.mjs",
        "scripts/deploy-production.mjs",
        "scripts/is-direct-run.mjs",
      ]),
    );

    const compileIndex = dockerfile.indexOf("RUN bun build");
    expect(compileIndex).toBeGreaterThan(-1);
    const cliBuildStage = dockerfile.slice(0, compileIndex);
    for (const script of bundledScripts) {
      const entry = DEPLOYMENT_ENTRIES.find((candidate) => candidate.path === script);
      expect(entry?.categories).toEqual(expect.arrayContaining(["archive", "containerStatic"]));
      expect(cliBuildStage).toContain(`COPY ${script} ${script}`);
    }
  });

  it("keeps Pi/Playwright read-only and installs the complete pinned Codex package and server", () => {
    const installRun = dockerfile
      .split(/\n(?=RUN )/u)
      .find((block) => block.includes("playwright-core/cli.js") && block.includes("npm ci"));
    expect(installRun).toBeDefined();
    expect(installRun).toContain(
      "chmod -R a-w /opt/scotty/pi-packages /opt/scotty/playwright-browsers",
    );
    expect(installRun).not.toContain("/usr/local/bin/scotty-codex-session");
    expect(installRun).toContain("/usr/local/bin/scotty-codex-server");
    expect(installRun).toContain("install --with-deps --no-shell chromium");
    expect(installRun).toContain("-name '*.test.ts'");
    expect(installRun).toContain("-name tsconfig.json");
    expect(installRun).toContain("-name .gitignore");
    expect(installRun).not.toContain("claudeBackend|codexBackend|claude-agent-sdk");
    expect(dockerfile).not.toContain("--assert-image");
    expect(installRun).toContain("/usr/local/bin/scotty-pi-session");
    expect(installRun).not.toMatch(/^\s+\/usr\/local\/bin\/scotty\s*\\?$/mu);

    const finalRun = dockerfile
      .split(/\n(?=FROM )/u)
      .at(-1)
      ?.split(/\n(?=RUN )/u)
      .find(
        (block) =>
          block.includes('test "$(stat -c \'%a\' /usr/local/bin/scotty)" = "755"') &&
          block.includes('test "$(pi --version)" = "${PI_VERSION}"'),
      );
    expect(finalRun).toBeDefined();
    expect(finalRun).not.toContain("chmod -R");
    expect(finalRun).toContain("scotty --version");
    expect(finalRun).toContain("! -type l -perm /222");
    expect(finalRun).toContain("python git gh shellcheck");
    expect(finalRun).not.toMatch(/\bgo(?:fmt)?\b/u);
    expect(finalRun).toContain("pi codex scotty scotty-codex-server scotty-pi-session");
    expect(finalRun).toContain(
      'test "$(stat -c \'%a\' /usr/local/bin/scotty-codex-server)" = "755"',
    );
    expect(finalRun).toContain("node --check /usr/local/bin/scotty-codex-server");
    expect(finalRun).toContain("node --check /usr/local/bin/scotty-codex-server.mjs");
    expect(finalRun).toContain("rm -rf /root/.cache /root/.npm /tmp/*");

    const codexInstall = dockerfile
      .split(/\n(?=RUN )/u)
      .find((block) => block.includes("mkdir /opt/codex"));
    expect(codexInstall).toBeDefined();
    const pinnedCommands = [
      '"https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-package-x86_64-unknown-linux-musl.tar.gz"',
      'echo "a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821  /tmp/scotty-codex-install/codex.tar.gz" | sha256sum --check --strict',
      "mkdir /opt/codex",
      "tar -xzf /tmp/scotty-codex-install/codex.tar.gz -C /opt/codex",
      'a.deepEqual(require("/opt/codex/codex-package.json"), {layoutVersion:1, version:"0.153.4", target:"x86_64-unknown-linux-musl", variant:"codex", entrypoint:"bin/codex", resourcesDir:"codex-resources", pathDir:"codex-path"})',
      "test -x /opt/codex/bin/codex-code-mode-host",
      "test -x /opt/codex/codex-path/rg",
      "test -x /opt/codex/codex-resources/bwrap",
      "test -x /opt/codex/codex-resources/zsh/bin/zsh",
      'test -z "$(find /opt/codex -perm /6000 -print -quit)"',
      "ln -s /opt/codex/bin/codex /usr/local/bin/codex",
      'test "$(stat -Lc \'%a\' /usr/local/bin/codex)" = "755"',
      'test "$(env -i HOME=/tmp/scotty-codex-install/home CODEX_HOME=/tmp/scotty-codex-install/codex-home PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/codex --version)" = "codex-cli 0.153.4"',
      "rm -rf /tmp/scotty-codex-install",
    ];
    let previous = -1;
    for (const command of pinnedCommands) {
      const index = codexInstall?.indexOf(command) ?? -1;
      expect(index, command).toBeGreaterThan(previous);
      previous = index;
    }
    expect(codexInstall).not.toMatch(/--strip-components|npm|auth\.json|app-server --listen/u);
    expect(dockerfile).not.toMatch(
      /if command -v codex|--privileged|--cap-add|seccomp|chmod [2467][0-7]{3}/u,
    );
    expect(dockerfile).toContain(
      "RUN bun build worker/src/agent/codex/server.ts --target=node --format=esm --outfile=/out/scotty-codex-server.mjs",
    );
    expect(dockerfile).toContain(
      "COPY --from=scotty-cli-build /out/scotty-codex-server.mjs /usr/local/bin/scotty-codex-server.mjs",
    );
    expect(dockerfile).toContain(
      "COPY worker/container/scotty-codex-server.mjs /usr/local/bin/scotty-codex-server",
    );
    expect(dockerfile).not.toMatch(/scotty-codex-(?:host|session)/u);

    const cliBuildIndex = dockerfile.indexOf("chmod 0755 /out/scotty");
    expect(cliBuildIndex).toBeGreaterThan(-1);
    expect(cliBuildIndex).toBeLessThan(
      dockerfile.indexOf("COPY --from=scotty-cli-build /out/scotty"),
    );
    expect(dockerfile).not.toContain("ARG GO_VERSION=");
    expect(dockerfile).not.toContain("ARG GO_SHA256=");
    expect(dockerfile).not.toContain("ARG CODEX_VERSION=");
    expect(dockerfile).not.toContain("@openai/codex");
    expect(dockerfile).not.toContain("go.dev/dl/");
    expect(dockerfile).not.toContain("/usr/local/go/bin");
    expect(dockerfile).not.toContain("GOTOOLCHAIN=");
    expect(dockerfile).not.toContain("GOPROXY=");
    expect(dockerfile).not.toContain("GOSUMDB=");
    expect(dockerfile).toContain("@ogulcancelik/pi-codex-compaction");
    expect(dockerfile).toContain("test ! -e");
  });
});
