import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_INPUTS,
  DEPLOYMENT_ARCHIVE_NAME,
  DEPLOYMENT_INPUTS,
  isDeploymentArchiveFileName,
} from "../src/deployment-inputs.ts";

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

  it("packages the TUI source needed by the embedded CLI in every deployment context", () => {
    expect(DEPLOYMENT_INPUTS).toContain("tui/src");
    expect(CONTAINER_INPUTS).toContain("tui/src");
    expect(
      readFileSync(new URL("../../worker/container/Dockerfile", import.meta.url), "utf8"),
    ).toContain("COPY tui/src tui/src");
  });

  it("packages TUI package.json, patch files, and the apply script for container npm ci", () => {
    const files = [
      "tui/package.json",
      "scripts/apply-dependency-patches.mjs",
      "patches/alchemy+2.0.0-beta.67.patch",
      "patches/earendil-works+pi-coding-agent+0.84.0.patch",
    ] as const;
    for (const file of files) {
      expect(DEPLOYMENT_INPUTS).toContain(file);
      expect(CONTAINER_INPUTS).toContain(file);
    }
    const dockerfile = readFileSync(
      new URL("../../worker/container/Dockerfile", import.meta.url),
      "utf8",
    );
    const npmCiIndex = dockerfile.indexOf(
      "RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
    );
    expect(npmCiIndex).toBeGreaterThan(-1);
    expect(dockerfile).toContain("COPY tui/package.json tui/package.json");
    expect(dockerfile).toContain(
      "COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs",
    );
    expect(dockerfile).toContain(
      "COPY patches/alchemy+2.0.0-beta.67.patch patches/alchemy+2.0.0-beta.67.patch",
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
        "COPY patches/alchemy+2.0.0-beta.67.patch patches/alchemy+2.0.0-beta.67.patch",
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
    expect(dockerfile.indexOf("RUN bun build")).toBeGreaterThan(
      dockerfile.indexOf("RUN node scripts/apply-dependency-patches.mjs"),
    );
  });
});
