import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import scottyBrowserTest, {
  BrowserEvidenceJobParameters,
  renderBrowserEvidenceResult,
  runScottyBrowserTest,
  SCOTTY_BROWSER_TEST_MAX_BYTES,
  SCOTTY_BROWSER_TEST_ROUTE,
  serializeBrowserEvidenceJob,
} from "./index.ts";

const job = () => ({
  port: 4_173,
  viewport: { width: 1_280, height: 720 },
  steps: [
    {
      name: "Open the home page",
      action: { kind: "goto" as const, path: "/" },
      expect: [
        { kind: "visible" as const, locator: { kind: "testId" as const, value: "home" } },
      ],
    },
  ],
  capture: { screenshots: "after-each-step" as const, video: true },
});

const result = () => ({
  jobId: "job-abcd1234",
  status: "succeeded" as const,
  summaryUrl: "/s/abcdef123456/evidence/job-abcd1234",
  completedSteps: 1,
  frameCount: 1,
  video: true,
});

test("exposes only the bounded BrowserEvidenceJob input", () => {
  assert.equal(Check(BrowserEvidenceJobParameters, job()), true);
  assert.doesNotThrow(() => serializeBrowserEvidenceJob(job()));

  for (const field of [
    "version",
    "url",
    "evaluate",
    "cdp",
    "cookies",
    "headers",
    "sessionId",
    "credential",
  ]) {
    const input = { ...job(), [field]: "forbidden" };
    assert.equal(Check(BrowserEvidenceJobParameters, input), false, field);
    assert.throws(() => serializeBrowserEvidenceJob(input), /does not match/u);
  }

  for (const port of [1_023, 3_000, 43_117, 65_536]) {
    const input = { ...job(), port };
    assert.equal(Check(BrowserEvidenceJobParameters, input), false, String(port));
  }
});

test("enforces every string and array bound plus the 64 KiB request cap", () => {
  const tooManySteps = {
    ...job(),
    steps: Array.from({ length: 13 }, () => job().steps[0]),
  };
  const tooManyAssertions = {
    ...job(),
    steps: [{
      ...job().steps[0],
      expect: Array.from({ length: 5 }, () => job().steps[0].expect[0]),
    }],
  };
  const longName = {
    ...job(),
    steps: [{ ...job().steps[0], name: "n".repeat(121) }],
  };
  const longLocator = {
    ...job(),
    steps: [{
      ...job().steps[0],
      expect: [{ kind: "visible" as const, locator: { kind: "css" as const, value: "x".repeat(513) } }],
    }],
  };
  const longPath = {
    ...job(),
    steps: [{ ...job().steps[0], action: { kind: "goto" as const, path: `/${"p".repeat(2_048)}` } }],
  };
  for (const input of [tooManySteps, tooManyAssertions, longName, longLocator, longPath]) {
    assert.equal(Check(BrowserEvidenceJobParameters, input), false);
  }

  const maximumStep = {
    name: "n".repeat(120),
    action: {
      kind: "fill" as const,
      locator: { kind: "css" as const, value: "x".repeat(512) },
      value: "v".repeat(4_096),
    },
    expect: Array.from({ length: 4 }, () => ({
      kind: "textExact" as const,
      locator: { kind: "css" as const, value: "x".repeat(512) },
      expected: "e".repeat(512),
    })),
  };
  const validButOversize = {
    port: 4_173,
    viewport: { width: 1_280, height: 720 },
    steps: Array.from({ length: 12 }, () => maximumStep),
    capture: { screenshots: "after-each-step" as const, video: true },
  };
  assert.equal(Check(BrowserEvidenceJobParameters, validButOversize), true);
  assert.ok(Buffer.byteLength(JSON.stringify(validButOversize), "utf8") > SCOTTY_BROWSER_TEST_MAX_BYTES);
  assert.throws(() => serializeBrowserEvidenceJob(validButOversize), /64 KiB/u);
});

test("posts only the decoded job to the exact internal route and returns safe metadata", async () => {
  let calls = 0;
  const output = await runScottyBrowserTest(job(), undefined, async (input, init) => {
    calls += 1;
    assert.equal(input, SCOTTY_BROWSER_TEST_ROUTE);
    assert.equal(init?.method, "POST");
    assert.deepEqual([...new Headers(init?.headers).entries()], [["content-type", "application/json"]]);
    assert.deepEqual(JSON.parse(String(init?.body)), job());
    assert.equal(String(init?.body).includes("sessionId"), false);
    assert.equal(String(init?.body).includes("credential"), false);
    return Response.json(result());
  });
  assert.equal(calls, 1);
  assert.deepEqual(output, result());
});

test("renders a port conflict with the distinct-target recovery hint", () => {
  const conflict = {
    ...result(),
    status: "failed" as const,
    completedSteps: 0,
    frameCount: 0,
    video: false,
    failure: { code: "port_conflict" as const },
  };
  assert.match(renderBrowserEvidenceResult(conflict), /Failure: port_conflict/u);
  assert.match(renderBrowserEvidenceResult(conflict), /different port from Hatch/u);
});

test("preserves a rejected preflight recovery hint", async () => {
  await assert.rejects(
    runScottyBrowserTest(job(), undefined, async () =>
      Response.json(
        {
          error: {
            code: "conflict",
            message: "Evidence target conflicts with Hatch",
            hint: "Use a distinct temporary app port.",
          },
        },
        { status: 409 },
      ),
    ),
    /Evidence target conflicts with Hatch[\s\S]*Recovery: Use a distinct temporary app port/u,
  );
});

test("rejects oversized, malformed, extra-field, and mismatched results", async () => {
  const replies = [
    new Response("x".repeat(SCOTTY_BROWSER_TEST_MAX_BYTES + 1)),
    Response.json({ ...result(), credential: "must-not-pass" }),
    Response.json({ ...result(), summaryUrl: "/s/abcdef123456/evidence/different-job" }),
    Response.json({ ...result(), summaryUrl: "https://example.com/evidence/job-abcd1234" }),
  ];
  for (const reply of replies) {
    await assert.rejects(
      runScottyBrowserTest(job(), undefined, async () => reply),
      /64 KiB|invalid result/u,
    );
  }
});

test("registers exactly one scotty_browser_test tool with safe reference guidance", () => {
  const tools: Array<{ readonly name: string; readonly promptGuidelines: readonly string[] }> = [];
  const api = {
    registerTool(tool: { readonly name: string; readonly promptGuidelines: readonly string[] }) {
      tools.push(tool);
    },
  };
  scottyBrowserTest(api as ExtensionAPI);
  assert.deepEqual(tools.map(({ name }) => name), ["scotty_browser_test"]);
  assert.match(tools[0]?.promptGuidelines.join("\n") ?? "", /exact scotty-evidence:<jobId>/u);
  assert.match(tools[0]?.promptGuidelines.join("\n") ?? "", /once/u);
  assert.match(
    tools[0]?.promptGuidelines.join("\n") ?? "",
    /do not publish the authenticated summary URL/u,
  );
});
