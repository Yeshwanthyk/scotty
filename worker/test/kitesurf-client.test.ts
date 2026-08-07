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
  KITESURF_SCREENSHOT_TIMEOUT_MILLIS,
  makeKitesurfClient,
  type KitesurfRuntimeLauncher,
} from "../src/kitesurf-client";

const binding: BrowserWorker = { fetch: globalThis.fetch };
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface RuntimeState {
  readonly events: Array<string>;
  readonly cookies: Array<Parameters<BrowserContext["addCookies"]>[0][number]>;
  contextOptions: unknown;
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
    screenshot: async (callOptions?: { readonly timeout?: number }) => {
      state.events.push(`page:screenshot:${callOptions?.timeout ?? 0}`);
      return PNG;
    },
    url: () => "https://preview.scotty.example/ready?mode=test",
  };
  const route: BrowserContext["route"] = async (_url, handler) => {
    state.requestHandler = handler;
  };
  const routeWebSocket: BrowserContext["routeWebSocket"] = async (_url, handler) => {
    state.webSocketHandler = handler;
  };
  const context = {
    addCookies: async (cookies: Parameters<BrowserContext["addCookies"]>[0]) => {
      state.cookies.push(...cookies);
    },
    close: async () => {
      state.events.push("context:close");
    },
    newPage: async () => {
      state.events.push("page:open");
      return page;
    },
    pages: () => [page],
    ...(options.routeSupported === false ? {} : { route }),
    ...(options.webSocketRouteSupported === false ? {} : { routeWebSocket }),
  };
  return async () => ({
    close: async () => {
      state.events.push("browser:close");
    },
    newContext: async (contextOptions) => {
      state.events.push("context:open");
      state.contextOptions = contextOptions;
      return context;
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
  contextOptions: undefined,
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
      assert.deepStrictEqual(state.contextOptions, {
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
      assert.include(state.events, "browser:sessionless");
      assert.include(state.events, `locator:click:${KITESURF_OPERATION_TIMEOUT_MILLIS}`);
      assert.include(state.events, `page:screenshot:${KITESURF_SCREENSHOT_TIMEOUT_MILLIS}`);
      assert.isBelow(state.events.indexOf("page:close"), state.events.indexOf("context:close"));
      assert.isBelow(state.events.indexOf("context:close"), state.events.indexOf("browser:close"));
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
            newContext: async () => new Promise<RuntimeContext>(() => undefined),
            sessionId: () => undefined,
          });
          yield* Effect.promise(() => vi.runAllTimersAsync());
          assert.deepStrictEqual(events, ["browser:late-close"]);
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
  );

  it.effect("compensates contexts and pages acquired after their native timeout", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
      () =>
        Effect.gen(function* () {
          const contextEvents: string[] = [];
          const lateContext = deferredPromise<RuntimeContext>();
          const contextClient = makeKitesurfClient(
            binding,
            async () => ({
              close: async () => void contextEvents.push("browser:close"),
              newContext: () => lateContext.promise,
              sessionId: () => undefined,
            }),
            0,
          );
          const contextFiber = yield* contextClient
            .withPage(
              {
                origin: "https://preview.scotty.example",
                cookieSecret: "private-cookie-secret",
              },
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          const contextResult = yield* Fiber.join(contextFiber);
          assert.deepInclude(failureOf(contextResult), {
            operation: "create_context",
            reason: "ambiguous",
          });
          lateContext.resolve({
            addCookies: async () => undefined,
            close: async () => void contextEvents.push("context:late-close"),
            newPage: async () => new Promise<RuntimePage>(() => undefined),
            pages: () => [],
          });
          yield* Effect.promise(() => vi.runAllTimersAsync());
          assert.deepStrictEqual(contextEvents, ["browser:close", "context:late-close"]);

          const pageEvents: string[] = [];
          const latePage = deferredPromise<RuntimePage>();
          const context: RuntimeContext = {
            addCookies: async () => undefined,
            close: async () => void pageEvents.push("context:close"),
            newPage: () => latePage.promise,
            pages: () => [],
            route: async () => undefined,
            routeWebSocket: async () => undefined,
          };
          const pageClient = makeKitesurfClient(
            binding,
            async () => ({
              close: async () => void pageEvents.push("browser:close"),
              newContext: async () => context,
              sessionId: () => undefined,
            }),
            0,
          );
          const pageFiber = yield* pageClient
            .withPage(
              {
                origin: "https://preview.scotty.example",
                cookieSecret: "private-cookie-secret",
              },
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          const pageResult = yield* Fiber.join(pageFiber);
          assert.deepInclude(failureOf(pageResult), {
            operation: "create_page",
            reason: "ambiguous",
          });
          latePage.resolve({
            close: async () => void pageEvents.push("page:late-close"),
          } as RuntimePage);
          yield* Effect.promise(() => vi.runAllTimersAsync());
          assert.deepStrictEqual(pageEvents, ["context:close", "browser:close", "page:late-close"]);
        }),
      () => Effect.sync(() => vi.useRealTimers()),
    ),
  );

  it.effect("reports cleanup timeout and still runs enclosing cleanup", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
      () =>
        Effect.gen(function* () {
          const events: string[] = [];
          const pageClose = deferredPromise<void>();
          const locator = {
            click: async () => undefined,
            count: async () => 1,
            fill: async () => undefined,
            isVisible: async () => true,
            press: async () => undefined,
            textContent: async () => "Ready",
          };
          const page: RuntimePage = {
            close: () => pageClose.promise,
            evaluate: async () => true,
            getByTestId: () => locator,
            goto: async () => null,
            locator: () => locator,
            screenshot: async () => PNG,
            url: () => "https://preview.scotty.example/",
          };
          const context: RuntimeContext = {
            addCookies: async () => undefined,
            close: async () => void events.push("context:close"),
            newPage: async () => page,
            pages: () => [page],
            route: async () => undefined,
            routeWebSocket: async () => undefined,
          };
          const client = makeKitesurfClient(
            binding,
            async () => ({
              close: async () => void events.push("browser:close"),
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
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          const result = yield* Fiber.join(fiber);

          assert.deepInclude(failureOf(result), {
            operation: "close_page",
            reason: "cleanup",
          });
          assert.deepStrictEqual(events, ["context:close", "browser:close"]);
          pageClose.resolve();
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
        assert.notInclude(state.events, "page:open");
        assert.deepStrictEqual(state.events.slice(-2), ["context:close", "browser:close"]);
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
      assert.deepStrictEqual(state.events.slice(-2), ["context:close", "browser:close"]);
    }),
  );
});
