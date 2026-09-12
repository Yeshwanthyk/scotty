import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { BrowserEvidenceJob } from "./index.ts";
import { runBrowserEvidenceJob } from "./runner.ts";

const sampleViewport = (path: string): Buffer =>
  execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-vf",
      "crop=2:2:250:180,scale=1:1,format=rgb24",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { timeout: 10_000, maxBuffer: 1_024 * 1_024 },
  );

const colors = (bytes: Buffer): readonly ("red" | "green" | "other")[] => {
  assert.equal(bytes.length % 3, 0);
  const result: ("red" | "green" | "other")[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const red = bytes[index] ?? 0;
    const green = bytes[index + 1] ?? 0;
    result.push(red > green + 60 && red > 100 ? "red" : green > red + 60 && green > 80 ? "green" : "other");
  }
  return result;
};

test(
  "real WebM records both visible states and ends after the final action",
  { skip: process.env.SCOTTY_BROWSER_REAL_SMOKE !== "1", timeout: 60_000 },
  async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><style>html,body,#stage{margin:0;width:100%;height:100%}#stage{background:#f00}#stage.done{background:#0f0}button{position:absolute;top:8px;left:8px}</style><div id="stage"><button data-testid="advance" onclick="document.querySelector('#stage').classList.add('done');document.querySelector('#state').textContent='COMPLETE'">Advance</button><span id="state">READY</span></div>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const output = await mkdtemp(join(tmpdir(), "scotty-browser-video-smoke-"));
    try {
      const port = (server.address() as AddressInfo).port;
      const job: BrowserEvidenceJob = {
        port,
        viewport: { width: 320, height: 240 },
        steps: [
          {
            name: "ready",
            action: { kind: "goto", path: "/" },
            expect: [{ kind: "textExact", locator: { kind: "css", value: "#state" }, expected: "READY" }],
          },
          {
            name: "complete",
            action: { kind: "click", locator: { kind: "testId", value: "advance" } },
            expect: [{ kind: "textExact", locator: { kind: "css", value: "#state" }, expected: "COMPLETE" }],
          },
        ],
        capture: { screenshots: "after-each-step", video: true },
      };
      const result = await runBrowserEvidenceJob(job, output);
      assert.equal(
        result.status,
        "succeeded",
        JSON.stringify({ completedSteps: result.completedSteps, failure: result.failure }),
      );
      const first = result.steps[0];
      const last = result.steps[1];
      const video = result.video;
      assert.ok(first && last && video);
      assert.deepEqual(colors(sampleViewport(first.frame.path)), ["red"]);
      assert.deepEqual(colors(sampleViewport(last.frame.path)), ["green"]);
      const recorded = colors(sampleViewport(video.path));
      const counts = {
        frames: recorded.length,
        red: recorded.filter((color) => color === "red").length,
        green: recorded.filter((color) => color === "green").length,
      };
      assert.ok(recorded.includes("red"), `WebM omitted READY: ${JSON.stringify(counts)}`);
      assert.ok(recorded.includes("green"), `WebM omitted COMPLETE: ${JSON.stringify(counts)}`);
      assert.equal(recorded.at(-1), "green", "WebM ended before the final action was visible");
    } finally {
      await rm(output, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
