import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const { chromium } = await import(process.env.SCOTTY_PLAYWRIGHT_MODULE ?? "playwright");
const output = resolve(process.env.SCOTTY_IMAGE_PROOF_DIR ?? "work/assistant-images");
mkdirSync(output, { recursive: true });
const origin = process.env.SCOTTY_UI_ORIGIN ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({
  executablePath: process.env.SCOTTY_BROWSER_EXECUTABLE,
  headless: true,
  args: ["--no-sandbox"],
});
const id = "a0b1c2d3e4f5";
const assistant =
  '## Screenshot delivery\n\n![Published screenshot](scotty-evidence:seed-image)\n\n![Expired screenshot](scotty-evidence:expired-image)\n\n![Missing screenshot](scotty-evidence:missing-image)\n\n![Fixed table on disk](/workspace/a0b1c2d3e4f5/work/markdown-evidence/after-table-detail.png)\n\n![External image](https://example.com/tracker.png)\n\n<img src="/private.png" onerror="alert(1)">';
const wire = {
  version: 1,
  session: {
    identity: { id },
    selection: { agent: "pi", modelProvider: "openai", model: "gpt-5.4", effort: "high" },
    authority: { kind: "stable", lifecycle: "warm", failure: null },
    runtime: { provider: "cloudflare", readiness: "unchecked" },
    capabilities: { checkpoint: true, sleep: true, resume: false, work: true, vaporize: true },
    display: {
      title: "Assistant image delivery",
      repository: "scotty-dev/scotty",
      branch: "scotty/image-proof",
      defaultBranch: "main",
    },
    times: { capRemainingSeconds: 4200 },
  },
};
const evidence = ["seed-image", "expired-image"].map((jobId) => ({
  jobId,
  status: "succeeded",
  totalSteps: 1,
  completedSteps: 1,
  frameCount: 1,
  recordVideo: false,
  steps: [{ name: "Seeded screenshot", status: "passed", frame: { frameId: "frame-1" } }],
}));
const before = process.argv.includes("--before");
try {
  const seedPage = await browser.newPage({ viewport: { width: 720, height: 300 } });
  await seedPage.setContent(`<!doctype html><html lang="en"><meta charset="utf-8">
    <style>body{margin:24px;background:#101010;color:#f5f5f5;font:16px system-ui}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:14px;border-bottom:1px solid #444}
    th{background:#242424}</style><h1>Screenshot delivery fixture</h1>
    <table><tr><th>Check</th><th>Result</th></tr>
    <tr><td>Authenticated image</td><td>Available</td></tr>
    <tr><td>Responsive layout</td><td>Contained</td></tr></table></html>`);
  const seedImage = await seedPage.screenshot({ path: resolve(output, "seed.png") });
  await seedPage.close();
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
    const requests = [];
    let evidenceReads = 0;
    page.on("request", (req) => requests.push(req.url()));
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const snapshot = {
        version: 1,
        transport: { epoch: "proof", baseSequence: 1, sequence: 1, sessionRevision: 1 },
        turns: [
          {
            id: "seeded-turn",
            state: "completed",
            user: "Show the captured result and explain unavailable images.",
            assistant,
            tools: [],
          },
        ],
        queue: { steer: [], followUp: [] },
        truncated: { turns: false, values: false },
      };
      let body;
      if (path === `/api/sessions/${id}`) body = wire;
      else if (path.endsWith("/conversation")) body = snapshot;
      else if (path.endsWith("/evidence")) {
        body = evidence;
        evidenceReads++;
      } else if (path.endsWith("/hatch")) body = { status: "not_configured" };
      else body = [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await page.route(`**/s/${id}/evidence/**`, (route) =>
      route.request().url().includes("/seed-image/")
        ? route.fulfill({
            status: 200,
            contentType: "image/png",
            headers: { "cache-control": "private, no-store" },
            body: seedImage,
          })
        : route.fulfill({
            status: 404,
            contentType: "application/json",
            body: '{"error":{"code":"not_found"}}',
          }),
    );
    await page.goto(`${origin}/s/${id}`);
    await page.locator("[data-markdown]").waitFor();
    if (before) {
      assert.equal(await page.locator("[data-markdown] img").count(), 0);
      assert(
        (await page.locator("[data-markdown]").innerText()).includes("![Published screenshot]"),
      );
    } else {
      const img = page.getByRole("img", { name: "Published screenshot", exact: true });
      await img.waitFor();
      await img.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () => document.querySelector('[data-markdown-image="loaded"] img')?.naturalWidth > 0,
      );
      assert(evidenceReads > 0, "assistant-only image references trigger evidence loading");
      await page.locator('[data-markdown-image="error"]').waitFor();
      assert.equal(await page.locator('[data-markdown-image="unavailable"]').count(), 3);
      assert(
        (await page.locator("[data-markdown]").innerText()).includes('<img src="/private.png"'),
      );
      const bounds = await img.boundingBox();
      assert(bounds.width > 0 && bounds.width <= width);
      assert.equal(await page.locator("[data-markdown] img").count(), 1);
      assert(
        !requests.some(
          (url) =>
            url.includes("example.com") ||
            url.includes("/workspace/a0b1") ||
            url.endsWith("/private.png"),
        ),
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.screenshot({
      path: `${output}/${before ? "before" : "after"}-${width === 390 ? "mobile" : "desktop"}.png`,
    });
    if (!before) {
      await page.locator(".session-menu > summary").click();
      await page.getByRole("button", { name: "Summary", exact: true }).click();
      const summary = page.locator('[aria-label="Session summary"]');
      await summary.getByRole("img", { name: "Published screenshot", exact: true }).waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[aria-label="Session summary"] [data-markdown-image="loaded"] img',
          )?.naturalWidth > 0,
      );
      await page.screenshot({ path: `${output}/summary-${width}.png` });
    }
    console.log(
      JSON.stringify({
        mode: before ? "before" : "after",
        width,
        evidenceReads,
        images: before ? "literal Markdown" : "loaded with alt; expired/missing/unsafe unavailable",
        summary: !before,
      }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
