import { assert, describe, it } from "@effect/vitest";
import type {
  BrowserContext,
  BrowserWorker,
  Request as PlaywrightRequest,
  Route,
  WebSocketRoute,
} from "@cloudflare/playwright";
import { Effect } from "effect";
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
  contextOptions: unknown;
  requestHandler: Parameters<BrowserContext["route"]>[1] | undefined;
  webSocketHandler: Parameters<BrowserContext["routeWebSocket"]>[1] | undefined;
}

const makeRuntime = (
  state: RuntimeState,
  options: {
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
    getByTestId: () => locator,
    goto: async (url: string) => {
      state.events.push(`page:goto:${url}`);
      return null;
    },
    locator: () => locator,
    screenshot: async () => PNG,
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
      assert.isBelow(state.events.indexOf("page:close"), state.events.indexOf("context:close"));
      assert.isBelow(state.events.indexOf("context:close"), state.events.indexOf("browser:close"));
      assert.isFalse(state.events.some((event) => event.includes(secret)));

      let continued = false;
      let aborted = false;
      const handler = state.requestHandler;
      assert.ok(handler !== undefined);
      yield* Effect.promise(() =>
        handler(
          { continue: async () => void (continued = true) } as Route,
          { url: () => "https://preview.scotty.example/app.js" } as PlaywrightRequest,
        ),
      );
      yield* Effect.promise(() =>
        handler(
          { abort: async () => void (aborted = true) } as Route,
          { url: () => "https://external.example/track.js" } as PlaywrightRequest,
        ),
      );
      assert.isTrue(continued);
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
