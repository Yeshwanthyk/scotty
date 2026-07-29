import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import {
  classifyPicanCreateResponse,
  decodePicanBootstrapResponseJson,
  picanCreateRequest,
  type PicanCreateResult,
} from "../src/pican";

const SESSION_ID = "a0b1c2d3e4f5";

describe("runner Pican contracts", () => {
  it("decodes only the bootstrap fields the Worker persists", () => {
    const valid = decodePicanBootstrapResponseJson(
      JSON.stringify({ defaultBranch: "main", repoExists: true }),
    );
    const invalid = decodePicanBootstrapResponseJson(
      JSON.stringify({ defaultBranch: "", repoExists: "yes" }),
    );

    assert.ok(Result.isSuccess(valid));
    assert.deepStrictEqual(valid.success, {
      defaultBranch: "main",
      repoExists: true,
    });
    assert.ok(Result.isFailure(invalid));
  });

  it("builds one idempotent hosted-session request for a trusted runner", async () => {
    const request = picanCreateRequest(
      "https://runner-pican.internal",
      SESSION_ID,
      "Investigate once",
    );

    assert.strictEqual(
      request.url,
      `https://runner-pican.internal/s/${SESSION_ID}/api/new-session`,
    );
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(request.headers.get("idempotency-key"), SESSION_ID);
    assert.strictEqual(
      await request.text(),
      JSON.stringify({
        path: `/workspace/${SESSION_ID}`,
        runtime: "codex",
        initialPrompt: "Investigate once",
      }),
    );
  });

  it("classifies the runner Pican create protocol exactly", () => {
    const cases: ReadonlyArray<{
      readonly status: number;
      readonly text: string;
      readonly expected: PicanCreateResult["state"];
    }> = [
      {
        status: 200,
        text: createResponse("created", "accepted"),
        expected: "stable",
      },
      {
        status: 202,
        text: createResponse("creating", "dispatching"),
        expected: "pending",
      },
      {
        status: 503,
        text: createResponse("unknown", "unknown"),
        expected: "unknown",
      },
      {
        status: 409,
        text: "conflict",
        expected: "conflict",
      },
      {
        status: 422,
        text: '{"unexpected":true}',
        expected: "invalid",
      },
      {
        status: 202,
        text: createResponse("created", "accepted"),
        expected: "invalid",
      },
    ];

    for (const testCase of cases) {
      assert.strictEqual(
        classifyPicanCreateResponse(testCase.status, testCase.text).state,
        testCase.expected,
      );
    }
  });
});

function createResponse(
  createState: "created" | "creating" | "unknown",
  promptDispatchState: "accepted" | "dispatching" | "not_requested" | "unknown",
): string {
  return JSON.stringify({
    id: "pican-session",
    nativeId: "codex-thread",
    runtime: "codex",
    createState,
    promptDispatchState,
  });
}
