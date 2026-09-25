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
    expect(DEPLOYMENT_ENTRIES.map((entry) => entry.path)).toEqual([
      ...DEPLOYMENT_INPUTS.slice(0, 12),
      "worker/container",
      ...DEPLOYMENT_INPUTS.slice(12),
    ]);
    expect(DEPLOYMENT_INPUTS).toContain("worker/public");
    expect(DEPLOYMENT_INPUTS).toContain("worker/prebuilt");
    expect(ARCHIVE_PUBLIC_ASSETS).toEqual(["worker/public"]);
    expect(CONTAINER_INPUTS).not.toContain("worker/public");
    expect(CONTAINER_STATIC_INPUTS).not.toContain("worker/public");
    expect(CONTAINER_RUNTIME_ASSETS).toEqual(["worker/container"]);
    expect(CONTAINER_STATIC_INPUTS).toContain("worker/container");
    expect(DEPLOYMENT_INPUTS).not.toContain("worker/container");
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

  it("keeps the pinned Codex archive and excludes auth files", () => {
    const dockerfile = readFileSync(
      new URL("../../worker/container/Dockerfile", import.meta.url),
      "utf8",
    );
    expect(dockerfile).toContain(
      "https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(dockerfile).toContain(
      "fc6e3e3b85f2cf7d664520ee5c66a7fe4aa12bae7d46834f47e2f165fd0d6f78",
    );
    expect(dockerfile).toContain('version:"0.154.0"');
    expect(dockerfile).not.toMatch(/auth\.json/u);
  });
});
