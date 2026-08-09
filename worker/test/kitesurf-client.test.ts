import { assert, describe, it } from "@effect/vitest";
import type {
  APIResponse,
  BrowserContext,
  BrowserWorker,
  Request as PlaywrightRequest,
  Route,
  WebSocketRoute,
} from "@cloudflare/playwright";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { writeFile } from "node:fs/promises";
import { vi } from "vitest";

const playwright = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/playwright", () => playwright);

import { EVIDENCE_MAX_FRAME_BYTES } from "../src/evidence-contracts";
import { EVIDENCE_PREVIEW_COOKIE } from "../src/evidence-preview";
import {
  KITESURF_ACQUISITION_RETRY_DELAY_MILLIS,
  KITESURF_CLEANUP_RETRY_DELAY_MILLIS,
  KITESURF_NAVIGATION_TIMEOUT_MILLIS,
  KITESURF_OPERATION_TIMEOUT_MILLIS,
  KITESURF_SCREENSHOT_TIMEOUT_MILLIS,
  KitesurfClientError,
  makeKitesurfClient,
  type KitesurfRuntimeLauncher,
} from "../src/kitesurf-client";

const binding: BrowserWorker = { fetch: globalThis.fetch };
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = "iVBORw0KGgo=";

interface CaptureSession {
  readonly detach: () => Promise<void>;
  readonly send: (
    method: "Page.captureScreenshot",
    params: { readonly format: "png"; readonly captureBeyondViewport: false },
  ) => Promise<unknown>;
}

const captureSession = (
  send: CaptureSession["send"] = async () => ({ data: PNG_BASE64 }),
  detach: CaptureSession["detach"] = async () => undefined,
): CaptureSession => ({ detach, send });

interface RuntimeState {
  readonly events: Array<string>;
  readonly cookies: Array<Parameters<BrowserContext["addCookies"]>[0][number]>;
  pageOptions: unknown;
  cdpTargetIsOwnedPage: boolean | undefined;
  cdpMethod: string | undefined;
  cdpParams: unknown;
  requestHandler: Parameters<BrowserContext["route"]>[1] | undefined;
  webSocketHandler: Parameters<BrowserContext["routeWebSocket"]>[1] | undefined;
}

const makeRuntime = (
  state: RuntimeState,
  options: {
    readonly cssSelectorValidator?: (value: string) => boolean;
    readonly routeSupported?: boolean;
    readonly webSocketRouteSupported?: boolean;
    readonly acquireCdpSession?: () => Promise<CaptureSession>;
    readonly browserClose?: () => Promise<void>;
    readonly newPageFails?: () => boolean;
    readonly pageCount?: () => number;
    readonly sessionId?: string;
    readonly videoBytes?: Uint8Array;
  } = {},
): KitesurfRuntimeLauncher => {
  const videoBytes = options.videoBytes;
  const locator = {
    click: async (callOptions?: { readonly timeout?: number }) => {
      state.events.push(`locator:click:${callOptions?.timeout ?? 0}`);
    },
    fill: async (_value: string, callOptions?: { readonly timeout?: number }) => {
      state.events.push(`locator:fill:${callOptions?.timeout ?? 0}`);
    },
    press: async (_key: string, callOptions?: { readonly timeout?: number }) => {
      state.events.push(`locator:press:${callOptions?.timeout ?? 0}`);
    },
    isVisible: async () => true,
    textContent: async () => "Ready",
    count: async () => 1,
  };
  const page = {
    close: async () => {
      state.events.push("page:close");
    },
    context: () => {
      state.events.push("page:context");
      return context;
    },
    evaluate: async (_pageFunction: unknown, value: string) => {
      state.events.push(`page:evaluate-css:${value}`);
      return options.cssSelectorValidator?.(value) ?? true;
    },
    getByTestId: (value: string) => {
      state.events.push(`page:test-id:${value}`);
      return locator;
    },
    goto: async (
      url: string,
      callOptions?: { readonly timeout?: number; readonly waitUntil?: string },
    ) => {
      state.events.push(
        `page:goto:${url}:${callOptions?.timeout ?? 0}:${callOptions?.waitUntil ?? ""}`,
      );
      return null;
    },
    locator: (value: string) => {
      state.events.push(`page:locator:${value}`);
      return locator;
    },
    url: () => "https://preview.scotty.example/ready?mode=test",
    video: () =>
      videoBytes === undefined
        ? null
        : {
            saveAs: async (path: string) => {
              state.events.push("video:save");
              await writeFile(path, videoBytes);
            },
          },
  };
  const route: BrowserContext["route"] = async (_url, handler) => {
    state.events.push("context:route");
    state.requestHandler = handler;
  };
  const routeWebSocket: BrowserContext["routeWebSocket"] = async (_url, handler) => {
    state.events.push("context:route-websocket");
    state.webSocketHandler = handler;
  };
  const context = {
    addCookies: async (cookies: Parameters<BrowserContext["addCookies"]>[0]) => {
      state.events.push("context:cookies");
      state.cookies.push(...cookies);
    },
    close: async () => {
      state.events.push("context:close");
    },
    newCDPSession: async () => {
      state.events.push("context:new-cdp-session");
      state.cdpTargetIsOwnedPage = true;
      if (options.acquireCdpSession !== undefined) return options.acquireCdpSession();
      return captureSession(
        async (method, params) => {
          state.events.push("cdp:send");
          state.cdpMethod = method;
          state.cdpParams = params;
          return { data: PNG_BASE64 };
        },
        async () => void state.events.push("cdp:detach"),
      );
    },
    pages: () => {
      state.events.push("context:pages");
      return Array.from({ length: options.pageCount?.() ?? 1 }, () => page);
    },
    newPage: async () => {
      state.events.push("page:open");
      if (options.newPageFails?.() === true)
        return Promise.reject(new Error("private page acquisition failure"));
      return page;
    },
    ...(options.routeSupported === false ? {} : { route }),
    ...(options.webSocketRouteSupported === false ? {} : { routeWebSocket }),
  };
  return async () => ({
    close: async () => {
      state.events.push("browser:close");
      await options.browserClose?.();
    },
    newContext: async (pageOptions) => {
      state.events.push("context:open");
      state.pageOptions = pageOptions;
      return context;
    },
    sessionId: () => {
      state.events.push(
        options.sessionId === undefined ? "browser:sessionless" : "browser:session",
      );
      return options.sessionId;
    },
  });
};

const runtimeState = (): RuntimeState => ({
  events: [],
  cookies: [],
  pageOptions: undefined,
  cdpTargetIsOwnedPage: undefined,
  cdpMethod: undefined,
  cdpParams: undefined,
  requestHandler: undefined,
  webSocketHandler: undefined,
});

type RuntimeBrowser = Awaited<ReturnType<KitesurfRuntimeLauncher>>;
type RuntimeContext = Awaited<ReturnType<RuntimeBrowser["newContext"]>>;
type RuntimePage = Awaited<ReturnType<RuntimeContext["newPage"]>>;

const deferredPromise = <A>() => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const failureOf = <A, E>(result: Result.Result<A, E>): E => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const base64ZeroBytes = (decodedBytes: number): string => {
  const completeGroups = Math.floor(decodedBytes / 3);
  const remainder = decodedBytes % 3;
  return `${"AAAA".repeat(completeGroups)}${remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : ""}`;
};

const apiResponse = (status: number, headers: Readonly<Record<string, string>> = {}): APIResponse =>
  ({
    dispose: async () => undefined,
    headers: () => ({ ...headers }),
    headersArray: () => Object.entries(headers).map(([name, value]) => ({ name, value })),
    json: async () => null,
    ok: () => status >= 200 && status <= 299,
    status: () => status,
    statusText: () => "",
    text: async () => "",
    url: () => "https://preview.scotty.example/",
  }) as APIResponse;

describe("Kitesurf client", () => {
  it.effect("launches screenshot jobs with the sessionless Kitesurf selector", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      playwright.launch.mockImplementationOnce(makeRuntime(state));
      const client = makeKitesurfClient(binding);

      yield* client.withPage(
        {
          origin: "https://preview.scotty.example",
          cookieSecret: "private-cookie-secret",
        },
        () => Effect.void,
      );

      assert.strictEqual(playwright.launch.mock.calls.length, 1);
      assert.deepStrictEqual(playwright.launch.mock.calls[0], [binding, { browser: "kitesurf" }]);
    }),
  );

  it.effect("launches video jobs in a managed Browser Run session", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00]);
      playwright.launch.mockImplementationOnce(
        makeRuntime(state, { sessionId: "session-video", videoBytes: webm }),
      );
      const client = makeKitesurfClient(binding);
      const record = client.withRecordedPage;
      assert.ok(record !== undefined);

      const result = yield* record(
        {
          origin: "https://preview.scotty.example",
          cookieSecret: "private-cookie-secret",
        },
        () => Effect.void,
      );

      assert.deepStrictEqual(result.video, webm);
      assert.deepStrictEqual(playwright.launch.mock.calls.at(-1), [binding]);
      assert.include(state.events, "browser:session");
      assert.strictEqual(state.events.at(-1), "browser:close");
    }),
  );

  it.effect("installs exact-origin policy and cookie in one sessionless isolated page", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const secret = "private-cookie-secret";
      const client = makeKitesurfClient(binding, makeRuntime(state));
      const result = yield* client.withPage(
        {
          origin: "https://preview.scotty.example",
          cookieSecret: secret,
          viewport: { width: 800, height: 600 },
        },
        (page) =>
          Effect.gen(function* () {
            yield* page.goto("/ready?mode=test");
            yield* page.click({ kind: "testId", value: "submit" });
            yield* page.fill({ kind: "css", value: "input" }, "private-fill");
            yield* page.press({ kind: "css", value: "input" }, "Enter");
            assert.isTrue(yield* page.isVisible({ kind: "testId", value: "ready" }));
            assert.strictEqual(
              yield* page.textContent({ kind: "testId", value: "ready" }),
              "Ready",
            );
            assert.strictEqual(yield* page.count({ kind: "css", value: "main" }), 1);
            assert.strictEqual(yield* page.urlPath, "/ready?mode=test");
            return yield* page.screenshot;
          }),
      );

      assert.deepStrictEqual(result, PNG);
      assert.deepStrictEqual(state.pageOptions, {
        serviceWorkers: "block",
        viewport: { width: 800, height: 600 },
      });
      assert.deepStrictEqual(state.cookies, [
        {
          httpOnly: true,
          name: EVIDENCE_PREVIEW_COOKIE,
          sameSite: "Strict",
          secure: true,
          url: "https://preview.scotty.example/",
          value: secret,
        },
      ]);
      assert.isTrue(state.cdpTargetIsOwnedPage);
      assert.strictEqual(state.cdpMethod, "Page.captureScreenshot");
      assert.deepStrictEqual(state.cdpParams, {
        format: "png",
        captureBeyondViewport: false,
      });
      assert.include(state.events, "browser:sessionless");
      assert.include(state.events, `locator:click:${KITESURF_NAVIGATION_TIMEOUT_MILLIS}`);
      assert.notInclude(state.events, "page:screenshot");
      const captureEvents = state.events.slice(
        state.events.lastIndexOf("context:new-cdp-session") - 1,
      );
      assert.deepStrictEqual(captureEvents.slice(0, 5), [
        "context:pages",
        "context:new-cdp-session",
        "cdp:send",
        "cdp:detach",
        "context:pages",
      ]);
      assert.notInclude(state.events, "page:close");
      assert.include(state.events, "context:close");
      assert.isBelow(state.events.indexOf("context:close"), state.events.indexOf("browser:close"));
      assert.strictEqual(state.events.at(-1), "browser:close");
      const setupAndFirstUse = [
        "context:route",
        "context:route-websocket",
        "context:cookies",
        "context:pages",
        `page:goto:https://preview.scotty.example/ready?mode=test:${KITESURF_NAVIGATION_TIMEOUT_MILLIS}:load`,
      ];
      let previousEventIndex = -1;
      for (const event of setupAndFirstUse) {
        const eventIndex = state.events.indexOf(event);
        assert.isAbove(eventIndex, previousEventIndex);
        previousEventIndex = eventIndex;
      }
      assert.isFalse(state.events.some((event) => event.includes(secret)));

      let fulfilled = false;
      let aborted = false;
      const response = apiResponse(200);
      const handler = state.requestHandler;
      assert.ok(handler !== undefined);
      yield* Effect.promise(() =>
        handler(
          {
            fetch: async () => response,
            fulfill: async () => void (fulfilled = true),
          } as Route,
          {
            method: () => "GET",
            url: () => "https://preview.scotty.example/app.js",
          } as PlaywrightRequest,
        ),
      );
      yield* Effect.promise(() =>
        handler(
          { abort: async () => void (aborted = true) } as Route,
          {
            method: () => "GET",
            url: () => "https://external.example/track.js",
          } as PlaywrightRequest,
        ),
      );
      assert.isTrue(fulfilled);
      assert.isTrue(aborted);

      let webSocketClosed = false;
      const webSocketHandler = state.webSocketHandler;
      assert.ok(webSocketHandler !== undefined);
      yield* Effect.promise(() =>
        webSocketHandler({ close: async () => void (webSocketClosed = true) } as WebSocketRoute),
      );
      assert.isTrue(webSocketClosed);
    }),
  );

  it.effect("decodes a screenshot at the exact byte budget before detaching", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const data = base64ZeroBytes(EVIDENCE_MAX_FRAME_BYTES);
      const client = makeKitesurfClient(
        binding,
        makeRuntime(state, {
          acquireCdpSession: async () =>
            captureSession(
              async () => {
                state.events.push("cdp:max-send");
                return { data };
              },
              async () => void state.events.push("cdp:max-detach"),
            ),
        }),
      );

      const bytes = yield* client.withPage(
        {
          origin: "https://preview.scotty.example",
          cookieSecret: "private-cookie-secret",
        },
        (page) => page.screenshot,
      );

      assert.strictEqual(bytes.byteLength, EVIDENCE_MAX_FRAME_BYTES);
      assert.strictEqual(bytes[0], 0);
      assert.strictEqual(bytes.at(-1), 0);
      assert.isBelow(state.events.indexOf("cdp:max-send"), state.events.indexOf("cdp:max-detach"));
    }),
  );

  it.effect("flushes and returns a real WebM recording after closing its context", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00]);
      const client = makeKitesurfClient(
        binding,
        makeRuntime(state, { sessionId: "session-video", videoBytes: webm }),
      );
      const record = client.withRecordedPage;
      assert.ok(record !== undefined);

      const result = yield* record(
        {
          origin: "https://preview.scotty.example",
          cookieSecret: "private-cookie-secret",
          viewport: { width: 800, height: 600 },
        },
        () => Effect.succeed("complete"),
      );

      assert.strictEqual(result.value, "complete");
      assert.deepStrictEqual(result.video, webm);
      assert.deepInclude(state.pageOptions, {
        recordVideo: { dir: "/tmp", size: { width: 800, height: 600 } },
      });
      assert.isBelow(state.events.indexOf("context:close"), state.events.indexOf("video:save"));
      assert.isBelow(state.events.indexOf("video:save"), state.events.indexOf("browser:close"));
    }),
  );

  it.effect("rejects empty, oversized, and malformed base64 before retaining protocol output", () =>
    Effect.gen(function* () {
      const cases = [
        { label: "empty", data: "" },
        { label: "oversized", data: base64ZeroBytes(EVIDENCE_MAX_FRAME_BYTES + 1) },
        { label: "malformed", data: "private-protocol-base64%" },
        { label: "noncanonical-one-byte", data: "AB==" },
        { label: "noncanonical-two-bytes", data: "AAB=" },
      ];
      for (const testCase of cases) {
        const state = runtimeState();
        const client = makeKitesurfClient(
          binding,
          makeRuntime(state, {
            acquireCdpSession: async () =>
              captureSession(
                async () => ({ data: testCase.data }),
                async () => void state.events.push(`cdp:${testCase.label}:detach`),
              ),
          }),
        );
        const result = yield* client
          .withPage(
            {
              origin: "https://preview.scotty.example",
              cookieSecret: "private-cookie-secret",
            },
            (page) => page.screenshot,
          )
          .pipe(Effect.result);

        const failure = failureOf(result);
        assert.deepInclude(failure, {
          operation: "screenshot",
          reason: "ambiguous",
        });
        assert.notProperty(failure, "data");
        assert.include(state.events, `cdp:${testCase.label}:detach`);
      }
    }),
  );

  it.effect("rejects a malformed CDP result as a safe typed failure", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const result = yield* makeKitesurfClient(
        binding,
        makeRuntime(state, {
          acquireCdpSession: async () =>
            captureSession(
              async () => ({ privateScreenshotData: "private-protocol-output" }),
              async () => void state.events.push("cdp:malformed-result-detach"),
            ),
        }),
      )
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          (page) => page.screenshot,
        )
        .pipe(Effect.result);

      assert.deepInclude(failureOf(result), {
        operation: "screenshot",
        reason: "ambiguous",
      });
      assert.include(state.events, "cdp:malformed-result-detach");
      assert.notInclude(JSON.stringify(result), "private-protocol-output");
    }),
  );

  it.effect("enforces the single owned page immediately before and after CDP capture", () =>
    Effect.gen(function* () {
      let preCheckCalls = 0;
      const preState = runtimeState();
      const preClient = makeKitesurfClient(
        binding,
        makeRuntime(preState, {
          pageCount: () => (++preCheckCalls === 2 ? 2 : 1),
        }),
      );
      const preResult = yield* preClient
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          (page) => page.screenshot,
        )
        .pipe(Effect.result);

      assert.deepInclude(failureOf(preResult), {
        operation: "create_page",
        reason: "unsupported",
      });
      assert.notInclude(preState.events, "context:new-cdp-session");

      let postCheckCalls = 0;
      const postState = runtimeState();
      const postClient = makeKitesurfClient(
        binding,
        makeRuntime(postState, {
          pageCount: () => (++postCheckCalls === 3 ? 2 : 1),
        }),
      );
      const postResult = yield* postClient
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          (page) => page.screenshot,
        )
        .pipe(Effect.result);

      assert.deepInclude(failureOf(postResult), {
        operation: "create_page",
        reason: "unsupported",
      });
      assert.isBelow(postState.events.indexOf("cdp:send"), postState.events.indexOf("cdp:detach"));
      assert.isBelow(
        postState.events.indexOf("cdp:detach"),
        postState.events.lastIndexOf("context:pages"),
      );
    }),
  );

  it.effect("sanitizes CDP session acquisition, send, and detach failures", () =>
    Effect.gen(function* () {
      const acquisitionState = runtimeState();
      const acquisitionResult = yield* makeKitesurfClient(
        binding,
        makeRuntime(acquisitionState, {
          acquireCdpSession: async () =>
            Promise.reject(new Error("private CDP acquisition failure")),
        }),
      )
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          (page) => page.screenshot,
        )
        .pipe(Effect.result);
      assert.deepInclude(failureOf(acquisitionResult), {
        operation: "screenshot",
        reason: "ambiguous",
      });
      assert.notInclude(JSON.stringify(acquisitionResult), "private CDP acquisition failure");

      const sendState = runtimeState();
      const sendResult = yield* makeKitesurfClient(
        binding,
        makeRuntime(sendState, {
          acquireCdpSession: async () =>
            captureSession(
              async () => Promise.reject(new Error("private CDP send failure")),
              async () => void sendState.events.push("cdp:failed-send-detach"),
            ),
        }),
      )
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          (page) => page.screenshot,
        )
        .pipe(Effect.result);
      assert.deepInclude(failureOf(sendResult), {
        operation: "screenshot",
        reason: "ambiguous",
      });
      assert.include(sendState.events, "cdp:failed-send-detach");
      assert.notInclude(JSON.stringify(sendResult), "private CDP send failure");

      const detachState = runtimeState();
      const detachResult = yield* makeKitesurfClient(
        binding,
        makeRuntime(detachState, {
          acquireCdpSession: async () =>
            captureSession(undefined, async () =>
              Promise.reject(new Error("private CDP detach failure")),
            ),
        }),
      )
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          (page) => page.screenshot,
        )
        .pipe(Effect.result);
      assert.deepInclude(failureOf(detachResult), {
        operation: "screenshot",
        reason: "ambiguous",
      });
      assert.notInclude(JSON.stringify(detachResult), "private CDP detach failure");
    }),
  );

  it.effect("times out a pending CDP capture and detaches before browser cleanup", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
      () =>
        Effect.gen(function* () {
          const state = runtimeState();
          const client = makeKitesurfClient(
            binding,
            makeRuntime(state, {
              acquireCdpSession: async () =>
                captureSession(
                  async () => new Promise<{ readonly data: string }>(() => undefined),
                  async () => void state.events.push("cdp:timeout-detach"),
                ),
            }),
          );
          const fiber = yield* client
            .withPage(
              {
                origin: "https://preview.scotty.example",
                cookieSecret: "private-cookie-secret",
              },
              (page) => page.screenshot,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

          yield* Effect.promise(() =>
            vi.advanceTimersByTimeAsync(KITESURF_SCREENSHOT_TIMEOUT_MILLIS),
          );
          const result = yield* Fiber.join(fiber);

          assert.deepInclude(failureOf(result), {
            operation: "screenshot",
            reason: "ambiguous",
          });
          assert.isBelow(
            state.events.indexOf("cdp:timeout-detach"),
            state.events.indexOf("browser:close"),
          );
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
  );

  it.effect("bounds a pending CDP detach before browser cleanup", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
      () =>
        Effect.gen(function* () {
          const state = runtimeState();
          const client = makeKitesurfClient(
            binding,
            makeRuntime(state, {
              acquireCdpSession: async () =>
                captureSession(
                  async () => ({ data: PNG_BASE64 }),
                  async () => {
                    state.events.push("cdp:pending-detach");
                    return new Promise<void>(() => undefined);
                  },
                ),
            }),
          );
          const fiber = yield* client
            .withPage(
              {
                origin: "https://preview.scotty.example",
                cookieSecret: "private-cookie-secret",
              },
              (page) => page.screenshot,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

          yield* Effect.promise(() =>
            vi.advanceTimersByTimeAsync(KITESURF_OPERATION_TIMEOUT_MILLIS),
          );
          const result = yield* Fiber.join(fiber);

          assert.deepInclude(failureOf(result), {
            operation: "screenshot",
            reason: "ambiguous",
          });
          assert.isBelow(
            state.events.indexOf("cdp:pending-detach"),
            state.events.indexOf("browser:close"),
          );
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
  );

  it.effect("preserves the primary capture failure when detach also fails", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(console, "error").mockImplementation(() => undefined)),
      (cleanupLog) =>
        Effect.gen(function* () {
          const state = runtimeState();
          const result = yield* makeKitesurfClient(
            binding,
            makeRuntime(state, {
              acquireCdpSession: async () =>
                captureSession(
                  async () => Promise.reject(new Error("private primary capture failure")),
                  async () => Promise.reject(new Error("private secondary detach failure")),
                ),
            }),
          )
            .withPage(
              {
                origin: "https://preview.scotty.example",
                cookieSecret: "private-cookie-secret",
              },
              (page) => page.screenshot,
            )
            .pipe(Effect.result);

          assert.deepInclude(failureOf(result), {
            operation: "screenshot",
            reason: "ambiguous",
          });
          assert.deepStrictEqual(cleanupLog.mock.calls, [
            [
              "Kitesurf cleanup failed after an earlier evidence failure",
              { operation: "screenshot", reason: "ambiguous" },
            ],
          ]);
          const serialized = JSON.stringify({ logs: cleanupLog.mock.calls, result });
          assert.notInclude(serialized, "private primary capture failure");
          assert.notInclude(serialized, "private secondary detach failure");
        }),
      (cleanupLog) => Effect.sync(() => cleanupLog.mockRestore()),
    ),
  );

  it.effect("rejects Playwright engines before page.locator", () =>
    Effect.gen(function* () {
      for (const value of [
        "css=main",
        "xpath=//main",
        "text=Continue",
        "role=button[name=Continue]",
      ]) {
        const state = runtimeState();
        const client = makeKitesurfClient(binding, makeRuntime(state));
        const result = yield* client
          .withPage(
            {
              origin: "https://preview.scotty.example",
              cookieSecret: "private-cookie-secret",
            },
            (page) => page.click({ kind: "css", value }),
          )
          .pipe(Effect.result);

        assert.deepInclude(failureOf(result), { operation: "click", reason: "unsupported" });
        assert.isFalse(state.events.some((event) => event.startsWith("page:locator:")));
        assert.isFalse(state.events.some((event) => event.startsWith("page:evaluate-css:")));
      }
    }),
  );

  it.effect("rejects malformed CSS before page.locator", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const value = "[data-ready";
      const client = makeKitesurfClient(
        binding,
        makeRuntime(state, { cssSelectorValidator: () => false }),
      );
      const result = yield* client
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          (page) => page.click({ kind: "css", value }),
        )
        .pipe(Effect.result);

      assert.deepInclude(failureOf(result), { operation: "click", reason: "unsupported" });
      assert.include(state.events, `page:evaluate-css:${value}`);
      assert.isFalse(state.events.some((event) => event.startsWith("page:locator:")));
    }),
  );

  it.effect("accepts normal CSS while preserving testId locators", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const css = "main > [data-state='ready']:not([hidden])";
      const client = makeKitesurfClient(
        binding,
        makeRuntime(state, { cssSelectorValidator: (value) => value === css }),
      );

      yield* client.withPage(
        {
          origin: "https://preview.scotty.example",
          cookieSecret: "private-cookie-secret",
        },
        (page) =>
          Effect.gen(function* () {
            yield* page.click({ kind: "css", value: css });
            yield* page.click({ kind: "testId", value: "continue" });
          }),
      );

      assert.include(state.events, `page:evaluate-css:${css}`);
      assert.include(state.events, `page:locator:${css}`);
      assert.include(state.events, "page:test-id:continue");
      assert.strictEqual(
        state.events.filter((event) => event.startsWith("page:evaluate-css:")).length,
        1,
      );
    }),
  );

  it.effect("never fetches a cross-origin redirect hop", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const client = makeKitesurfClient(binding, makeRuntime(state));
      yield* client.withPage(
        {
          origin: "https://preview.scotty.example",
          cookieSecret: "private-cookie-secret",
        },
        () => Effect.void,
      );
      const fetched: string[] = [];
      let aborted = false;
      let fulfilled = false;
      const sameOriginRedirect = apiResponse(302, { location: "/next" });
      const crossOriginRedirect = apiResponse(302, {
        location: "https://external.example/private",
      });
      const handler = state.requestHandler;
      assert.ok(handler !== undefined);
      yield* Effect.promise(() =>
        handler(
          {
            abort: async () => void (aborted = true),
            fetch: async (options) => {
              fetched.push(options?.url ?? "");
              return fetched.length === 1 ? sameOriginRedirect : crossOriginRedirect;
            },
            fulfill: async () => void (fulfilled = true),
          } as Route,
          {
            method: () => "GET",
            url: () => "https://preview.scotty.example/start",
          } as PlaywrightRequest,
        ),
      );

      assert.deepStrictEqual(fetched, [
        "https://preview.scotty.example/start",
        "https://preview.scotty.example/next",
      ]);
      assert.isTrue(aborted);
      assert.isFalse(fulfilled);
    }),
  );

  it.effect("bounds acquisition and compensates browsers acquired after timeout", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
      () =>
        Effect.gen(function* () {
          const events: string[] = [];
          const lateBrowser = deferredPromise<RuntimeBrowser>();
          const client = makeKitesurfClient(binding, () => lateBrowser.promise, 0);
          const fiber = yield* client
            .withPage(
              {
                origin: "https://preview.scotty.example",
                cookieSecret: "private-cookie-secret",
              },
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          const result = yield* Fiber.join(fiber);
          assert.deepInclude(failureOf(result), { operation: "launch", reason: "ambiguous" });

          lateBrowser.resolve({
            close: async () => void events.push("browser:late-close"),
            newContext: async () => new Promise<RuntimeContext>(() => undefined),
            sessionId: () => undefined,
          });
          yield* Effect.promise(() => vi.runAllTimersAsync());
          assert.deepStrictEqual(events, ["browser:late-close"]);
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
  );

  it.effect("compensates a page acquired after its native timeout", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
      () =>
        Effect.gen(function* () {
          const events: string[] = [];
          const latePage = deferredPromise<RuntimePage>();
          let launches = 0;
          let signalSecondLaunch: (() => void) | undefined;
          const secondLaunch = new Promise<void>((resolve) => {
            signalSecondLaunch = resolve;
          });
          const client = makeKitesurfClient(
            binding,
            async () => {
              launches += 1;
              if (launches === 2) signalSecondLaunch?.();
              return {
                close: async () => void events.push("browser:close"),
                newContext: async () => ({
                  addCookies: async () => undefined,
                  close: async () => void events.push("context:close"),
                  newCDPSession: async () => captureSession(),
                  newPage: () => latePage.promise,
                  pages: () => [],
                  route: async () => undefined,
                  routeWebSocket: async () => undefined,
                }),
                sessionId: () => undefined,
              };
            },
            0,
          );
          const fiber = yield* client
            .withPage(
              {
                origin: "https://preview.scotty.example",
                cookieSecret: "private-cookie-secret",
              },
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          yield* TestClock.adjust(KITESURF_ACQUISITION_RETRY_DELAY_MILLIS);
          yield* Effect.promise(() => secondLaunch);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          const result = yield* Fiber.join(fiber);
          assert.deepInclude(failureOf(result), {
            operation: "create_page",
            reason: "ambiguous",
          });

          const locator = {
            click: async () => undefined,
            count: async () => 1,
            fill: async () => undefined,
            isVisible: async () => true,
            press: async () => undefined,
            textContent: async () => "Ready",
          };
          const context: RuntimeContext = {
            addCookies: async () => undefined,
            close: async () => void events.push("context:close"),
            newCDPSession: async () => captureSession(),
            pages: () => [page],
            newPage: async () => page,
            route: async () => undefined,
            routeWebSocket: async () => undefined,
          };
          const page: RuntimePage = {
            close: async () => {
              events.push("page:late-close");
              return new Promise<void>(() => undefined);
            },
            context: () => context,
            evaluate: async () => true,
            getByTestId: () => locator,
            goto: async () => null,
            locator: () => locator,
            url: () => "https://preview.scotty.example/",
            video: () => null,
          };
          latePage.resolve(page);
          yield* Effect.promise(() => vi.runAllTimersAsync());
          assert.deepStrictEqual(events, [
            "context:close",
            "browser:close",
            "context:close",
            "browser:close",
          ]);
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
  );

  it.effect("preserves a screenshot failure when later browser cleanup also times out", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
      () =>
        Effect.gen(function* () {
          const events: string[] = [];
          const browserClose = deferredPromise<void>();
          const locator = {
            click: async () => undefined,
            count: async () => 1,
            fill: async () => undefined,
            isVisible: async () => true,
            press: async () => undefined,
            textContent: async () => "Ready",
          };
          const context: RuntimeContext = {
            addCookies: async () => undefined,
            close: async () => undefined,
            newCDPSession: async () =>
              captureSession(async () =>
                Promise.reject(new Error("private screenshot protocol failure")),
              ),
            pages: () => [page],
            newPage: async () => page,
            route: async () => undefined,
            routeWebSocket: async () => undefined,
          };
          const page: RuntimePage = {
            close: async () => void events.push("page:close"),
            context: () => context,
            evaluate: async () => true,
            getByTestId: () => locator,
            goto: async () => null,
            locator: () => locator,
            url: () => "https://preview.scotty.example/",
            video: () => null,
          };
          const client = makeKitesurfClient(
            binding,
            async () => ({
              close: () => {
                events.push("browser:close");
                return browserClose.promise;
              },
              newContext: async () => context,
              sessionId: () => undefined,
            }),
            0,
          );
          const fiber = yield* client
            .withPage(
              {
                origin: "https://preview.scotty.example",
                cookieSecret: "private-cookie-secret",
              },
              (runtimePage) => runtimePage.screenshot,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          const result = yield* Fiber.join(fiber);

          assert.deepInclude(failureOf(result), {
            operation: "screenshot",
            reason: "ambiguous",
          });
          assert.notInclude(JSON.stringify(result), "private screenshot protocol failure");
          assert.deepStrictEqual(events, ["browser:close"]);
          browserClose.resolve();
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
  );

  it.effect("retries browser cleanup once before publishing successful use", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      let closeCalls = 0;
      let signalFirstClose: (() => void) | undefined;
      const firstClose = new Promise<void>((resolve) => {
        signalFirstClose = resolve;
      });
      const client = makeKitesurfClient(
        binding,
        makeRuntime(state, {
          browserClose: () => {
            closeCalls += 1;
            if (closeCalls === 1) {
              signalFirstClose?.();
              return Promise.reject(new Error("private browser cleanup rejection"));
            }
            return Promise.resolve();
          },
        }),
      );
      const fiber = yield* client
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          () => Effect.succeed("published"),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => firstClose);
      yield* TestClock.adjust(KITESURF_CLEANUP_RETRY_DELAY_MILLIS);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result, "published");
      assert.strictEqual(closeCalls, 2);
      assert.strictEqual(state.events.filter((event) => event === "browser:close").length, 2);
    }),
  );

  it.effect("fails successful use when browser cleanup stays ambiguous", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      let closeCalls = 0;
      let useCalls = 0;
      let signalFirstClose: (() => void) | undefined;
      const firstClose = new Promise<void>((resolve) => {
        signalFirstClose = resolve;
      });
      const client = makeKitesurfClient(
        binding,
        makeRuntime(state, {
          browserClose: () => {
            closeCalls += 1;
            signalFirstClose?.();
            signalFirstClose = undefined;
            return Promise.reject(new Error("private browser cleanup rejection"));
          },
        }),
      );
      const fiber = yield* client
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          () =>
            Effect.sync(() => {
              useCalls += 1;
              return "published";
            }),
        )
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => firstClose);
      yield* TestClock.adjust(KITESURF_CLEANUP_RETRY_DELAY_MILLIS);
      const result = yield* Fiber.join(fiber);

      assert.deepInclude(failureOf(result), {
        operation: "close_browser",
        reason: "cleanup",
      });
      assert.strictEqual(useCalls, 1);
      assert.strictEqual(closeCalls, 2);
      assert.notInclude(JSON.stringify(result), "private browser cleanup rejection");
    }),
  );

  it.effect("retries one fresh pre-use page acquisition without replaying the user flow", () =>
    Effect.gen(function* () {
      const failedState = runtimeState();
      const recoveredState = runtimeState();
      let launches = 0;
      let useCalls = 0;
      let signalFailedPage: (() => void) | undefined;
      const failedPage = new Promise<void>((resolve) => {
        signalFailedPage = resolve;
      });
      const failedLaunch = makeRuntime(failedState, {
        newPageFails: () => {
          signalFailedPage?.();
          signalFailedPage = undefined;
          return true;
        },
      });
      const recoveredLaunch = makeRuntime(recoveredState);
      const client = makeKitesurfClient(binding, (browserBinding, options) => {
        launches += 1;
        return launches === 1
          ? failedLaunch(browserBinding, options)
          : recoveredLaunch(browserBinding, options);
      });
      const fiber = yield* client
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          () =>
            Effect.sync(() => {
              useCalls += 1;
              return "published";
            }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => failedPage);
      yield* TestClock.adjust(KITESURF_ACQUISITION_RETRY_DELAY_MILLIS);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result, "published");
      assert.strictEqual(launches, 2);
      assert.strictEqual(useCalls, 1);
      assert.include(failedState.events, "context:close");
      assert.include(failedState.events, "browser:close");
      assert.include(recoveredState.events, "context:close");
      assert.include(recoveredState.events, "browser:close");
    }),
  );

  it.effect("never retries a browser-shaped failure after the user flow starts", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      let launches = 0;
      let useCalls = 0;
      const client = makeKitesurfClient(binding, (browserBinding, options) => {
        launches += 1;
        return makeRuntime(state)(browserBinding, options);
      });
      const result = yield* client
        .withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          () => {
            useCalls += 1;
            return Effect.fail(
              new KitesurfClientError({ operation: "create_page", reason: "ambiguous" }),
            );
          },
        )
        .pipe(Effect.result);

      assert.deepInclude(failureOf(result), { operation: "create_page", reason: "ambiguous" });
      assert.strictEqual(launches, 1);
      assert.strictEqual(useCalls, 1);
    }),
  );

  it.effect("closes both browsers across two consecutive successful jobs", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      let useCalls = 0;
      const client = makeKitesurfClient(binding, makeRuntime(state));
      const run = () =>
        client.withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          () =>
            Effect.sync(() => {
              useCalls += 1;
              return "published";
            }),
        );

      assert.strictEqual(yield* run(), "published");
      assert.strictEqual(yield* run(), "published");
      assert.strictEqual(useCalls, 2);
      assert.strictEqual(state.events.filter((event) => event === "browser:close").length, 2);
    }),
  );

  it.effect(
    "fails typed unsupported when request interception is unavailable and still closes resources",
    () =>
      Effect.gen(function* () {
        const state = runtimeState();
        const client = makeKitesurfClient(binding, makeRuntime(state, { routeSupported: false }));
        const error = yield* Effect.flip(
          client.withPage(
            {
              origin: "https://preview.scotty.example",
              cookieSecret: "private-cookie-secret",
            },
            () => Effect.void,
          ),
        );

        assert.strictEqual(error.operation, "install_network_guard");
        assert.strictEqual(error.reason, "unsupported");
        assert.notInclude(state.events, "page:open");
        assert.notInclude(state.events, "page:close");
        assert.include(state.events, "context:close");
        assert.strictEqual(state.events.at(-1), "browser:close");
      }),
  );

  it.effect("fails typed unsupported when WebSocket routing is unavailable", () =>
    Effect.gen(function* () {
      const state = runtimeState();
      const client = makeKitesurfClient(
        binding,
        makeRuntime(state, { webSocketRouteSupported: false }),
      );
      const error = yield* Effect.flip(
        client.withPage(
          {
            origin: "https://preview.scotty.example",
            cookieSecret: "private-cookie-secret",
          },
          () => Effect.void,
        ),
      );

      assert.strictEqual(error.operation, "install_network_guard");
      assert.strictEqual(error.reason, "unsupported");
      assert.ok(state.requestHandler !== undefined);
      assert.notInclude(state.events, "page:open");
      assert.notInclude(state.events, "page:close");
      assert.include(state.events, "context:close");
      assert.strictEqual(state.events.at(-1), "browser:close");
    }),
  );
});
