import { launch, type BrowserWorker, type SessionlessBrowser } from "@cloudflare/playwright";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const PNG_IHDR = [73, 72, 68, 82] as const;

interface KitesurfCanaryPage {
  readonly evaluate: (expression: string) => Promise<unknown>;
  readonly screenshot: (options: { readonly type: "png" }) => Promise<Uint8Array>;
  readonly setContent: (html: string) => Promise<void>;
}

interface KitesurfCanaryBrowser {
  readonly close: () => Promise<void>;
  readonly newPage: () => Promise<KitesurfCanaryPage>;
  readonly sessionId: () => undefined;
}

export type KitesurfCanaryLauncher = (binding: BrowserWorker) => Promise<KitesurfCanaryBrowser>;

export interface KitesurfCanaryResult {
  readonly browser: "kitesurf";
  readonly domReady: boolean;
  readonly screenshotBytes: number;
  readonly screenshotPng: boolean;
  readonly sessionId: undefined;
  readonly sessionless: boolean;
}

export const isPngScreenshot = (bytes: Uint8Array): boolean =>
  bytes.length >= 24 &&
  PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) &&
  PNG_IHDR.every((byte, index) => bytes[index + 12] === byte);

export const launchSessionlessKitesurf = (binding: BrowserWorker): Promise<SessionlessBrowser> =>
  launch(binding, { browser: "kitesurf" });

export const runKitesurfCanary = async (
  binding: BrowserWorker,
  launchBrowser: KitesurfCanaryLauncher = launchSessionlessKitesurf,
): Promise<KitesurfCanaryResult> => {
  const browser = await launchBrowser(binding);
  return Promise.resolve()
    .then(async () => {
      const page = await browser.newPage();
      await page.setContent(
        '<output data-kitesurf-canary>pending</output><script>document.querySelector("[data-kitesurf-canary]").textContent = "ready";</script>',
      );
      const domState = await page.evaluate(
        'document.querySelector("[data-kitesurf-canary]")?.textContent ?? null',
      );
      const screenshot = await page.screenshot({ type: "png" });
      const sessionId = browser.sessionId();
      const result: KitesurfCanaryResult = {
        browser: "kitesurf",
        domReady: domState === "ready",
        screenshotBytes: screenshot.byteLength,
        screenshotPng: isPngScreenshot(screenshot),
        sessionId,
        sessionless: sessionId === undefined,
      };
      return result;
    })
    .finally(() => browser.close());
};
