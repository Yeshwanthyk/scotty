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
import { vi } from "vitest";

const playwright = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/playwright", () => playwright);

import { EVIDENCE_PREVIEW_COOKIE } from "../src/evidence-preview";
import {
  KITESURF_OPERATION_TIMEOUT_MILLIS,
  makeKitesurfClient,
  type KitesurfRuntimeLauncher,
} from "../src/kitesurf-client";

const binding: BrowserWorker = { fetch: globalThis.fetch };
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface RuntimeState {
  readonly events: Array<string>;
  readonly cookies: Array<Parameters<BrowserContext["addCookies"]>[0][number]>;
  pageOptions: unknown;
  screenshotOptions: unknown;
  requestHandler: Parameters<BrowserContext["route"]>[1] | undefined;
  webSocketHandler: Parameters<BrowserContext["routeWebSocket"]>[1] | undefined;
}

const makeRuntime = (
  state: RuntimeState,
  options: {
    readonly cssSelectorValidator?: (value: string) => boolean;
    readonly routeSupported?: boolean;
    readonly webSocketRouteSupported?: boolean;
  } = {},
): KitesurfRuntimeLauncher => {
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
    goto: async (url: string) => {
      state.events.push(`page:goto:${url}`);
      return null;
    },
    locator: (value: string) => {
      state.events.push(`page:locator:${value}`);
      return locator;
    },
    screenshot: async (callOptions?: { readonly timeout?: number; readonly type?: string }) => {
      state.events.push("page:screenshot");
      state.screenshotOptions = callOptions;
      return PNG;
    },
    url: () => "https://preview.scotty.example/ready?mode=test",
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
    pages: () => {
      state.events.push("context:pages");
      return [page];
    },
    ...(options.routeSupported === false ? {} : { route }),
    ...(options.webSocketRouteSupported === false ? {} : { routeWebSocket }),
  };
  return async () => ({
    close: async () => {
      state.events.push("browser:close");
    },
    newPage: async (pageOptions) => {
      state.events.push("page:open");
      state.pageOptions = pageOptions;
      return page;
    },
    sessionId: () => {
      state.events.push("browser:sessionless");
      return undefined;
    },
  });
};

const runtimeState = (): RuntimeState => ({
  events: [],
  cookies: [],
  pageOptions: undefined,
  screenshotOptions: undefined,
  requestHandler: undefined,
  webSocketHandler: undefined,
});

type RuntimeBrowser = Awaited<ReturnType<KitesurfRuntimeLauncher>>;
type RuntimePage = Awaited<ReturnType<RuntimeBrowser["newPage"]>>;
type RuntimeContext = ReturnType<RuntimePage["context"]>;

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
  it.effect("launches the Worker binding with the sessionless Kitesurf selector", () =>
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
      assert.deepStrictEqual(state.screenshotOptions, {
        type: "png",
        timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
      });
      assert.include(state.events, "browser:sessionless");
      assert.include(state.events, `locator:click:${KITESURF_OPERATION_TIMEOUT_MILLIS}`);
      assert.include(state.events, "page:screenshot");
      assert.notInclude(state.events, "page:close");
      assert.notInclude(state.events, "context:close");
      assert.strictEqual(state.events.at(-1), "browser:close");
      const setupAndFirstUse = [
        "page:context",
        "context:route",
        "context:route-websocket",
        "context:cookies",
        "context:pages",
        "page:goto:https://preview.scotty.example/ready?mode=test",
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
            newPage: async () => new Promise<RuntimePage>(() => undefined),
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
          const client = makeKitesurfClient(
            binding,
            async () => ({
              close: async () => void events.push("browser:close"),
              newPage: () => latePage.promise,
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
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
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
            pages: () => [page],
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
            screenshot: async () => PNG,
            url: () => "https://preview.scotty.example/",
          };
          latePage.resolve(page);
          yield* Effect.promise(() => vi.runAllTimersAsync());
          assert.deepStrictEqual(events, ["browser:close", "page:late-close"]);
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
            pages: () => [page],
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
            screenshot: async () => Promise.reject(new Error("private screenshot failure")),
            url: () => "https://preview.scotty.example/",
          };
          const client = makeKitesurfClient(
            binding,
            async () => ({
              close: () => {
                events.push("browser:close");
                return browserClose.promise;
              },
              newPage: async () => page,
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
          assert.notInclude(JSON.stringify(result), "private screenshot failure");
          assert.deepStrictEqual(events, ["browser:close"]);
          browserClose.resolve();
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
  );

  it.effect("reports browser cleanup timeout without closing the owned page or context", () =>
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
          const context = {
            addCookies: async () => undefined,
            close: async () => void events.push("context:close"),
            pages: () => [page],
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
            screenshot: async () => PNG,
            url: () => "https://preview.scotty.example/",
          };
          const client = makeKitesurfClient(
            binding,
            async () => ({
              close: () => {
                events.push("browser:close");
                return browserClose.promise;
              },
              newPage: async () => page,
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
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          const result = yield* Fiber.join(fiber);

          assert.deepInclude(failureOf(result), {
            operation: "close_browser",
            reason: "cleanup",
          });
          assert.deepStrictEqual(events, ["browser:close"]);
          browserClose.resolve();
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
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
        assert.include(state.events, "page:open");
        assert.include(state.events, "page:context");
        assert.notInclude(state.events, "page:close");
        assert.notInclude(state.events, "context:close");
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
      assert.include(state.events, "page:open");
      assert.include(state.events, "page:context");
      assert.notInclude(state.events, "page:close");
      assert.notInclude(state.events, "context:close");
      assert.strictEqual(state.events.at(-1), "browser:close");
    }),
  );
});
