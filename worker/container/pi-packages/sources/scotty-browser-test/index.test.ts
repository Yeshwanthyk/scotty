import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import scottyBrowserTest, {
  BrowserEvidenceJobV1Parameters,
  runScottyBrowserTest,
  SCOTTY_BROWSER_TEST_MAX_BYTES,
  SCOTTY_BROWSER_TEST_ROUTE,
  serializeBrowserEvidenceJob,
} from "./index.ts";

const job = () => ({
  version: 1 as const,
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
  capture: { screenshots: "after-each-step" as const, replay: true },
});

const result = () => ({
  version: 1 as const,
  jobId: "job-abcd1234",
  status: "succeeded" as const,
  summaryUrl: "/s/abcdef123456/evidence/job-abcd1234",
  completedSteps: 1,
  frameCount: 1,
});

test("exposes only the bounded BrowserEvidenceJob v1 input", () => {
  assert.equal(Check(BrowserEvidenceJobV1Parameters, job()), true);
  assert.doesNotThrow(() => serializeBrowserEvidenceJob(job()));

  for (const field of [
    "url",
    "evaluate",
    "cdp",
    "cookies",
    "headers",
    "sessionId",
    "credential",
  ]) {
    const input = { ...job(), [field]: "forbidden" };
    assert.equal(Check(BrowserEvidenceJobV1Parameters, input), false, field);
    assert.throws(() => serializeBrowserEvidenceJob(input), /does not match/u);
  }

  for (const port of [1_023, 3_000, 43_117, 65_536]) {
    const input = { ...job(), port };
    assert.equal(Check(BrowserEvidenceJobV1Parameters, input), false, String(port));
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
    assert.equal(Check(BrowserEvidenceJobV1Parameters, input), false);
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
    version: 1 as const,
    port: 4_173,
    steps: Array.from({ length: 12 }, () => maximumStep),
  };
  assert.equal(Check(BrowserEvidenceJobV1Parameters, validButOversize), true);
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

test("registers exactly one scotty_browser_test tool", () => {
  const tools: Array<{ readonly name: string }> = [];
  const api = {
    registerTool(tool: { readonly name: string }) {
      tools.push(tool);
    },
  };
  scottyBrowserTest(api as ExtensionAPI);
  assert.deepEqual(tools.map(({ name }) => name), ["scotty_browser_test"]);
});
