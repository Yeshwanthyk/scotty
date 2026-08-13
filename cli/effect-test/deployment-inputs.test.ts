import { describe, expect, it } from "vitest";
import { DEPLOYMENT_ARCHIVE_NAME, isDeploymentArchiveFileName } from "../src/deployment-inputs.ts";

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
});
