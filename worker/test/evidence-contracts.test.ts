import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";
import {
  decodeBrowserEvidenceJob,
  decodeEvidenceStateResult,
  emptyEvidenceState,
} from "../src/evidence-contracts";

const step = {
  name: "Open the app",
  action: { kind: "goto", path: "/" },
  expect: [{ kind: "urlPath", expected: "/" }],
} as const;

describe("evidence contracts", () => {
  it("decodes the bounded declarative job without retaining excess input", () => {
    const decoded = decodeBrowserEvidenceJob({
      version: 1,
      port: 4_173,
      viewport: { width: 1_280, height: 720 },
      capture: { screenshots: "after-each-step", replay: true },
      steps: [step],
    });
    assert.ok(Option.isSome(decoded));
    assert.deepStrictEqual(decoded.value.steps[0], step);
  });

  it("rejects invalid ports, arbitrary paths, excess fields, and oversized graphs", () => {
    for (const input of [
      { version: 1, port: 80, steps: [step] },
      {
        version: 1,
        port: 4_173,
        steps: [{ ...step, action: { kind: "goto", path: "https://example.com" } }],
      },
      { version: 1, port: 4_173, steps: [step], targetOrigin: "https://example.com" },
      { version: 1, port: 4_173, steps: Array.from({ length: 13 }, () => step) },
    ]) {
      assert.ok(Option.isNone(decodeBrowserEvidenceJob(input)));
    }
  });

  it("keeps authoritative evidence state schema-owned", () => {
    const empty = emptyEvidenceState();
    assert.ok(Result.isSuccess(decodeEvidenceStateResult(empty)));
    assert.ok(
      Result.isFailure(
        decodeEvidenceStateResult({ ...empty, retainedBytes: -1, previewCookie: "secret" }),
      ),
    );
  });
});
