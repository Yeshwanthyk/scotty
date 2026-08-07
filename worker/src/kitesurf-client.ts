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
import { Context, Effect, Schema } from "effect";
import type { EvidenceLocator } from "./evidence-contracts";
import { EVIDENCE_PREVIEW_COOKIE } from "./evidence-preview";

export const KITESURF_OPERATION_TIMEOUT_MILLIS = 5_000;

export class KitesurfClientError extends Schema.TaggedErrorClass<KitesurfClientError>()(
  "KitesurfClientError",
  {
    operation: Schema.Literals([
      "launch",
      "verify_sessionless",
      "create_context",
      "install_network_guard",
      "install_cookie",
      "create_page",
      "goto",
      "click",
      "fill",
      "press",
      "visible",
      "text_exact",
      "count",
      "url_path",
      "screenshot",
      "close_page",
      "close_context",
      "close_browser",
    ]),
    reason: Schema.Literals(["ambiguous", "cleanup", "unsupported"]),
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

interface KitesurfRuntimePage {
  readonly close: Page["close"];
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

const runtimeEffect = <A>(
  operation: KitesurfClientError["operation"],
  reason: KitesurfClientError["reason"],
  evaluate: () => Promise<A>,
): Effect.Effect<A, KitesurfClientError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new KitesurfClientError({ operation, reason }),
  });

const locatorFor = (page: KitesurfRuntimePage, locator: EvidenceLocator): KitesurfRuntimeLocator =>
  locator.kind === "testId" ? page.getByTestId(locator.value) : page.locator(locator.value);

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
): Effect.Effect<void, KitesurfClientError> => runtimeEffect(operation, "cleanup", close);

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
      checked("click", () =>
        locatorFor(page, locator).click({ timeout: KITESURF_OPERATION_TIMEOUT_MILLIS }),
      ),
    fill: (locator, value) =>
      checked("fill", () =>
        locatorFor(page, locator).fill(value, {
          timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
        }),
      ),
    press: (locator, key) =>
      checked("press", () =>
        locatorFor(page, locator).press(key, {
          timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
        }),
      ),
    isVisible: (locator) =>
      checked("visible", () =>
        locatorFor(page, locator).isVisible({ timeout: KITESURF_OPERATION_TIMEOUT_MILLIS }),
      ),
    textContent: (locator) =>
      checked("text_exact", () =>
        locatorFor(page, locator).textContent({
          timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
        }),
      ),
    count: (locator) => checked("count", () => locatorFor(page, locator).count()),
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
    screenshot: checked("screenshot", () =>
      page.screenshot({
        fullPage: false,
        timeout: KITESURF_OPERATION_TIMEOUT_MILLIS,
        type: "png",
      }),
    ),
  };
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
      routeRequests.call(context, "**/*", (route: Route, request: PlaywrightRequest) => {
        const requestUrl = request.url();
        return URL.canParse(requestUrl) && new URL(requestUrl).origin === origin
          ? route.continue()
          : route.abort("blockedbyclient");
      }),
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
): KitesurfClientShape =>
  KitesurfClient.of({
    withPage: (options, use) => {
      const origin = exactOrigin(options.origin);
      if (origin === undefined)
        return Effect.fail(
          new KitesurfClientError({ operation: "install_network_guard", reason: "unsupported" }),
        );
      return Effect.acquireUseRelease(
        runtimeEffect("launch", "ambiguous", () => launchBrowser(binding)),
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
              runtimeEffect("create_context", "ambiguous", () =>
                browser.newContext({
                  serviceWorkers: "block",
                  ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
                }),
              ),
              (context) =>
                installContextPolicy(context, origin, options.cookieSecret).pipe(
                  Effect.andThen(
                    Effect.acquireUseRelease(
                      runtimeEffect("create_page", "ambiguous", () => context.newPage()),
                      (page) =>
                        singlePage(context, page).pipe(
                          Effect.andThen(use(makePage(origin, context, page))),
                        ),
                      (page) => closeEffect("close_page", () => page.close()),
                    ),
                  ),
                ),
              (context) => closeEffect("close_context", () => context.close()),
            );
          }),
        (browser) => closeEffect("close_browser", () => browser.close()),
      );
    },
  });
