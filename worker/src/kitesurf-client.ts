import type {
  BrowserContext,
  BrowserWorker,
  Locator,
  Page,
  Request as PlaywrightRequest,
  Route,
  SessionlessBrowser,
  WebSocketRoute,
} from "@cloudflare/playwright";
import { Context, Effect, Exit, Schema } from "effect";
import {
  EvidenceKitesurfOperationSchema,
  EvidenceKitesurfReasonSchema,
  type EvidenceLocator,
} from "./evidence-contracts";
import { EVIDENCE_PREVIEW_COOKIE } from "./evidence-preview";

export const KITESURF_OPERATION_TIMEOUT_MILLIS = 5_000;
export const KITESURF_SCREENSHOT_TIMEOUT_MILLIS = 15_000;
export const KITESURF_RESOURCE_TIMEOUT_MILLIS = 15_000;
const KITESURF_MAX_SAME_ORIGIN_REDIRECTS = 10;
const KITESURF_MAX_CSS_SELECTOR_LENGTH = 512;
const PLAYWRIGHT_SELECTOR_ENGINE_PATTERN =
  /^(?:css|xpath|text|id|data-testid|data-test-id|data-test|role|_react|_vue|internal:[a-z-]+)=/iu;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class KitesurfClientError extends Schema.TaggedErrorClass<KitesurfClientError>()(
  "KitesurfClientError",
  {
    operation: EvidenceKitesurfOperationSchema,
    reason: EvidenceKitesurfReasonSchema,
  },
) {}

export interface KitesurfPage {
  readonly goto: (path: string) => Effect.Effect<void, KitesurfClientError>;
  readonly click: (locator: EvidenceLocator) => Effect.Effect<void, KitesurfClientError>;
  readonly fill: (
    locator: EvidenceLocator,
    value: string,
  ) => Effect.Effect<void, KitesurfClientError>;
  readonly press: (
    locator: EvidenceLocator,
    key: string,
  ) => Effect.Effect<void, KitesurfClientError>;
  readonly isVisible: (locator: EvidenceLocator) => Effect.Effect<boolean, KitesurfClientError>;
  readonly textContent: (
    locator: EvidenceLocator,
  ) => Effect.Effect<string | null, KitesurfClientError>;
  readonly count: (locator: EvidenceLocator) => Effect.Effect<number, KitesurfClientError>;
  readonly urlPath: Effect.Effect<string, KitesurfClientError>;
  readonly screenshot: Effect.Effect<Uint8Array, KitesurfClientError>;
}

export interface KitesurfPageOptions {
  readonly origin: string;
  readonly cookieSecret: string;
  readonly viewport?: { readonly width: number; readonly height: number };
}

export interface KitesurfClientShape {
  readonly withPage: <A, E, R>(
    options: KitesurfPageOptions,
    use: (page: KitesurfPage) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | KitesurfClientError, R>;
}

export class KitesurfClient extends Context.Service<KitesurfClient, KitesurfClientShape>()(
  "scotty/KitesurfClient",
) {}

type KitesurfRuntimeLocator = Pick<
  Locator,
  "click" | "count" | "fill" | "isVisible" | "press" | "textContent"
>;

interface KitesurfCssDocument {
  readonly createDocumentFragment: () => {
    readonly querySelector: (value: string) => unknown;
  };
}

declare const document: KitesurfCssDocument;

interface KitesurfRuntimePage {
  readonly close: Page["close"];
  readonly evaluate: Page["evaluate"];
  readonly getByTestId: (value: string) => KitesurfRuntimeLocator;
  readonly goto: Page["goto"];
  readonly locator: (value: string) => KitesurfRuntimeLocator;
  readonly screenshot: Page["screenshot"];
  readonly url: Page["url"];
}

interface KitesurfRuntimeContext {
  readonly addCookies: BrowserContext["addCookies"];
  readonly close: BrowserContext["close"];
  readonly newPage: () => Promise<KitesurfRuntimePage>;
  readonly pages: () => ReadonlyArray<KitesurfRuntimePage>;
  readonly route?: BrowserContext["route"];
  readonly routeWebSocket?: BrowserContext["routeWebSocket"];
}

interface KitesurfRuntimeBrowser {
  readonly close: SessionlessBrowser["close"];
  readonly newContext: (
    options: Parameters<SessionlessBrowser["newContext"]>[0],
  ) => Promise<KitesurfRuntimeContext>;
  readonly sessionId: () => string | undefined;
}

export type KitesurfRuntimeLauncher = (binding: BrowserWorker) => Promise<KitesurfRuntimeBrowser>;

const launchRuntimeKitesurf: KitesurfRuntimeLauncher = async (binding) => {
  const { launch } = await import("@cloudflare/playwright");
  return launch(binding, { browser: "kitesurf" });
};

const nativePromiseTimeout = <A>(
  operation: KitesurfClientError["operation"],
  reason: KitesurfClientError["reason"],
  evaluate: () => Promise<A>,
  timeoutMillis: number,
  compensateLateSuccess?: (value: A) => Promise<void>,
): Promise<A> =>
  new Promise((resolve, reject) => {
    let waiting = true;
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native Playwright promises must be bounded even while Effect acquisition and release are uninterruptible
    const timeout = setTimeout(() => {
      waiting = false;
      // oxlint-disable-next-line scotty/no-promise-reject -- boundary: this native timer must settle the Playwright Promise before Effect can decode the typed timeout
      reject(new KitesurfClientError({ operation, reason }));
    }, timeoutMillis);
    void Promise.resolve()
      .then(evaluate)
      .then(
        (value) => {
          if (waiting) {
            waiting = false;
            clearTimeout(timeout);
            resolve(value);
            return;
          }
          if (compensateLateSuccess !== undefined)
            void compensateLateSuccess(value).then(
              () => undefined,
              () => undefined,
            );
        },
        (cause) => {
          if (!waiting) return;
          waiting = false;
          clearTimeout(timeout);
          // oxlint-disable-next-line scotty/no-promise-reject -- boundary: the native Playwright rejection is forwarded once into the surrounding Effect.tryPromise adapter
          reject(cause);
        },
      );
  });

const runtimeEffect = <A>(
  operation: KitesurfClientError["operation"],
  reason: KitesurfClientError["reason"],
  evaluate: () => Promise<A>,
): Effect.Effect<A, KitesurfClientError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new KitesurfClientError({ operation, reason }),
  });

const boundedRuntimeEffect = <A>(
  operation: KitesurfClientError["operation"],
  reason: KitesurfClientError["reason"],
  evaluate: () => Promise<A>,
  timeoutMillis: number,
  compensateLateSuccess?: (value: A) => Promise<void>,
): Effect.Effect<A, KitesurfClientError> =>
  runtimeEffect(operation, reason, () =>
    nativePromiseTimeout(operation, reason, evaluate, timeoutMillis, compensateLateSuccess),
  );

const browserAcceptsCssSelector = (value: string): boolean => {
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: querySelector is the browser's CSS parser and reports malformed selectors only by throwing a DOMException
  try {
    document.createDocumentFragment().querySelector(value);
    return true;
  } catch {
    return false;
  }
};

const locatorFor = (
  page: KitesurfRuntimePage,
  locator: EvidenceLocator,
  operation: KitesurfClientError["operation"],
): Effect.Effect<KitesurfRuntimeLocator, KitesurfClientError> => {
  if (locator.kind === "testId")
    return Effect.try({
      try: () => page.getByTestId(locator.value),
      catch: () => new KitesurfClientError({ operation, reason: "unsupported" }),
    });
  if (
    locator.value.length === 0 ||
    locator.value.length > KITESURF_MAX_CSS_SELECTOR_LENGTH ||
    PLAYWRIGHT_SELECTOR_ENGINE_PATTERN.test(locator.value)
  )
    return Effect.fail(new KitesurfClientError({ operation, reason: "unsupported" }));
  return runtimeEffect(operation, "unsupported", () =>
    page.evaluate(browserAcceptsCssSelector, locator.value),
  ).pipe(
    Effect.flatMap((valid) =>
      valid
        ? Effect.try({
            try: () => page.locator(locator.value),
            catch: () => new KitesurfClientError({ operation, reason: "unsupported" }),
          })
        : Effect.fail(new KitesurfClientError({ operation, reason: "unsupported" })),
    ),
  );
};

const exactOrigin = (value: string): string | undefined => {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value ? url.origin : undefined;
};

const sameOriginUrl = (origin: string, path: string): string | undefined => {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("#") ||
    !URL.canParse(path, origin)
  )
    return undefined;
  const url = new URL(path, origin);
  return url.origin === origin ? url.href : undefined;
};

const closeEffect = (
  operation: Extract<
    KitesurfClientError["operation"],
    "close_browser" | "close_context" | "close_page"
  >,
  close: () => Promise<void>,
  timeoutMillis: number,
): Effect.Effect<void, KitesurfClientError> =>
  boundedRuntimeEffect(operation, "cleanup", close, timeoutMillis);

const compensateLateResource = (
  operation: Extract<
    KitesurfClientError["operation"],
    "close_browser" | "close_context" | "close_page"
  >,
  close: () => Promise<void>,
  timeoutMillis: number,
): Promise<void> => nativePromiseTimeout(operation, "cleanup", close, timeoutMillis);

const releaseResource = (
  operation: Extract<
    KitesurfClientError["operation"],
    "close_browser" | "close_context" | "close_page"
  >,
  close: () => Promise<void>,
  timeoutMillis: number,
  useExit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void, KitesurfClientError> => {
  const release = closeEffect(operation, close, timeoutMillis);
  if (Exit.isSuccess(useExit)) return release;
  return release.pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        console.error("Kitesurf cleanup failed after an earlier evidence failure", {
          operation: error.operation,
          reason: error.reason,
        }),
      ),
    ),
  );
};

const singlePage = (
  context: KitesurfRuntimeContext,
  page: KitesurfRuntimePage,
): Effect.Effect<void, KitesurfClientError> =>
  Effect.try({
    try: () => context.pages(),
    catch: () => new KitesurfClientError({ operation: "create_page", reason: "unsupported" }),
  }).pipe(
    Effect.flatMap((pages) =>
      pages.length === 1 && pages[0] === page
        ? Effect.void
        : Effect.fail(new KitesurfClientError({ operation: "create_page", reason: "unsupported" })),
    ),
  );

const makePage = (
  origin: string,
  context: KitesurfRuntimeContext,
  page: KitesurfRuntimePage,
): KitesurfPage => {
  const checked = <A>(
    operation: KitesurfClientError["operation"],
    evaluate: () => Promise<A>,
  ): Effect.Effect<A, KitesurfClientError> =>
    runtimeEffect(operation, "ambiguous", evaluate).pipe(
      Effect.tap(() => singlePage(context, page)),
    );
  const checkedLocator = <A>(
    operation: KitesurfClientError["operation"],
    locator: EvidenceLocator,
    evaluate: (runtimeLocator: KitesurfRuntimeLocator) => Promise<A>,
  ): Effect.Effect<A, KitesurfClientError> =>
    locatorFor(page, locator, operation).pipe(
      Effect.flatMap((runtimeLocator) => checked(operation, () => evaluate(runtimeLocator))),
    );

  return {
    goto: (path) => {
      const url = sameOriginUrl(origin, path);
      return url === undefined
        ? Effect.fail(new KitesurfClientError({ operation: "goto", reason: "unsupported" }))
        : checked("goto", () =>
            page
              .goto(url, { timeout: KITESURF_OPERATION_TIMEOUT_MILLIS, waitUntil: "load" })
              .then(() => undefined),
          );
    },
    click: (locator) =>
      checkedLocator("click", locator, (runtimeLocator) =>
        runtimeLocator.click({ timeout: KITESURF_OPERATION_TIMEOUT_MILLIS }),
      ),
    fill: (locator, value) =>
      checkedLocator("fill", locator, (runtimeLocator) =>
        runtimeLocator.fill(value, {
          timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
        }),
      ),
    press: (locator, key) =>
      checkedLocator("press", locator, (runtimeLocator) =>
        runtimeLocator.press(key, {
          timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
        }),
      ),
    isVisible: (locator) =>
      checkedLocator("visible", locator, (runtimeLocator) => runtimeLocator.isVisible()),
    textContent: (locator) =>
      checkedLocator("text_exact", locator, (runtimeLocator) =>
        runtimeLocator.textContent({
          timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
        }),
      ),
    count: (locator) =>
      checkedLocator("count", locator, (runtimeLocator) => runtimeLocator.count()),
    urlPath: Effect.try({
      try: () => page.url(),
      catch: () => new KitesurfClientError({ operation: "url_path", reason: "ambiguous" }),
    }).pipe(
      Effect.flatMap((value) => {
        if (!URL.canParse(value))
          return Effect.fail(
            new KitesurfClientError({ operation: "url_path", reason: "ambiguous" }),
          );
        const url = new URL(value);
        return url.origin !== origin
          ? Effect.fail(new KitesurfClientError({ operation: "url_path", reason: "unsupported" }))
          : singlePage(context, page).pipe(Effect.as(`${url.pathname}${url.search}`));
      }),
    ),
    screenshot: boundedRuntimeEffect(
      "screenshot",
      "ambiguous",
      () => page.screenshot(),
      KITESURF_SCREENSHOT_TIMEOUT_MILLIS,
    ).pipe(Effect.tap(() => singlePage(context, page))),
  };
};

const fulfillGuardedRequest = async (
  route: Route,
  request: PlaywrightRequest,
  origin: string,
): Promise<void> => {
  const requestUrl = request.url();
  if (!URL.canParse(requestUrl) || new URL(requestUrl).origin !== origin) {
    await route.abort("blockedbyclient");
    return;
  }
  const method = request.method().toUpperCase();
  let nextUrl = requestUrl;
  for (let redirect = 0; redirect <= KITESURF_MAX_SAME_ORIGIN_REDIRECTS; redirect += 1) {
    const response = await route.fetch({
      url: nextUrl,
      maxRedirects: 0,
      maxRetries: 0,
      timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
    });
    const location = response.headers()["location"];
    if (!REDIRECT_STATUSES.has(response.status()) || location === undefined) {
      await route.fulfill({ response });
      await response.dispose();
      return;
    }
    await response.dispose();
    if ((method !== "GET" && method !== "HEAD") || !URL.canParse(location, nextUrl)) {
      await route.abort("blockedbyclient");
      return;
    }
    const redirected = new URL(location, nextUrl);
    if (redirected.origin !== origin) {
      await route.abort("blockedbyclient");
      return;
    }
    nextUrl = redirected.href;
  }
  await route.abort("blockedbyclient");
};

const installContextPolicy = (
  context: KitesurfRuntimeContext,
  origin: string,
  cookieSecret: string,
): Effect.Effect<void, KitesurfClientError> =>
  Effect.gen(function* () {
    const routeRequests = context.route;
    if (routeRequests === undefined)
      return yield* new KitesurfClientError({
        operation: "install_network_guard",
        reason: "unsupported",
      });
    yield* runtimeEffect("install_network_guard", "unsupported", () =>
      routeRequests.call(context, "**/*", (route: Route, request: PlaywrightRequest) =>
        fulfillGuardedRequest(route, request, origin),
      ),
    );
    const routeWebSockets = context.routeWebSocket;
    if (routeWebSockets === undefined)
      return yield* new KitesurfClientError({
        operation: "install_network_guard",
        reason: "unsupported",
      });
    yield* runtimeEffect("install_network_guard", "unsupported", () =>
      routeWebSockets.call(context, "**/*", (route: WebSocketRoute) =>
        route.close({ code: 1_008, reason: "Evidence preview is HTTP-only" }),
      ),
    );
    yield* runtimeEffect("install_cookie", "unsupported", () =>
      context.addCookies([
        {
          httpOnly: true,
          name: EVIDENCE_PREVIEW_COOKIE,
          sameSite: "Strict",
          secure: true,
          url: `${origin}/`,
          value: cookieSecret,
        },
      ]),
    );
  });

export const makeKitesurfClient = (
  binding: BrowserWorker,
  launchBrowser: KitesurfRuntimeLauncher = launchRuntimeKitesurf,
  resourceTimeoutMillis = KITESURF_RESOURCE_TIMEOUT_MILLIS,
): KitesurfClientShape =>
  KitesurfClient.of({
    withPage: (options, use) => {
      const origin = exactOrigin(options.origin);
      if (origin === undefined)
        return Effect.fail(
          new KitesurfClientError({ operation: "install_network_guard", reason: "unsupported" }),
        );
      return Effect.acquireUseRelease(
        boundedRuntimeEffect(
          "launch",
          "ambiguous",
          () => launchBrowser(binding),
          resourceTimeoutMillis,
          (browser) =>
            compensateLateResource("close_browser", () => browser.close(), resourceTimeoutMillis),
        ),
        (browser) =>
          Effect.gen(function* () {
            const sessionId = yield* Effect.try({
              try: () => browser.sessionId(),
              catch: () =>
                new KitesurfClientError({
                  operation: "verify_sessionless",
                  reason: "unsupported",
                }),
            });
            if (sessionId !== undefined)
              return yield* new KitesurfClientError({
                operation: "verify_sessionless",
                reason: "unsupported",
              });
            return yield* Effect.acquireUseRelease(
              boundedRuntimeEffect(
                "create_context",
                "ambiguous",
                () =>
                  browser.newContext({
                    serviceWorkers: "block",
                    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
                  }),
                resourceTimeoutMillis,
                (context) =>
                  compensateLateResource(
                    "close_context",
                    () => context.close(),
                    resourceTimeoutMillis,
                  ),
              ),
              (context) =>
                installContextPolicy(context, origin, options.cookieSecret).pipe(
                  Effect.andThen(
                    boundedRuntimeEffect(
                      "create_page",
                      "ambiguous",
                      () => context.newPage(),
                      resourceTimeoutMillis,
                      (page) =>
                        compensateLateResource(
                          "close_page",
                          () => page.close(),
                          resourceTimeoutMillis,
                        ),
                    ).pipe(
                      Effect.flatMap((page) =>
                        singlePage(context, page).pipe(
                          Effect.andThen(use(makePage(origin, context, page))),
                        ),
                      ),
                    ),
                  ),
                ),
              (context, exit) =>
                releaseResource(
                  "close_context",
                  () => context.close(),
                  resourceTimeoutMillis,
                  exit,
                ),
            );
          }),
        (browser, exit) =>
          releaseResource("close_browser", () => browser.close(), resourceTimeoutMillis, exit),
      );
    },
  });
