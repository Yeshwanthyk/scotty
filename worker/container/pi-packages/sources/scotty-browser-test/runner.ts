import { spawn, type ChildProcess } from "node:child_process";
import { open, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Check } from "typebox/value";
import {
  BrowserEvidenceJobParameters,
  SCOTTY_BROWSER_TEST_MAX_BYTES,
  type BrowserEvidenceJob,
} from "./index.ts";

const ACTION_TIMEOUT_MILLIS = 5_000;
const ASSERTION_POLL_INTERVAL_MILLIS = 100;
const NAVIGATION_TIMEOUT_MILLIS = 15_000;
const PROCESS_START_TIMEOUT_MILLIS = 5_000;
const PROCESS_STOP_TIMEOUT_MILLIS = 15_000;
const MAX_FRAME_BYTES = 5 * 1_024 * 1_024;
const MAX_VIDEO_BYTES = 25 * 1_024 * 1_024;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM_SIGNATURE = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);

type EvidenceAssertionKind = BrowserEvidenceJob["steps"][number]["expect"][number]["kind"];
type EvidenceLocator = Exclude<
  BrowserEvidenceJob["steps"][number]["expect"][number],
  { readonly kind: "urlPath" }
>["locator"];

export type RunnerFailureCode =
  | "assertion_mismatch"
  | "artifact_invalid"
  | "artifact_over_budget"
  | "interrupted"
  | "unsupported";

export type RunnerStatus = "succeeded" | "failed" | "interrupted" | "unsupported";

export interface RunnerAssertionResult {
  readonly kind: EvidenceAssertionKind;
  readonly passed: boolean;
}

export interface RunnerFrame {
  readonly path: string;
  readonly capturedAt: string;
  readonly offsetMillis: number;
}

export interface RunnerStep {
  readonly index: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly offsetMillis: number;
  readonly assertions: readonly [RunnerAssertionResult, ...RunnerAssertionResult[]];
  readonly frame: RunnerFrame;
}

export interface RunnerManifest {
  readonly status: RunnerStatus;
  readonly completedSteps: number;
  readonly steps: readonly RunnerStep[];
  readonly video?: RunnerFrame;
  readonly failure?: {
    readonly code: RunnerFailureCode;
    readonly step?: number;
  };
}

export interface RunnerLocator {
  readonly click: (options: { readonly timeout: number }) => Promise<void>;
  readonly fill: (value: string, options: { readonly timeout: number }) => Promise<void>;
  readonly press: (key: string, options: { readonly timeout: number }) => Promise<void>;
  readonly isVisible: () => Promise<boolean>;
  readonly textContent: (options: { readonly timeout: number }) => Promise<string | null>;
  readonly count: () => Promise<number>;
}

export interface RunnerPage {
  readonly goto: (
    url: string,
    options: { readonly timeout: number; readonly waitUntil: "load" },
  ) => Promise<void>;
  readonly getByTestId: (value: string) => RunnerLocator;
  readonly locator: (selector: string) => RunnerLocator;
  readonly url: () => string;
  readonly screenshot: (options: {
    readonly animations: "disabled";
    readonly path: string;
    readonly type: "png";
  }) => Promise<void>;
}

export interface RunnerRoute {
  readonly url: () => string;
  readonly continue: () => Promise<void>;
  readonly abort: () => Promise<void>;
}

export interface RunnerWebSocketRoute {
  readonly url: () => string;
  readonly connectToServer: () => void;
  readonly close: () => void;
}

export interface RunnerContext {
  readonly route: (
    pattern: string,
    handler: (route: RunnerRoute) => Promise<void>,
  ) => Promise<void>;
  readonly routeWebSocket: (
    pattern: string,
    handler: (route: RunnerWebSocketRoute) => void,
  ) => Promise<void>;
  readonly newPage: () => Promise<RunnerPage>;
  readonly close: () => Promise<void>;
}

export interface RunnerBrowser {
  readonly newContext: (options: {
    readonly serviceWorkers: "block";
    readonly viewport: BrowserEvidenceJob["viewport"];
  }) => Promise<RunnerContext>;
  readonly close: () => Promise<void>;
}

export interface RunnerDisplay {
  readonly name: string;
  readonly close: () => Promise<void>;
}

export interface RunnerRecorder {
  readonly stop: () => Promise<void>;
}

export interface BrowserTestRuntime {
  readonly now: () => number;
  readonly sleep: (millis: number) => Promise<void>;
  readonly prepareOutput: (outputDirectory: string) => Promise<void>;
  readonly startDisplay: (viewport: BrowserEvidenceJob["viewport"]) => Promise<RunnerDisplay>;
  readonly launchBrowser: (
    display: string,
    viewport: BrowserEvidenceJob["viewport"],
  ) => Promise<RunnerBrowser>;
  readonly startRecorder: (
    display: string,
    viewport: BrowserEvidenceJob["viewport"],
    path: string,
  ) => Promise<RunnerRecorder>;
  readonly validateArtifact: (
    path: string,
    kind: "png" | "webm",
    step?: number,
  ) => Promise<void>;
  readonly moveArtifact: (from: string, to: string) => Promise<void>;
  readonly removeArtifact: (path: string) => Promise<void>;
}

class BrowserTestFailure extends Error {
  readonly status: Exclude<RunnerStatus, "succeeded">;
  readonly code: RunnerFailureCode;
  readonly step: number | undefined;

  constructor(
    status: Exclude<RunnerStatus, "succeeded">,
    code: RunnerFailureCode,
    step?: number,
  ) {
    super(code);
    this.name = "BrowserTestFailure";
    this.status = status;
    this.code = code;
    this.step = step;
  }
}

interface ManagedProcess {
  readonly child: ChildProcess;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  failedToSpawn: boolean;
}

const delay = (millis: number): Promise<void> =>
  new Promise((complete) => setTimeout(complete, millis));

const withTimeout = async <A>(evaluate: () => Promise<A>, millis: number): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluate(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new BrowserTestFailure("interrupted", "interrupted")),
          millis,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const managedProcess = (command: string, arguments_: readonly string[]): ManagedProcess => {
  const child = spawn(command, arguments_, {
    stdio: "ignore",
    env: process.env,
  });
  const managed: ManagedProcess = {
    child,
    failedToSpawn: false,
    exit: new Promise((complete) => {
      child.once("error", () => {
        managed.failedToSpawn = true;
        complete({ code: null, signal: null });
      });
      child.once("exit", (code, signal) => complete({ code, signal }));
    }),
  };
  return managed;
};

const hasExited = (process_: ManagedProcess): boolean =>
  process_.failedToSpawn || process_.child.exitCode !== null || process_.child.signalCode !== null;

const waitForFile = async (path: string, process_: ManagedProcess): Promise<void> => {
  const deadline = Date.now() + PROCESS_START_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      if (hasExited(process_)) throw new BrowserTestFailure("unsupported", "unsupported");
      await delay(25);
    }
  }
  throw new BrowserTestFailure("interrupted", "interrupted");
};

const stopProcess = async (
  process_: ManagedProcess,
  signal: NodeJS.Signals,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> => {
  if (!hasExited(process_)) process_.child.kill(signal);
  const stopped = await Promise.race([
    process_.exit.then((exit) => ({ kind: "exit" as const, exit })),
    delay(PROCESS_STOP_TIMEOUT_MILLIS).then(() => ({ kind: "timeout" as const })),
  ]);
  if (stopped.kind === "exit") return stopped.exit;
  process_.child.kill("SIGKILL");
  const killed = await Promise.race([
    process_.exit.then((exit) => ({ kind: "exit" as const, exit })),
    delay(PROCESS_START_TIMEOUT_MILLIS).then(() => ({ kind: "timeout" as const })),
  ]);
  if (killed.kind === "timeout") throw new BrowserTestFailure("interrupted", "interrupted");
  throw new BrowserTestFailure("interrupted", "interrupted");
};

const startNodeDisplay = async (
  viewport: BrowserEvidenceJob["viewport"],
): Promise<RunnerDisplay> => {
  const displayNumber = 100 + (process.pid % 900);
  const name = `:${displayNumber}`;
  const process_ = managedProcess("Xvfb", [
    name,
    "-screen",
    "0",
    `${viewport.width}x${viewport.height}x24`,
    "-nolisten",
    "tcp",
    "-noreset",
  ]);
  try {
    await waitForFile(`/tmp/.X11-unix/X${displayNumber}`, process_);
  } catch (error) {
    await stopProcess(process_, "SIGTERM").catch(() => undefined);
    throw error;
  }
  return {
    name,
    close: async () => {
      await stopProcess(process_, "SIGTERM");
    },
  };
};

const launchNodeBrowser = async (
  display: string,
  viewport: BrowserEvidenceJob["viewport"],
): Promise<RunnerBrowser> => {
  const { chromium } = await import("playwright-core");
  const server = await chromium.launchServer({
    headless: false,
    env: { ...process.env, DISPLAY: display },
    args: [
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--kiosk",
      "--no-sandbox",
      "--window-position=0,0",
      `--window-size=${viewport.width},${viewport.height}`,
    ],
  });
  const browser = await chromium.connect(server.wsEndpoint());
  return {
    newContext: async (options) => {
      const context = await browser.newContext(options);
      return {
        route: (pattern, handler) =>
          context
            .route(pattern, (route) =>
              handler({
                url: () => route.request().url(),
                continue: () => route.continue(),
                abort: () => route.abort("blockedbyclient"),
              }),
            )
            .then(() => undefined),
        routeWebSocket: (pattern, handler) =>
          context
            .routeWebSocket(pattern, (route) =>
              handler({
                url: () => route.url(),
                connectToServer: () => {
                  route.connectToServer();
                },
                close: () => {
                  route.close();
                },
              }),
            )
            .then(() => undefined),
        newPage: async () => {
          const page = await context.newPage();
          const wrapLocator = (locator: ReturnType<typeof page.locator>): RunnerLocator => ({
            click: (callOptions) => locator.click(callOptions),
            fill: (value, callOptions) => locator.fill(value, callOptions),
            press: (key, callOptions) => locator.press(key, callOptions),
            isVisible: () => locator.isVisible(),
            textContent: (callOptions) => locator.textContent(callOptions),
            count: () => locator.count(),
          });
          return {
            goto: (url, callOptions) => page.goto(url, callOptions).then(() => undefined),
            getByTestId: (value) => wrapLocator(page.getByTestId(value)),
            locator: (selector) => wrapLocator(page.locator(selector)),
            url: () => page.url(),
            screenshot: (callOptions) => page.screenshot(callOptions).then(() => undefined),
          };
        },
        close: () => withTimeout(() => context.close(), PROCESS_STOP_TIMEOUT_MILLIS),
      };
    },
    close: async () => {
      try {
        await withTimeout(() => browser.close(), PROCESS_STOP_TIMEOUT_MILLIS);
        return;
      } catch {
        try {
          await withTimeout(() => server.kill(), PROCESS_STOP_TIMEOUT_MILLIS);
          return;
        } catch {
          throw new BrowserTestFailure("interrupted", "interrupted");
        }
      }
    },
  };
};

const startNodeRecorder = async (
  display: string,
  viewport: BrowserEvidenceJob["viewport"],
  path: string,
): Promise<RunnerRecorder> => {
  const process_ = managedProcess("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-framerate",
    "15",
    "-video_size",
    `${viewport.width}x${viewport.height}`,
    "-i",
    `${display}.0`,
    "-an",
    "-c:v",
    "libvpx",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-b:v",
    "500k",
    "-maxrate",
    "750k",
    "-bufsize",
    "1M",
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p",
    "-fs",
    String(MAX_VIDEO_BYTES),
    "-t",
    "300",
    "-y",
    path,
  ]);
  try {
    await waitForFile(path, process_);
  } catch (error) {
    await stopProcess(process_, "SIGINT").catch(() => undefined);
    throw error;
  }
  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      const exit = await stopProcess(process_, "SIGINT");
      if (exit.code !== 0 && exit.code !== 255 && exit.signal !== "SIGINT")
        throw new BrowserTestFailure("interrupted", "interrupted");
    },
  };
};

const validateNodeArtifact = async (
  path: string,
  kind: "png" | "webm",
  step?: number,
): Promise<void> => {
  const metadata = await stat(path).catch(() => {
    throw new BrowserTestFailure("failed", "artifact_invalid", step);
  });
  const maximum = kind === "png" ? MAX_FRAME_BYTES : MAX_VIDEO_BYTES;
  if (!metadata.isFile() || metadata.size <= 0)
    throw new BrowserTestFailure("failed", "artifact_invalid", step);
  if (metadata.size > maximum)
    throw new BrowserTestFailure("failed", "artifact_over_budget", step);
  const signature = kind === "png" ? PNG_SIGNATURE : WEBM_SIGNATURE;
  const handle = await open(path, "r").catch(() => {
    throw new BrowserTestFailure("failed", "artifact_invalid", step);
  });
  try {
    const bytes = Buffer.alloc(signature.byteLength);
    const result = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (
      result.bytesRead !== signature.byteLength ||
      !signature.every((byte, index) => bytes[index] === byte)
    )
      throw new BrowserTestFailure("failed", "artifact_invalid", step);
  } finally {
    await handle.close();
  }
};

export const nodeBrowserTestRuntime: BrowserTestRuntime = {
  now: () => Date.now(),
  sleep: delay,
  prepareOutput: (outputDirectory) =>
    mkdir(outputDirectory, { recursive: true }).then(() => undefined),
  startDisplay: startNodeDisplay,
  launchBrowser: launchNodeBrowser,
  startRecorder: startNodeRecorder,
  validateArtifact: validateNodeArtifact,
  moveArtifact: (from, to) => rename(from, to),
  removeArtifact: (path) => rm(path, { force: true }),
};

const locatorFor = (page: RunnerPage, locator: EvidenceLocator): RunnerLocator =>
  locator.kind === "testId" ? page.getByTestId(locator.value) : page.locator(`css=${locator.value}`);

const executeAction = async (
  page: RunnerPage,
  origin: string,
  action: BrowserEvidenceJob["steps"][number]["action"],
  step: number,
): Promise<void> => {
  try {
    if (action.kind === "goto") {
      const url = new URL(action.path, `${origin}/`);
      if (url.origin !== origin) throw new BrowserTestFailure("unsupported", "unsupported", step);
      await page.goto(url.href, { timeout: NAVIGATION_TIMEOUT_MILLIS, waitUntil: "load" });
      return;
    }
    const locator = locatorFor(page, action.locator);
    if (action.kind === "click") {
      await locator.click({ timeout: NAVIGATION_TIMEOUT_MILLIS });
      return;
    }
    if (action.kind === "fill") {
      await locator.fill(action.value, { timeout: ACTION_TIMEOUT_MILLIS });
      return;
    }
    await locator.press(action.key, { timeout: ACTION_TIMEOUT_MILLIS });
  } catch (error) {
    if (error instanceof BrowserTestFailure) throw error;
    throw new BrowserTestFailure("interrupted", "interrupted", step);
  }
};

const executeAssertion = async (
  page: RunnerPage,
  origin: string,
  assertion: BrowserEvidenceJob["steps"][number]["expect"][number],
  step: number,
  deadlineMillis: number,
  runtime: BrowserTestRuntime,
): Promise<RunnerAssertionResult> => {
  for (;;) {
    const remainingMillis = Math.max(0, deadlineMillis - runtime.now());
    if (remainingMillis === 0) return { kind: assertion.kind, passed: false };
    try {
      let passed: boolean;
      if (assertion.kind === "urlPath") {
        const value = new URL(page.url());
        if (value.origin !== origin)
          throw new BrowserTestFailure("unsupported", "unsupported", step);
        passed = `${value.pathname}${value.search}` === assertion.expected;
      } else {
        const locator = locatorFor(page, assertion.locator);
        passed =
          assertion.kind === "visible"
            ? await locator.isVisible()
            : assertion.kind === "textExact"
              ? (await locator.textContent({ timeout: remainingMillis })) === assertion.expected
              : (await locator.count()) === assertion.expected;
      }
      if (passed) return { kind: assertion.kind, passed: true };
    } catch (error) {
      if (error instanceof BrowserTestFailure) throw error;
      throw new BrowserTestFailure("interrupted", "interrupted", step);
    }
    const nowMillis = runtime.now();
    if (nowMillis >= deadlineMillis) return { kind: assertion.kind, passed: false };
    await runtime.sleep(Math.min(ASSERTION_POLL_INTERVAL_MILLIS, deadlineMillis - nowMillis));
  }
};

const failureManifest = (
  steps: readonly RunnerStep[],
  failure: BrowserTestFailure,
): RunnerManifest => ({
  status: failure.status,
  completedSteps: steps.length,
  steps,
  failure: {
    code: failure.code,
    ...(failure.step === undefined ? {} : { step: failure.step }),
  },
});

const normalizeFailure = (error: unknown, step?: number): BrowserTestFailure =>
  error instanceof BrowserTestFailure
    ? error
    : new BrowserTestFailure("interrupted", "interrupted", step);

export async function runBrowserEvidenceJob(
  job: BrowserEvidenceJob,
  outputDirectory: string,
  runtime: BrowserTestRuntime = nodeBrowserTestRuntime,
): Promise<RunnerManifest> {
  const output = resolve(outputDirectory);
  const origin = `http://127.0.0.1:${job.port}`;
  const startedAtMillis = runtime.now();
  const steps: RunnerStep[] = [];
  const stagedVideoPath = resolve(output, `.recording-${process.pid}.webm`);
  const videoPath = resolve(output, "video.webm");
  let display: RunnerDisplay | undefined;
  let browser: RunnerBrowser | undefined;
  let context: RunnerContext | undefined;
  let recorder: RunnerRecorder | undefined;
  let failure: BrowserTestFailure | undefined;
  let videoCapturedAtMillis: number | undefined;
  let activeStep: number | undefined;

  try {
    await runtime.prepareOutput(output);
    await runtime.removeArtifact(stagedVideoPath);
    display = await runtime.startDisplay(job.viewport);
    browser = await runtime.launchBrowser(display.name, job.viewport);
    context = await browser.newContext({ serviceWorkers: "block", viewport: job.viewport });
    await context.route("**/*", async (route) => {
      try {
        const url = new URL(route.url());
        if (url.origin === origin) await route.continue();
        else await route.abort();
      } catch {
        await route.abort();
      }
    });
    await context.routeWebSocket("**/*", (route) => route.close());
    const page = await context.newPage();
    if (job.capture.video)
      recorder = await runtime.startRecorder(display.name, job.viewport, stagedVideoPath);

    for (let index = 0; index < job.steps.length; index += 1) {
      activeStep = index;
      const step = job.steps[index];
      if (step === undefined) throw new BrowserTestFailure("interrupted", "interrupted", index);
      const stepStartedAtMillis = runtime.now();
      await executeAction(page, origin, step.action, index);
      const assertions: RunnerAssertionResult[] = [];
      const assertionDeadlineMillis = runtime.now() + ACTION_TIMEOUT_MILLIS;
      for (const assertion of step.expect)
        assertions.push(
          await executeAssertion(
            page,
            origin,
            assertion,
            index,
            assertionDeadlineMillis,
            runtime,
          ),
        );
      const firstAssertion = assertions[0];
      if (firstAssertion === undefined)
        throw new BrowserTestFailure("interrupted", "interrupted", index);
      const framePath = resolve(output, `frame-${index + 1}.png`);
      await page
        .screenshot({ animations: "disabled", path: framePath, type: "png" })
        .catch(() => {
          throw new BrowserTestFailure("failed", "artifact_invalid", index);
        });
      await runtime.validateArtifact(framePath, "png", index);
      const completedAtMillis = runtime.now();
      const completedAt = new Date(completedAtMillis).toISOString();
      const offsetMillis = Math.max(0, completedAtMillis - startedAtMillis);
      steps.push({
        index,
        startedAt: new Date(stepStartedAtMillis).toISOString(),
        completedAt,
        offsetMillis,
        assertions: [firstAssertion, ...assertions.slice(1)],
        frame: { path: framePath, capturedAt: completedAt, offsetMillis },
      });
      if (!assertions.every((assertion) => assertion.passed)) {
        failure = new BrowserTestFailure("failed", "assertion_mismatch", index);
        break;
      }
    }
  } catch (error) {
    failure = normalizeFailure(error, activeStep);
  }

  let cleanupFailed = false;
  if (recorder !== undefined) {
    try {
      await recorder.stop();
      videoCapturedAtMillis = runtime.now();
    } catch {
      cleanupFailed = true;
    }
  }
  for (const cleanup of [
    context === undefined ? undefined : () => context.close(),
    browser === undefined ? undefined : () => browser.close(),
    display === undefined ? undefined : () => display.close(),
  ]) {
    if (cleanup === undefined) continue;
    try {
      await cleanup();
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed)
    failure = new BrowserTestFailure("interrupted", "interrupted", activeStep);

  if (failure !== undefined || steps.length !== job.steps.length) {
    await runtime.removeArtifact(stagedVideoPath).catch(() => undefined);
    return failureManifest(
      steps,
      failure ?? new BrowserTestFailure("interrupted", "interrupted", activeStep),
    );
  }

  if (!job.capture.video)
    return { status: "succeeded", completedSteps: steps.length, steps };

  try {
    await runtime.validateArtifact(stagedVideoPath, "webm");
    await runtime.moveArtifact(stagedVideoPath, videoPath);
  } catch (error) {
    await runtime.removeArtifact(stagedVideoPath).catch(() => undefined);
    return failureManifest(steps, normalizeFailure(error));
  }
  const capturedAtMillis = videoCapturedAtMillis ?? runtime.now();
  return {
    status: "succeeded",
    completedSteps: steps.length,
    steps,
    video: {
      path: videoPath,
      capturedAt: new Date(capturedAtMillis).toISOString(),
      offsetMillis: Math.max(0, capturedAtMillis - startedAtMillis),
    },
  };
}

export function serializeRunnerManifest(manifest: RunnerManifest): string {
  const encoded = JSON.stringify(manifest);
  if (Buffer.byteLength(encoded, "utf8") > SCOTTY_BROWSER_TEST_MAX_BYTES)
    throw new BrowserTestFailure("interrupted", "interrupted");
  return encoded;
}

const decodeJobFile = async (path: string): Promise<BrowserEvidenceJob> => {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > SCOTTY_BROWSER_TEST_MAX_BYTES)
    throw new BrowserTestFailure("unsupported", "unsupported");
  const bytes = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BrowserTestFailure("unsupported", "unsupported");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BrowserTestFailure("unsupported", "unsupported");
  }
  if (!Check(BrowserEvidenceJobParameters, value))
    throw new BrowserTestFailure("unsupported", "unsupported");
  return value;
};

export async function runBrowserTestCli(
  arguments_: readonly string[],
  runtime: BrowserTestRuntime = nodeBrowserTestRuntime,
): Promise<RunnerManifest> {
  if (arguments_.length !== 2 || arguments_[0] === undefined || arguments_[1] === undefined)
    return failureManifest([], new BrowserTestFailure("unsupported", "unsupported"));
  try {
    const job = await decodeJobFile(arguments_[0]);
    return await runBrowserEvidenceJob(job, arguments_[1], runtime);
  } catch (error) {
    return failureManifest([], normalizeFailure(error));
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  const manifest = await runBrowserTestCli(process.argv.slice(2));
  process.stdout.write(`${serializeRunnerManifest(manifest)}\n`);
}
