import { readFileSync } from "node:fs";
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

const dockerfile = readFileSync(
  new URL("../../worker/container/Dockerfile", import.meta.url),
  "utf8",
);
const piProjectionScript = readFileSync(
  new URL("../../scripts/project-container-pi-install.mjs", import.meta.url),
  "utf8",
);
const containerImageCheck = readFileSync(
  new URL("../../scripts/check-container-image.mjs", import.meta.url),
  "utf8",
);

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
    expect(ARCHIVE_PUBLIC_ASSETS).toEqual(["worker/public"]);
    expect(CONTAINER_INPUTS).not.toContain("worker/public");
    expect(CONTAINER_STATIC_INPUTS).not.toContain("worker/public");
    expect(CONTAINER_RUNTIME_ASSETS).toEqual(["worker/container"]);
    expect(CONTAINER_STATIC_INPUTS).toContain("worker/container");
    expect(DEPLOYMENT_INPUTS).toContain("tui/src");
    expect(CONTAINER_INPUTS).toContain("tui/src");
    expect(CLI_SOURCE_TREES).toContain("tui/src");
    expect(CONTAINER_STATIC_INPUTS).not.toContain("tui/src");
  });

  it("covers every project COPY source across Dockerfile stages", () => {
    const sources = listDockerfileProjectCopySources(dockerfile);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toContain("tui/src");
    expect(sources).toContain("worker/container/toolsets/standard.json");
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
    expect(staticSources).not.toContain("tui/src");
    expect(staticSources).not.toContain("protocol/pi-console-shared.mjs");
    expect(metafileSources).toContain("tui/src");
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

  it("packages TUI package.json, patch files, and the apply script for container npm ci", () => {
    const files = [
      "tui/package.json",
      "scripts/apply-dependency-patches.mjs",
      "scripts/project-container-pi-install.mjs",
      "patches/alchemy+2.0.0-beta.72.patch",
      "patches/earendil-works+pi-coding-agent+0.84.0.patch",
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
    expect(dockerfile).toContain("COPY tui/package.json tui/package.json");
    expect(dockerfile).toContain(
      "COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs",
    );
    expect(dockerfile).toContain(
      "COPY patches/alchemy+2.0.0-beta.72.patch patches/alchemy+2.0.0-beta.72.patch",
    );
    expect(dockerfile).toContain(
      "COPY patches/earendil-works+pi-coding-agent+0.84.0.patch patches/earendil-works+pi-coding-agent+0.84.0.patch",
    );
    expect(dockerfile.indexOf("COPY tui/package.json tui/package.json")).toBeLessThan(npmCiIndex);
    expect(
      dockerfile.indexOf(
        "COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs",
      ),
    ).toBeLessThan(npmCiIndex);
    expect(
      dockerfile.indexOf(
        "COPY patches/alchemy+2.0.0-beta.72.patch patches/alchemy+2.0.0-beta.72.patch",
      ),
    ).toBeLessThan(npmCiIndex);
    expect(
      dockerfile.indexOf(
        "COPY patches/earendil-works+pi-coding-agent+0.84.0.patch patches/earendil-works+pi-coding-agent+0.84.0.patch",
      ),
    ).toBeLessThan(npmCiIndex);
    expect(dockerfile.indexOf("RUN node scripts/apply-dependency-patches.mjs")).toBeGreaterThan(
      npmCiIndex,
    );
    expect(dockerfile).toContain(
      "COPY scripts/project-container-pi-install.mjs scripts/project-container-pi-install.mjs",
    );
    expect(
      dockerfile.indexOf(
        "COPY scripts/project-container-pi-install.mjs scripts/project-container-pi-install.mjs",
      ),
    ).toBeLessThan(npmCiIndex);
    expect(dockerfile.indexOf("RUN bun build")).toBeGreaterThan(
      dockerfile.indexOf("RUN node scripts/apply-dependency-patches.mjs"),
    );
    expect(dockerfile).toContain(
      "COPY scripts/project-container-pi-install.mjs /tmp/project-container-pi-install.mjs",
    );
  });

  it("keeps recursive read-only chmod in the Pi/Playwright install layer and drops Codex CLI", () => {
    const installRun = dockerfile
      .split(/\n(?=RUN )/u)
      .find((block) => block.includes("playwright-core/cli.js") && block.includes("npm ci"));
    expect(installRun).toBeDefined();
    expect(installRun).toContain("chmod -R a-w /opt/scotty/pi-packages");
    expect(installRun).toContain("node /tmp/project-container-pi-install.mjs");
    expect(installRun).toContain("--assert-image");
    expect(installRun).not.toContain("claudeBackend|codexBackend|claude-agent-sdk");
    expect(piProjectionScript).toContain("export const assertPiSubagentsSource");
    expect(piProjectionScript).not.toContain("assertPiTasksSource");
    expect(piProjectionScript).not.toContain("PI_TASKS_SOURCE");
    expect(dockerfile.match(/--assert-image/gu)).toHaveLength(1);
    expect(containerImageCheck).not.toContain("--assert-image");
    expect(installRun).toContain("/usr/local/bin/scotty-pi-session");
    expect(installRun).not.toMatch(/^\s+\/usr\/local\/bin\/scotty\s*\\?$/mu);

    const finalRun = dockerfile
      .split(/\n(?=FROM )/u)
      .at(-1)
      ?.split(/\n(?=RUN )/u)
      .find((block) => block.includes("scotty tools list --json"));
    expect(finalRun).toBeDefined();
    expect(finalRun).not.toContain("chmod -R");
    expect(finalRun).toContain("! -type l -perm /222");
    expect(finalRun).toContain("python go gofmt git");
    expect(finalRun).toContain("if command -v codex");
    expect(finalRun).toContain("rm -rf /root/.cache /root/.npm /tmp/*");

    const cliBuildIndex = dockerfile.indexOf("chmod 0755 /out/scotty");
    expect(cliBuildIndex).toBeGreaterThan(-1);
    expect(cliBuildIndex).toBeLessThan(
      dockerfile.indexOf("COPY --from=scotty-cli-build /out/scotty"),
    );
    expect(dockerfile).toContain("ARG GO_VERSION=1.26.1");
    expect(dockerfile).not.toContain("ARG CODEX_VERSION=");
    expect(dockerfile).not.toContain("@openai/codex");
    expect(dockerfile).toContain("GO_VERSION=1.26.1");
    expect(dockerfile).toContain("PATH=/usr/local/go/bin:${PATH}");
    expect(dockerfile).toContain("pi-codex-compaction");
  });
});
