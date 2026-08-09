import type {
  BrowserContext,
  BrowserContextOptions,
  BrowserWorker,
  CDPSession,
  Locator,
  Page,
  Request as PlaywrightRequest,
  Route,
  SessionlessBrowser,
  Video,
  WebSocketRoute,
} from "@cloudflare/playwright";
import { Context, Effect, Exit, Schema } from "effect";
import { readFile, stat, unlink } from "node:fs/promises";
import {
  EVIDENCE_MAX_FRAME_BYTES,
  EVIDENCE_MAX_VIDEO_BYTES,
  EvidenceKitesurfOperationSchema,
  EvidenceKitesurfReasonSchema,
  type EvidenceLocator,
} from "./evidence-contracts";
import { EVIDENCE_PREVIEW_COOKIE } from "./evidence-preview";

export const KITESURF_OPERATION_TIMEOUT_MILLIS = 5_000;
export const KITESURF_NAVIGATION_TIMEOUT_MILLIS = 15_000;
export const KITESURF_SCREENSHOT_TIMEOUT_MILLIS = 15_000;
export const KITESURF_RESOURCE_TIMEOUT_MILLIS = 15_000;
export const KITESURF_VIDEO_TIMEOUT_MILLIS = 30_000;
const KITESURF_MAX_SAME_ORIGIN_REDIRECTS = 10;
const KITESURF_MAX_CSS_SELECTOR_LENGTH = 512;
const KITESURF_MAX_SCREENSHOT_BASE64_LENGTH = Math.ceil(EVIDENCE_MAX_FRAME_BYTES / 3) * 4;
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

export interface KitesurfPageResult<A> {
  readonly value: A;
  readonly video?: Uint8Array;
}

export interface KitesurfClientShape {
  readonly withPage: <A, E, R>(
    options: KitesurfPageOptions,
    use: (page: KitesurfPage) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | KitesurfClientError, R>;
  readonly withRecordedPage?: <A, E, R>(
    options: KitesurfPageOptions,
    use: (page: KitesurfPage) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<KitesurfPageResult<A>, E | KitesurfClientError, R>;
}

export class KitesurfClient extends Context.Service<KitesurfClient, KitesurfClientShape>()(
  "scotty/KitesurfClient",
) {}

export const KITESURF_CLEANUP_RETRY_DELAY_MILLIS = 100;
export const KITESURF_ACQUISITION_RETRY_DELAY_MILLIS = 1_000;

class RetryKitesurfPageAcquisition extends KitesurfClientError {}

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
  readonly context: () => KitesurfRuntimeContext;
  readonly evaluate: Page["evaluate"];
  readonly getByTestId: (value: string) => KitesurfRuntimeLocator;
  readonly goto: Page["goto"];
  readonly locator: (value: string) => KitesurfRuntimeLocator;
  readonly url: Page["url"];
  readonly video: () => KitesurfRuntimeVideo | null;
}

interface KitesurfRuntimeVideo {
  readonly saveAs: Video["saveAs"];
}

interface KitesurfCaptureSession extends Pick<CDPSession, "detach"> {
  readonly send: (
    method: "Page.captureScreenshot",
    params: { readonly format: "png"; readonly captureBeyondViewport: false },
  ) => Promise<unknown>;
}

interface KitesurfRuntimeContext {
  readonly addCookies: BrowserContext["addCookies"];
  readonly close: BrowserContext["close"];
  newCDPSession(): Promise<KitesurfCaptureSession>;
  readonly newPage: () => Promise<KitesurfRuntimePage>;
  readonly pages: () => ReadonlyArray<KitesurfRuntimePage>;
  readonly route?: BrowserContext["route"];
  readonly routeWebSocket?: BrowserContext["routeWebSocket"];
}

interface KitesurfRuntimeBrowser {
  readonly close: SessionlessBrowser["close"];
  readonly newContext: (options: BrowserContextOptions) => Promise<KitesurfRuntimeContext>;
  readonly sessionId: () => string | undefined;
}

export type KitesurfRuntimeLauncher = (
  binding: BrowserWorker,
  options: { readonly recordVideo: boolean },
) => Promise<KitesurfRuntimeBrowser>;

const runtimeContext = (context: BrowserContext): KitesurfRuntimeContext => {
  const pages = new Map<Page, KitesurfRuntimePage>();
  const wrapPage = (page: Page): KitesurfRuntimePage => {
    const existing = pages.get(page);
    if (existing !== undefined) return existing;
    const wrapped: KitesurfRuntimePage = {
      close: page.close.bind(page),
      context: () => ownedContext,
      evaluate: page.evaluate.bind(page),
      getByTestId: page.getByTestId.bind(page),
      goto: page.goto.bind(page),
      locator: page.locator.bind(page),
      url: page.url.bind(page),
      video: () => {
        const video = page.video();
        return video === null ? null : { saveAs: video.saveAs.bind(video) };
      },
    };
    pages.set(page, wrapped);
    return wrapped;
  };
  const ownedContext: KitesurfRuntimeContext = {
    addCookies: context.addCookies.bind(context),
    close: context.close.bind(context),
    newCDPSession: () => {
      const page = context.pages()[0];
      if (page !== undefined) return context.newCDPSession(page);
      // oxlint-disable-next-line scotty/no-promise-reject -- boundary: Playwright cannot create a CDP session without the lifecycle-owned page
      return Promise.reject(
        new KitesurfClientError({ operation: "create_page", reason: "unsupported" }),
      );
    },
    newPage: () => context.newPage().then(wrapPage),
    pages: () => context.pages().map(wrapPage),
    route: context.route.bind(context),
    routeWebSocket: context.routeWebSocket.bind(context),
  };
  return ownedContext;
};

const launchRuntimeKitesurf: KitesurfRuntimeLauncher = async (binding, options) => {
  const { launch } = await import("@cloudflare/playwright");
  const browser = options.recordVideo
    ? await launch(binding)
    : await launch(binding, { browser: "kitesurf" });
  return {
    close: browser.close.bind(browser),
    newContext: (options) => browser.newContext(options).then(runtimeContext),
    sessionId: browser.sessionId.bind(browser),
  };
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
  const reconciledRelease =
    Exit.isSuccess(useExit) && operation === "close_browser"
      ? release.pipe(
          Effect.catch(() =>
            Effect.sleep(KITESURF_CLEANUP_RETRY_DELAY_MILLIS).pipe(Effect.andThen(release)),
          ),
        )
      : release;
  if (Exit.isSuccess(useExit)) return reconciledRelease;
  return reconciledRelease.pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        console.error(
          Exit.isSuccess(useExit)
            ? "Kitesurf cleanup failed after successful evidence use"
            : "Kitesurf cleanup failed after an earlier evidence failure",
          {
            operation: error.operation,
            reason: error.reason,
          },
        ),
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

const screenshotFailure = (): KitesurfClientError =>
  new KitesurfClientError({ operation: "screenshot", reason: "ambiguous" });

const CaptureScreenshotResultSchema = Schema.Struct({ data: Schema.String });
const decodeCaptureScreenshotResult = Schema.decodeUnknownEffect(CaptureScreenshotResultSchema);

const base64Value = (code: number): number | undefined => {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return undefined;
};

const validBase64Payload = (data: string, payloadLength: number): boolean => {
  for (let index = 0; index < payloadLength; index += 1) {
    if (base64Value(data.charCodeAt(index)) === undefined) return false;
  }
  return true;
};

const hasCanonicalBase64Padding = (data: string, padding: number): boolean => {
  if (padding === 0) return true;
  const lastValue = base64Value(data.charCodeAt(data.length - padding - 1));
  if (lastValue === undefined) return false;
  return padding === 1 ? (lastValue & 0b11) === 0 : (lastValue & 0b1111) === 0;
};

const decodeScreenshot = (data: unknown): Effect.Effect<Uint8Array, KitesurfClientError> => {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > KITESURF_MAX_SCREENSHOT_BASE64_LENGTH ||
    data.length % 4 !== 0
  )
    return Effect.fail(screenshotFailure());
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (!validBase64Payload(data, data.length - padding) || !hasCanonicalBase64Padding(data, padding))
    return Effect.fail(screenshotFailure());
  const decodedByteLength = (data.length / 4) * 3 - padding;
  if (decodedByteLength === 0 || decodedByteLength > EVIDENCE_MAX_FRAME_BYTES)
    return Effect.fail(screenshotFailure());
  return Effect.try({
    try: () => atob(data),
    catch: screenshotFailure,
  }).pipe(
    Effect.flatMap((binary) =>
      binary.length === decodedByteLength
        ? Effect.try({
            try: () => Uint8Array.from(binary, (character) => character.charCodeAt(0)),
            catch: screenshotFailure,
          })
        : Effect.fail(screenshotFailure()),
    ),
  );
};

const decodeScreenshotResult = (result: unknown): Effect.Effect<Uint8Array, KitesurfClientError> =>
  decodeCaptureScreenshotResult(result).pipe(
    Effect.mapError(screenshotFailure),
    Effect.flatMap(({ data }) => decodeScreenshot(data)),
  );

const releaseScreenshotSession = (
  session: KitesurfCaptureSession,
  useExit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void, KitesurfClientError> => {
  const release = boundedRuntimeEffect(
    "screenshot",
    "ambiguous",
    () => session.detach(),
    KITESURF_OPERATION_TIMEOUT_MILLIS,
  );
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

const captureScreenshot = (
  context: KitesurfRuntimeContext,
  page: KitesurfRuntimePage,
): Effect.Effect<Uint8Array, KitesurfClientError> =>
  singlePage(context, page).pipe(
    Effect.andThen(
      Effect.acquireUseRelease(
        boundedRuntimeEffect(
          "screenshot",
          "ambiguous",
          () => context.newCDPSession(),
          KITESURF_SCREENSHOT_TIMEOUT_MILLIS,
          (session) =>
            nativePromiseTimeout(
              "screenshot",
              "ambiguous",
              () => session.detach(),
              KITESURF_OPERATION_TIMEOUT_MILLIS,
            ),
        ),
        (session) =>
          boundedRuntimeEffect(
            "screenshot",
            "ambiguous",
            () =>
              session.send("Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: false,
              }),
            KITESURF_SCREENSHOT_TIMEOUT_MILLIS,
          ).pipe(Effect.flatMap(decodeScreenshotResult)),
        releaseScreenshotSession,
      ),
    ),
    Effect.tap(() => singlePage(context, page)),
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
              .goto(url, { timeout: KITESURF_NAVIGATION_TIMEOUT_MILLIS, waitUntil: "load" })
              .then(() => undefined),
          );
    },
    click: (locator) =>
      checkedLocator("click", locator, (runtimeLocator) =>
        runtimeLocator.click({ timeout: KITESURF_NAVIGATION_TIMEOUT_MILLIS }),
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
    screenshot: captureScreenshot(context, page),
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

const saveRecordedVideo = (
  video: KitesurfRuntimeVideo,
  resourceTimeoutMillis: number,
): Effect.Effect<Uint8Array, KitesurfClientError> => {
  const path = `/tmp/scotty-evidence-${crypto.randomUUID()}.webm`;
  const cleanup = runtimeEffect("save_video", "cleanup", () =>
    unlink(path).then(
      () => undefined,
      () => undefined,
    ),
  ).pipe(Effect.ignore);
  return Effect.gen(function* () {
    yield* boundedRuntimeEffect(
      "save_video",
      "unsupported",
      () => video.saveAs(path),
      KITESURF_VIDEO_TIMEOUT_MILLIS,
    );
    const metadata = yield* boundedRuntimeEffect(
      "save_video",
      "ambiguous",
      () => stat(path),
      resourceTimeoutMillis,
    );
    if (metadata.size <= 0 || metadata.size > EVIDENCE_MAX_VIDEO_BYTES)
      return yield* new KitesurfClientError({ operation: "save_video", reason: "unsupported" });
    const bytes = yield* boundedRuntimeEffect(
      "save_video",
      "ambiguous",
      () => readFile(path),
      resourceTimeoutMillis,
    );
    if (bytes.byteLength !== metadata.size)
      return yield* new KitesurfClientError({ operation: "save_video", reason: "ambiguous" });
    return Uint8Array.from(bytes);
  }).pipe(Effect.ensuring(cleanup));
};

export const makeKitesurfClient = (
  binding: BrowserWorker,
  launchBrowser: KitesurfRuntimeLauncher = launchRuntimeKitesurf,
  resourceTimeoutMillis = KITESURF_RESOURCE_TIMEOUT_MILLIS,
): KitesurfClientShape => {
  const runPage = <A, E, R>(
    options: KitesurfPageOptions & { readonly recordVideo: boolean },
    use: (page: KitesurfPage) => Effect.Effect<A, E, R>,
    retryCreatePageAmbiguity = true,
  ): Effect.Effect<KitesurfPageResult<A>, E | KitesurfClientError, R> => {
    const origin = exactOrigin(options.origin);
    if (origin === undefined)
      return Effect.fail(
        new KitesurfClientError({ operation: "install_network_guard", reason: "unsupported" }),
      );
    return Effect.acquireUseRelease(
      boundedRuntimeEffect(
        "launch",
        "ambiguous",
        () => launchBrowser(binding, { recordVideo: options.recordVideo }),
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
          if (
            (options.recordVideo && sessionId === undefined) ||
            (!options.recordVideo && sessionId !== undefined)
          )
            return yield* new KitesurfClientError({
              operation: "verify_sessionless",
              reason: "unsupported",
            });
          const context = yield* boundedRuntimeEffect(
            "create_context",
            "ambiguous",
            () =>
              browser.newContext({
                serviceWorkers: "block",
                ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
                ...(options.recordVideo
                  ? {
                      recordVideo: {
                        dir: "/tmp",
                        ...(options.viewport === undefined ? {} : { size: options.viewport }),
                      },
                    }
                  : {}),
              }),
            resourceTimeoutMillis,
            (context) =>
              compensateLateResource("close_context", () => context.close(), resourceTimeoutMillis),
          );
          let closed = false;
          return yield* Effect.acquireUseRelease(
            Effect.succeed(context),
            (ownedContext) =>
              Effect.gen(function* () {
                yield* installContextPolicy(ownedContext, origin, options.cookieSecret);
                const page = yield* boundedRuntimeEffect(
                  "create_page",
                  "ambiguous",
                  () => ownedContext.newPage(),
                  resourceTimeoutMillis,
                ).pipe(
                  Effect.mapError((error) =>
                    retryCreatePageAmbiguity &&
                    error.operation === "create_page" &&
                    error.reason === "ambiguous"
                      ? new RetryKitesurfPageAcquisition(error)
                      : error,
                  ),
                );
                yield* singlePage(ownedContext, page);
                const value = yield* use(makePage(origin, ownedContext, page));
                const video = options.recordVideo ? page.video() : null;
                if (options.recordVideo && video === null)
                  return yield* new KitesurfClientError({
                    operation: "save_video",
                    reason: "unsupported",
                  });
                yield* closeEffect(
                  "close_context",
                  () => ownedContext.close(),
                  resourceTimeoutMillis,
                );
                closed = true;
                const bytes =
                  video === null
                    ? undefined
                    : yield* saveRecordedVideo(video, resourceTimeoutMillis);
                return { value, ...(bytes === undefined ? {} : { video: bytes }) };
              }),
            (ownedContext, exit) =>
              closed
                ? Effect.void
                : releaseResource(
                    "close_context",
                    () => ownedContext.close(),
                    resourceTimeoutMillis,
                    exit,
                  ),
          );
        }),
      (browser, exit) =>
        releaseResource("close_browser", () => browser.close(), resourceTimeoutMillis, exit),
    ).pipe(
      Effect.catch((error) =>
        error instanceof RetryKitesurfPageAcquisition
          ? Effect.sleep(KITESURF_ACQUISITION_RETRY_DELAY_MILLIS).pipe(
              Effect.andThen(runPage(options, use, false)),
            )
          : Effect.fail(error),
      ),
    );
  };
  return KitesurfClient.of({
    withPage: (options, use) =>
      runPage({ ...options, recordVideo: false }, use).pipe(Effect.map((result) => result.value)),
    withRecordedPage: (options, use) => runPage({ ...options, recordVideo: true }, use),
  });
};
