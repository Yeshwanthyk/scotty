import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserEvidenceJob } from "./index.ts";
import {
  runBrowserEvidenceJob,
  runBrowserTestCli,
  serializeRunnerManifest,
  type BrowserTestRuntime,
  type RunnerLocator,
} from "./runner.ts";

const job = (video = true): BrowserEvidenceJob => ({
  version: 2,
  port: 4_173,
  viewport: { width: 800, height: 600 },
  steps: [
    {
      name: "navigate",
      action: { kind: "goto", path: "/ready?mode=test" },
      expect: [{ kind: "urlPath", expected: "/ready?mode=test" }],
    },
    {
      name: "click",
      action: { kind: "click", locator: { kind: "testId", value: "ready" } },
      expect: [{ kind: "visible", locator: { kind: "testId", value: "ready" } }],
    },
    {
      name: "fill",
      action: { kind: "fill", locator: { kind: "css", value: "#input" }, value: "value" },
      expect: [
        {
          kind: "textExact",
          locator: { kind: "css", value: "#status" },
          expected: "Ready",
        },
      ],
    },
    {
      name: "press",
      action: { kind: "press", locator: { kind: "testId", value: "ready" }, key: "Enter" },
      expect: [
        { kind: "count", locator: { kind: "testId", value: "ready" }, expected: 1 },
      ],
    },
  ],
  capture: { screenshots: "after-each-step", video },
});

const fakeRuntime = (options: { readonly browserCloseFails?: boolean } = {}) => {
  const events: string[] = [];
  const screenshots: Array<{
    readonly animations: "disabled";
    readonly path: string;
    readonly type: "png";
  }> = [];
  let clock = 1_700_000_000_000;
  let currentUrl = "about:blank";
  const locator: RunnerLocator = {
    click: async () => {
      events.push("click");
    },
    fill: async () => {
      events.push("fill");
    },
    press: async () => {
      events.push("press");
    },
    isVisible: async () => true,
    textContent: async () => {
      events.push("text");
      return "Ready";
    },
    count: async () => 1,
  };
  const runtime: BrowserTestRuntime = {
    now: () => {
      clock += 100;
      return clock;
    },
    sleep: async () => undefined,
    prepareOutput: async () => {
      events.push("output:prepare");
    },
    startDisplay: async () => ({
      name: ":123",
      close: async () => {
        events.push("display:close");
      },
    }),
    launchBrowser: async () => ({
      newContext: async () => ({
        route: async (_pattern, handler) => {
          await handler({
            url: () => "http://127.0.0.1:4173/app.js",
            continue: async () => {
              events.push("route:continue");
            },
            abort: async () => {
              events.push("route:abort-local");
            },
          });
          await handler({
            url: () => "https://example.com/blocked.js",
            continue: async () => {
              events.push("route:continue-external");
            },
            abort: async () => {
              events.push("route:abort");
            },
          });
        },
        routeWebSocket: async (_pattern, handler) => {
          handler({
            url: () => "ws://127.0.0.1:4173/socket",
            connectToServer: () => events.push("ws:continue"),
            close: () => events.push("ws:close-local"),
          });
          handler({
            url: () => "wss://example.com/socket",
            connectToServer: () => events.push("ws:continue-external"),
            close: () => events.push("ws:close"),
          });
        },
        newPage: async () => ({
          goto: async (url) => {
            currentUrl = url;
            events.push("goto");
          },
          getByTestId: () => locator,
          locator: () => locator,
          url: () => currentUrl,
          screenshot: async (options) => {
            const { path } = options;
            screenshots.push(options);
            events.push(`screenshot:${path}`);
          },
        }),
        close: async () => {
          events.push("context:close");
        },
      }),
      close: async () => {
        events.push("browser:close");
        if (options.browserCloseFails === true) throw new Error("private browser error");
      },
    }),
    startRecorder: async () => ({
      stop: async () => {
        events.push("recorder:stop");
      },
    }),
    validateArtifact: async (path, kind) => {
      events.push(`validate:${kind}:${path}`);
    },
    moveArtifact: async (from, to) => {
      events.push(`move:${from}:${to}`);
    },
    removeArtifact: async (path) => {
      events.push(`remove:${path}`);
    },
  };
  return { events, runtime, screenshots };
};

test("runs every action and assertion, blocks cross-origin traffic, and finalizes before success", async () => {
  const { events, runtime } = fakeRuntime();
  const result = await runBrowserEvidenceJob(job(), "/tmp/scotty-browser-runner-test", runtime);

  assert.equal(result.status, "succeeded");
  assert.equal(result.completedSteps, 4);
  assert.equal(result.steps.length, 4);
  assert.ok(result.steps.every((step) => step.frame.path.endsWith(`frame-${step.index + 1}.png`)));
  assert.ok(result.video?.path.endsWith("video.webm"));
  assert.ok(Buffer.byteLength(serializeRunnerManifest(result), "utf8") < 64 * 1_024);
  assert.deepEqual(
    events.filter((event) => ["goto", "click", "fill", "press"].includes(event)),
    ["goto", "click", "fill", "press"],
  );
  assert.ok(events.includes("route:continue"));
  assert.ok(events.includes("route:abort"));
  assert.equal(events.includes("ws:continue"), false);
  assert.ok(events.includes("ws:close-local"));
  assert.ok(events.includes("ws:close"));
  assert.ok(events.indexOf("recorder:stop") < events.indexOf("context:close"));
  assert.ok(events.indexOf("context:close") < events.indexOf("browser:close"));
  assert.ok(events.indexOf("browser:close") < events.indexOf("display:close"));
  assert.ok(events.indexOf("display:close") < events.findIndex((event) => event.startsWith("move:")));
});

test("disables finite animations at the screenshot capture boundary", async () => {
  const { runtime, screenshots } = fakeRuntime();
  const result = await runBrowserEvidenceJob(
    job(false),
    "/tmp/scotty-browser-runner-test",
    runtime,
  );

  assert.equal(result.status, "succeeded");
  assert.equal(screenshots.length, 4);
  assert.ok(screenshots.every((options) => options.animations === "disabled"));
});

test("retains the mismatch step PNG and omits video", async () => {
  const input = job();
  input.steps.splice(1);
  input.steps[0] = {
    name: "mismatch",
    action: { kind: "goto", path: "/ready?mode=test" },
    expect: [
      {
        kind: "textExact",
        locator: { kind: "testId", value: "ready" },
        expected: "Not ready",
      },
    ],
  };
  const { events, runtime } = fakeRuntime();
  const result = await runBrowserEvidenceJob(input, "/tmp/scotty-browser-runner-test", runtime);

  assert.deepEqual(result.failure, { code: "assertion_mismatch", step: 0 });
  assert.equal(result.completedSteps, 1);
  assert.ok(result.steps[0]?.frame.path.endsWith("frame-1.png"));
  assert.equal(result.video, undefined);
  assert.ok(events.includes("recorder:stop"));
  assert.ok(events.filter((event) => event === "text").length > 1);
  assert.equal(events.some((event) => event.startsWith("move:")), false);
});

test("attempts every cleanup and cannot report success after browser cleanup fails", async () => {
  const { events, runtime } = fakeRuntime({ browserCloseFails: true });
  const result = await runBrowserEvidenceJob(job(), "/tmp/scotty-browser-runner-test", runtime);

  assert.equal(result.status, "interrupted");
  assert.deepEqual(result.failure, { code: "interrupted", step: 3 });
  assert.equal(result.video, undefined);
  assert.ok(events.includes("recorder:stop"));
  assert.ok(events.includes("context:close"));
  assert.ok(events.includes("browser:close"));
  assert.ok(events.includes("display:close"));
});

test("CLI rejects an extra-field job before starting the runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scotty-browser-runner-"));
  try {
    const path = join(directory, "job.json");
    await writeFile(path, JSON.stringify({ ...job(false), url: "https://forbidden.example" }));
    const { events, runtime } = fakeRuntime();
    const result = await runBrowserTestCli([path, directory], runtime);
    assert.equal(result.status, "unsupported");
    assert.deepEqual(result.failure, { code: "unsupported" });
    assert.deepEqual(events, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
