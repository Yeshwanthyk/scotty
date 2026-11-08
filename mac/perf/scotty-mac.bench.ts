// The Mac app against the UI's seed API (ui/seed), measured from outside by strobe through the
// macOS accessibility tree. Selectors are the app's element keys (`.key(...)` in mac/src).
// How to run it: perf/README.md.
import { bench, fixture, native } from "@hona/strobe";

// Seeded sessions the list shows without filters: one waiting for input, one working, one
// waiting with a question.
const WAITING = "d0cc0de5000000000000000000000002";
const OTHERS = ["d0cc0de5000000000000000000000005", "5eed0000000000000000000000000001"];
// "Fix gift card tax in checkout": the longest thread. It is stopped, so it shows only once the
// sidebar's stopped group is open.
const GIFT = "d0cc0de5000000000000000000000001";

// One seed server per block: the UI's Vite dev server serves /api from ui/seed, sockets included.
// strobe starts it on a free port before the app and fills `{fixture.url}` into the app's files.
const seed = fixture(
  "cd ../../ui && exec ../node_modules/.bin/vite --host 127.0.0.1 --port {port} --strictPort",
  {
    ready: "http://127.0.0.1:{port}/api/sessions",
    timeout: 120_000,
  },
);

// Open the seed server at launch, as if it was the last one opened.
const servers = {
  servers: [{ name: "seed", url: "{fixture.url}" }],
  last: "{fixture.url}",
};

export default bench({
  fixture: seed,
  targets: {
    mac: native("scotty-mac", {
      viewport: { width: 1180, height: 820 },
      files: { "Library/Application Support/scotty-mac/servers.json": servers },
    }),
  },
  async setup({ page }) {
    await page.waitFor(`row:${WAITING}`);
    await page.idle();
  },
  cases: {
    // From spawn to the seeded list on screen.
    launch: {
      primary: "launch.ready",
      launch: { until: `row:${WAITING}` },
    },
    // Nothing happening: what the app costs sitting open on a list with running sessions.
    idle: {
      primary: "cpu.wakes",
      run: ({ page }) => page.wait(5000),
    },
    // Click a session in the sidebar until its thread shows; close the tab between runs.
    "open-session": {
      primary: "interaction.p95",
      run: ({ page }) => page.click(`row:${WAITING}`, { until: `thread:${WAITING}` }),
      reset: async ({ page }) => {
        await page.press("Meta+w");
        await page.idle();
      },
    },
    // ⌘K, type a query, close it.
    palette: {
      primary: "interaction.p95",
      run: async ({ page }) => {
        await page.press("Meta+k", { until: "palette-input" });
        await page.type("palette-input", "gift card", { delay: 80 });
      },
      reset: async ({ page }) => {
        await page.press("Escape");
        await page.idle();
      },
    },
    // Three open tabs, cycled with ⇧⌘].
    "switch-tabs": {
      primary: "ui.cpu",
      run: async ({ page, phase }) => {
        for (const id of [WAITING, ...OTHERS]) {
          await page.click(`row:${id}`, { until: `thread:${id}` });
        }
        await phase("cycle", async () => {
          for (let i = 0; i < 9; i++) await page.press("Meta+Shift+]", { until: "frame" });
        });
      },
      reset: async ({ page }) => {
        for (let i = 0; i < 3; i++) await page.press("Meta+w");
        await page.idle();
      },
    },
    // Scroll the long thread up and back down.
    "scroll-thread": {
      primary: "ui.cpu",
      run: async ({ page }) => {
        if ((await page.query(`row:${GIFT}`)).length === 0) {
          await page.click("stopped-toggle", { until: `row:${GIFT}` });
        }
        await page.click(`row:${GIFT}`, { until: `thread:${GIFT}` });
        await page.idle();
        await page.scroll(`thread:${GIFT}`, { by: -4000, speed: 3000 });
        await page.scroll(`thread:${GIFT}`, { by: 4000, speed: 3000 });
      },
      reset: async ({ page }) => {
        await page.press("Meta+w");
        await page.idle();
      },
    },
  },
});
