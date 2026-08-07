import { describe, expect, it, vi } from "vitest";

const playwright = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("@cloudflare/playwright", () => ({ launch: playwright.launch }));

import type { BrowserWorker } from "@cloudflare/playwright";
import {
  isPngScreenshot,
  launchSessionlessKitesurf,
  runKitesurfCanary,
} from "../src/kitesurf-launch";

const binding: BrowserWorker = { fetch: globalThis.fetch };
const pngScreenshot = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1, 39, 24,
  227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

describe("Kitesurf launch contract", () => {
  it("selects the sessionless Kitesurf launch overload", async () => {
    playwright.launch.mockResolvedValueOnce(undefined);

    await launchSessionlessKitesurf(binding);

    expect(playwright.launch).toHaveBeenCalledExactlyOnceWith(binding, {
      browser: "kitesurf",
    });
  });

  it("executes the synthetic DOM canary and accepts a PNG screenshot through fakes", async () => {
    const close = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => "ready");
    const screenshot = vi.fn(async () => pngScreenshot);
    const setContent = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({
      close,
      newPage: async () => ({ evaluate, screenshot, setContent }),
      sessionId: () => undefined,
    }));

    const result = await runKitesurfCanary(binding, launch);

    expect(launch).toHaveBeenCalledExactlyOnceWith(binding);
    expect(setContent).toHaveBeenCalledWith(expect.stringContaining("<script>"));
    expect(evaluate).toHaveBeenCalledWith(expect.stringContaining("data-kitesurf-canary"));
    expect(screenshot).toHaveBeenCalledExactlyOnceWith({ type: "png" });
    expect(close).toHaveBeenCalledOnce();
    expect(result).toEqual({
      browser: "kitesurf",
      domReady: true,
      screenshotBytes: pngScreenshot.byteLength,
      screenshotPng: true,
      sessionId: undefined,
      sessionless: true,
    });
  });

  it("rejects bytes without the PNG signature and IHDR header", () => {
    expect(isPngScreenshot(new Uint8Array(24))).toBe(false);
  });
});
