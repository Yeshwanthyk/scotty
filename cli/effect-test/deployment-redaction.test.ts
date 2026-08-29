import { assert, describe, it } from "@effect/vitest";
import {
  buildSecretSet,
  redactProductionDeploymentOutput,
  redactWithSecretSet,
} from "../src/deployment-redaction.ts";

describe("deployment redaction", () => {
  it("deduplicates nonempty secrets and sorts them longest-first", () => {
    const secrets = buildSecretSet(["", "short", "long-secret", "short", "long-secret"]);

    assert.deepEqual(secrets, ["long-secret", "short"]);
    assert.equal(
      redactWithSecretSet("long-secret short", secrets),
      "[redacted-secret] [redacted-secret]",
    );
  });

  it("orders explicit and environment secrets together before redaction", () => {
    assert.equal(
      redactProductionDeploymentOutput("root-long-token", { SCOTTY_TOKEN: "root-long-token" }, [
        "token",
        "root-long-token",
      ]),
      "[redacted-secret]",
    );
  });
});
