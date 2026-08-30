import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const SCOTTY_BROWSER_TEST_ROUTE = "https://scotty.internal/api/evidence/jobs";
export const SCOTTY_BROWSER_TEST_MAX_BYTES = 64 * 1_024;

const MAX_STEPS = 12;
const MAX_ASSERTIONS_PER_STEP = 4;
const MAX_BOUNDED_VALUE_LENGTH = 512;
const MAX_PATH_LENGTH = 2_048;
const MAX_FILL_LENGTH = 4_096;
const RESERVED_PORTS = [3_000, 43_117] as const;

const LocatorSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("testId"),
      value: Type.String({ maxLength: MAX_BOUNDED_VALUE_LENGTH }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("css"),
      value: Type.String({ maxLength: MAX_BOUNDED_VALUE_LENGTH }),
    },
    { additionalProperties: false },
  ),
]);

const RelativePathSchema = Type.String({
  maxLength: MAX_PATH_LENGTH,
  pattern: "^/(?!/)",
});

const ActionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("goto"),
      path: RelativePathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("click"),
      locator: LocatorSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("fill"),
      locator: LocatorSchema,
      value: Type.String({ maxLength: MAX_FILL_LENGTH }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("press"),
      locator: LocatorSchema,
      key: Type.Union([
        Type.Literal("Enter"),
        Type.Literal("Escape"),
        Type.Literal("Tab"),
        Type.Literal("ArrowUp"),
        Type.Literal("ArrowDown"),
        Type.Literal("ArrowLeft"),
        Type.Literal("ArrowRight"),
        Type.Literal("Backspace"),
        Type.Literal("Delete"),
        Type.Literal("Space"),
      ]),
    },
    { additionalProperties: false },
  ),
]);

const AssertionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("visible"),
      locator: LocatorSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("textExact"),
      locator: LocatorSchema,
      expected: Type.String({ maxLength: MAX_BOUNDED_VALUE_LENGTH }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("count"),
      locator: LocatorSchema,
      expected: Type.Integer({ minimum: 0, maximum: 1_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("urlPath"),
      expected: RelativePathSchema,
    },
    { additionalProperties: false },
  ),
]);

const StepSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    action: ActionSchema,
    expect: Type.Array(AssertionSchema, {
      minItems: 1,
      maxItems: MAX_ASSERTIONS_PER_STEP,
    }),
  },
  { additionalProperties: false },
);

export const BrowserEvidenceJobParameters = Type.Object(
  {
    port: Type.Integer({
      minimum: 1_024,
      maximum: 65_535,
      not: { enum: RESERVED_PORTS },
    }),
    viewport: Type.Object(
      {
        width: Type.Integer({ minimum: 320, maximum: 1_920 }),
        height: Type.Integer({ minimum: 240, maximum: 1_080 }),
      },
      { additionalProperties: false },
    ),
    steps: Type.Array(StepSchema, { minItems: 1, maxItems: MAX_STEPS }),
    capture: Type.Object(
      {
        screenshots: Type.Literal("after-each-step"),
        video: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type BrowserEvidenceJob = Static<typeof BrowserEvidenceJobParameters>;

const FailureSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("assertion_mismatch"),
      Type.Literal("artifact_invalid"),
      Type.Literal("artifact_over_budget"),
      Type.Literal("artifact_put_unknown"),
      Type.Literal("deadline"),
      Type.Literal("interrupted"),
      Type.Literal("unsupported"),
    ]),
    step: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_STEPS - 1 })),
  },
  { additionalProperties: false },
);

const BrowserEvidenceResultSchema = Type.Object(
  {
    jobId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" }),
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
      Type.Literal("unsupported"),
    ]),
    summaryUrl: Type.String({
      maxLength: 512,
      pattern:
        "^/s/[0-9a-f]{12}/evidence/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    }),
    completedSteps: Type.Integer({ minimum: 0, maximum: MAX_STEPS }),
    frameCount: Type.Integer({ minimum: 0, maximum: MAX_STEPS }),
    video: Type.Boolean(),
    failure: Type.Optional(FailureSchema),
  },
  { additionalProperties: false },
);

export type BrowserEvidenceResult = Static<typeof BrowserEvidenceResultSchema>;

const ErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 64 }),
        message: Type.String({ minLength: 1, maxLength: 512 }),
        hint: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;
type EvidenceTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export function serializeBrowserEvidenceJob(value: unknown): string {
  if (!Check(BrowserEvidenceJobParameters, value)) {
    throw new Error("scotty_browser_test input does not match BrowserEvidenceJob");
  }
  const body = JSON.stringify(value);
  if (byteLength(body) > SCOTTY_BROWSER_TEST_MAX_BYTES) {
    throw new Error("scotty_browser_test request exceeds the 64 KiB limit");
  }
  return body;
}

async function readBoundedResponse(response: Response): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > SCOTTY_BROWSER_TEST_MAX_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > SCOTTY_BROWSER_TEST_MAX_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function validateResult(value: unknown): BrowserEvidenceResult | undefined {
  if (!Check(BrowserEvidenceResultSchema, value)) return undefined;
  if (!value.summaryUrl.endsWith(`/evidence/${value.jobId}`)) return undefined;
  return value;
}

function errorMessage(status: number, value: unknown): string {
  if (!Check(ErrorEnvelopeSchema, value)) {
    return `Scotty browser test request failed with HTTP ${status}`;
  }
  const envelope: ErrorEnvelope = value;
  return `Scotty browser test request failed (${envelope.error.code}): ${envelope.error.message}`;
}

export async function runScottyBrowserTest(
  job: unknown,
  signal?: AbortSignal,
  transport: EvidenceTransport = fetch,
): Promise<BrowserEvidenceResult> {
  const body = serializeBrowserEvidenceJob(job);
  const response = await transport(SCOTTY_BROWSER_TEST_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
  const responseText = await readBoundedResponse(response);
  if (responseText === undefined) {
    throw new Error("Scotty browser test response exceeds the 64 KiB limit or is invalid UTF-8");
  }
  const value = parseJson(responseText);
  if (!response.ok) throw new Error(errorMessage(response.status, value));
  const result = validateResult(value);
  if (result === undefined) throw new Error("Scotty browser test returned an invalid result");
  return result;
}

function renderResult(result: BrowserEvidenceResult): string {
  const lines = [
    `Browser evidence: ${result.status}`,
    `Completed steps: ${result.completedSteps}`,
    `Frames: ${result.frameCount}`,
    `Video: ${result.video ? "recorded" : "not requested"}`,
  ];
  if (result.failure !== undefined) {
    const step = result.failure.step === undefined ? "" : ` at step ${result.failure.step + 1}`;
    lines.push(`Failure: ${result.failure.code}${step}`);
  }
  lines.push(`Authenticated summary: ${result.summaryUrl}`);
  return lines.join("\n");
}

export default function scottyBrowserTest(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "scotty_browser_test",
    label: "Scotty Browser Test",
    description:
      "Run one bounded BrowserEvidenceJob against an app port in the current warm Scotty session. Captures verified screenshots and, when requested, a real WebM browser recording.",
    promptSnippet:
      "Run a bounded one-shot browser evidence job against the current warm Scotty session",
    promptGuidelines: [
      "Use scotty_browser_test only after starting the repository app on 0.0.0.0 at an allowed port; use relative paths and declarative assertions.",
      "For user-visible work, run the same viewport, steps, and assertions before and after the change. Set video false for the before run and true for the after run so Scotty can build one matched Showcase.",
      "In the next meaningful progress or final update, include the exact scotty-evidence:<jobId> reference derived from the structured result once. Never invent or repeat a reference, and do not publish the authenticated summary URL.",
    ],
    parameters: BrowserEvidenceJobParameters,
    async execute(_toolCallId, params, signal) {
      const result = await runScottyBrowserTest(params, signal);
      return {
        content: [{ type: "text" as const, text: renderResult(result) }],
        details: result,
      };
    },
  });
}
