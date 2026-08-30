import type { OutboundHandlerContext } from "@cloudflare/containers";
import { ContainerProxy as SandboxContainerProxy } from "@cloudflare/sandbox";
import { Option, Result, Schema } from "effect";
import {
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  PiConsoleSnapshotSchema,
} from "../../../protocol/pi-console";
import type { Bindings } from "../shared/bindings";
import { readBoundedJson, readBoundedUtf8Body } from "../shared/bounded-http";
import { decodeJsonValue } from "../shared/json";
import {
  ApiErrorCodeSchema,
  badRequest,
  parseSessionId,
  parseSteerInput,
  ScottyError,
  type ContainerSessionRequest,
} from "../session/contracts";
import {
  decodeBrowserEvidenceJob,
  decodeBrowserEvidenceToolResult,
  EVIDENCE_TOOL_MAX_PROTOCOL_BYTES,
  EvidenceStateError,
} from "../evidence/contracts";
import {
  decodeHatchToolEnsureRequest,
  HatchRestoreDescriptorSchema,
  PublicHatchStatusSchema,
  type EnsureHatchInput,
} from "../hatch/contracts";
import { scottyErrorResponse } from "../session/passive";

// Deployed-canary gate: cloudflare/sandbox:0.12.3 must prove that its TLS trust store
// accepts the SDK interception certificate for this reserved host.
export const SCOTTY_INTERNAL_HOST = "scotty.internal";
export const SCOTTY_EVIDENCE_JOB_ROUTE = "/api/evidence/jobs";
export const SCOTTY_HATCH_ROUTE = "/api/hatch";
export const SCOTTY_HATCH_RESTORE_ROUTE = "/api/hatch/restore";
export const SCOTTY_HATCH_MAX_PROTOCOL_BYTES = 64 * 1_024;

// @cloudflare/containers passes the TypeScript constructor name. The Worker exports this class
// under the separate deployed binding name "ScottySandbox".
const SOURCE_SANDBOX_CLASS = "Sandbox";
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "private-token",
  "x-github-token",
]);
const SOURCE_IDENTITY_HEADERS = new Set([
  "container-id",
  "scotty-session-id",
  "session-id",
  "source-session-id",
  "x-session-id",
  "x-source-session-id",
]);
const PROXY_IDENTITY_HEADERS = new Set([
  "cf-connecting-ip",
  "forwarded",
  "true-client-ip",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);
const CONTAINER_SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/(inspect|steer)$/u;
const ErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
    hint: Schema.optionalKey(Schema.NonEmptyString),
  }),
});
const SteerResponseSchema = Schema.Union([
  Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literal("accepted"),
    commandId: Schema.NonEmptyString,
    epoch: Schema.NonEmptyString,
    sessionRevision: Schema.Int,
  }),
  Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literal("stale"),
    reason: Schema.Literals(["session_revision_changed", "epoch_changed"]),
    expectedSessionRevision: Schema.Int,
    sessionRevision: Schema.optionalKey(Schema.Int),
    retryable: Schema.Literal(false),
  }),
  Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "provider_passive_relay_unavailable",
      "session_authority_unavailable",
      "session_not_warm",
      "session_operation_active",
      "provider_unsupported",
      "command_id_conflict",
      "extension_ui_not_pending",
      "extension_ui_response_already_delivered",
      "invalid_command",
      "pi_quiescing",
      "command_rejected",
    ]),
    retryable: Schema.Boolean,
  }),
  Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literal("ambiguous"),
    reason: Schema.Literals([
      "command_transport_failed",
      "command_response_invalid",
      "command_receipt_mismatch",
    ]),
  }),
]);
const decodeInspectResponse = Schema.decodeUnknownOption(
  Schema.Union([PiConsoleSnapshotSchema, ErrorEnvelopeSchema]),
  { onExcessProperty: "error" },
);
const decodeSteerResponse = Schema.decodeUnknownOption(
  Schema.Union([SteerResponseSchema, ErrorEnvelopeSchema]),
  { onExcessProperty: "error" },
);
const decodeScottyError = Schema.decodeUnknownOption(
  Schema.Struct({
    _tag: Schema.Literal("ScottyError"),
    code: ApiErrorCodeSchema,
    message: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
    httpStatus: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
    exitCode: Schema.Literals([1, 2, 3, 4, 5]),
    hint: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(512))),
  }),
);
const decodeEvidenceStateError = Schema.decodeUnknownOption(EvidenceStateError);
const decodePublicHatchStatus = Schema.decodeUnknownOption(PublicHatchStatusSchema, {
  onExcessProperty: "error",
});
const decodeHatchRestoreDescriptor = Schema.decodeUnknownOption(HatchRestoreDescriptorSchema, {
  onExcessProperty: "error",
});

type EgressContext = OutboundHandlerContext<unknown>;
interface ContainerProxyProps {
  readonly containerId: string;
  readonly className: string;
}

/**
 * The installed containers proxy may use native fetch when an allowed host has no handler in its
 * WorkerEntrypoint registry. Dispatch Scotty's reserved host directly so it always fails closed.
 */
export class ContainerProxy extends SandboxContainerProxy {
  declare protected env: Bindings;
  declare protected ctx: ExecutionContext<ContainerProxyProps>;

  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname !== SCOTTY_INTERNAL_HOST) return super.fetch(request);
    return handleContainerSessionEgress(request, this.env, {
      containerId: this.ctx.props.containerId,
      className: this.ctx.props.className,
    });
  }
}

const rejectedRequest = (message: string): Response => scottyErrorResponse(badRequest(message));

const rejectsAmbientAuthority = (headers: Headers): boolean => {
  for (const name of headers.keys()) {
    if (
      CREDENTIAL_HEADERS.has(name) ||
      SOURCE_IDENTITY_HEADERS.has(name) ||
      PROXY_IDENTITY_HEADERS.has(name) ||
      name.startsWith("x-container-") ||
      name.startsWith("x-sandbox-") ||
      name.startsWith("x-scotty-")
    )
      return true;
  }
  return false;
};

const mediaType = (value: string | null): string =>
  value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const validContainerSessionUrl = (url: URL): boolean =>
  url.protocol === "https:" &&
  url.hostname === SCOTTY_INTERNAL_HOST &&
  url.port === "" &&
  url.username === "" &&
  url.password === "" &&
  url.search === "" &&
  url.hash === "";

async function sanitizeResponse(
  response: Response,
  action: ContainerSessionRequest["action"],
): Promise<Response> {
  const body = await readBoundedJson(response, PI_CONSOLE_MAX_RESPONSE_BYTES);
  const decoded: Option.Option<unknown> = Option.isSome(body)
    ? action === "inspect"
      ? decodeInspectResponse(body.value)
      : decodeSteerResponse(body.value)
    : Option.none();
  if (Option.isNone(decoded))
    return scottyErrorResponse(
      new ScottyError("upstream", "Container session response is unavailable", {
        httpStatus: 502,
        exitCode: 1,
      }),
    );
  return Response.json(decoded.value, {
    status: response.status,
    headers: { "cache-control": "no-store" },
  });
}

const evidenceUnavailable = (): Response =>
  scottyErrorResponse(
    new ScottyError("wrong_state", "Scotty browser evidence is unavailable", {
      httpStatus: 409,
      exitCode: 5,
    }),
  );

function evidenceFailureResponse(error: unknown): Response {
  const scotty = decodeScottyError(error);
  if (Option.isSome(scotty))
    return scottyErrorResponse(
      new ScottyError(scotty.value.code, scotty.value.message, {
        httpStatus: scotty.value.httpStatus,
        exitCode: scotty.value.exitCode,
        ...(scotty.value.hint === undefined ? {} : { hint: scotty.value.hint }),
      }),
    );
  if (Option.isSome(decodeEvidenceStateError(error))) return evidenceUnavailable();
  return scottyErrorResponse(
    new ScottyError("internal", "Scotty browser evidence request failed", {
      httpStatus: 500,
      exitCode: 1,
    }),
  );
}

function sanitizeEvidenceResult(value: unknown): Response {
  const decoded = decodeBrowserEvidenceToolResult(value);
  if (Option.isNone(decoded))
    return scottyErrorResponse(
      new ScottyError("upstream", "Scotty browser evidence result is unavailable", {
        httpStatus: 502,
        exitCode: 1,
      }),
    );
  const body = JSON.stringify(decoded.value);
  if (new TextEncoder().encode(body).byteLength > EVIDENCE_TOOL_MAX_PROTOCOL_BYTES)
    return scottyErrorResponse(
      new ScottyError("upstream", "Scotty browser evidence result is unavailable", {
        httpStatus: 502,
        exitCode: 1,
      }),
    );
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function hatchFailureResponse(error: unknown): Response {
  const scotty = decodeScottyError(error);
  if (Option.isSome(scotty))
    return scottyErrorResponse(
      new ScottyError(scotty.value.code, scotty.value.message, {
        httpStatus: scotty.value.httpStatus,
        exitCode: scotty.value.exitCode,
        ...(scotty.value.hint === undefined ? {} : { hint: scotty.value.hint }),
      }),
    );
  return scottyErrorResponse(
    new ScottyError("internal", "Scotty Hatch request failed", {
      httpStatus: 500,
      exitCode: 1,
    }),
  );
}

function sanitizeHatchStatus(value: unknown): Response {
  // Durable Object RPC values can retain a cross-realm transport wrapper. Validate the bounded JSON
  // representation that the container actually receives rather than the wrapper's prototype.
  const encoded = Result.try(() => JSON.stringify(value));
  const body = Result.isSuccess(encoded) ? encoded.success : undefined;
  const parsed = typeof body === "string" ? decodeJsonValue(body) : Option.none();
  const decoded = Option.isSome(parsed) ? decodePublicHatchStatus(parsed.value) : Option.none();
  if (Option.isNone(decoded) || body === undefined)
    return scottyErrorResponse(
      new ScottyError("upstream", "Scotty Hatch result is unavailable", {
        httpStatus: 502,
        exitCode: 1,
      }),
    );
  const projected = JSON.stringify(decoded.value);
  if (new TextEncoder().encode(projected).byteLength > SCOTTY_HATCH_MAX_PROTOCOL_BYTES)
    return scottyErrorResponse(
      new ScottyError("upstream", "Scotty Hatch result is unavailable", {
        httpStatus: 502,
        exitCode: 1,
      }),
    );
  return new Response(projected, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function handleHatchRestoreEgress(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  if (request.method !== "GET" || request.body !== null)
    return rejectedRequest("Hatch restore requires an empty GET request");
  if (
    typeof context.containerId !== "string" ||
    context.containerId.length === 0 ||
    context.className !== SOURCE_SANDBOX_CLASS
  )
    return scottyErrorResponse(
      new ScottyError("auth", "Container Hatch source is unavailable", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );
  const source = Result.try(() => env.SANDBOX.get(env.SANDBOX.idFromString(context.containerId)));
  if (Result.isFailure(source))
    return scottyErrorResponse(
      new ScottyError("auth", "Container Hatch source is unavailable", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );
  const executed = await Promise.resolve()
    .then(() => source.success.getScottyHatchRestoreDescriptor())
    .then(Result.succeed, (error) => Result.fail(error));
  if (Result.isFailure(executed)) return hatchFailureResponse(executed.failure);
  if (executed.success === undefined)
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const descriptor = decodeHatchRestoreDescriptor(executed.success);
  if (Option.isNone(descriptor))
    return scottyErrorResponse(
      new ScottyError("upstream", "Scotty Hatch restore descriptor is unavailable", {
        httpStatus: 502,
        exitCode: 1,
      }),
    );
  const body = JSON.stringify(descriptor.value);
  if (new TextEncoder().encode(body).byteLength > SCOTTY_HATCH_MAX_PROTOCOL_BYTES)
    return scottyErrorResponse(
      new ScottyError("upstream", "Scotty Hatch restore descriptor is unavailable", {
        httpStatus: 502,
        exitCode: 1,
      }),
    );
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function handleHatchEgress(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  if (
    typeof context.containerId !== "string" ||
    context.containerId.length === 0 ||
    context.className !== SOURCE_SANDBOX_CLASS
  )
    return scottyErrorResponse(
      new ScottyError("auth", "Container Hatch source is unavailable", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );

  let intent:
    | { readonly operation: "status" }
    | { readonly operation: "close" }
    | { readonly operation: "ensure"; readonly input: EnsureHatchInput };
  if (request.method === "GET") {
    if (request.body !== null) return rejectedRequest("Hatch status requires an empty GET request");
    intent = { operation: "status" };
  } else if (request.method === "DELETE") {
    if (request.body !== null)
      return rejectedRequest("Hatch close requires an empty DELETE request");
    intent = { operation: "close" };
  } else if (
    request.method === "POST" &&
    mediaType(request.headers.get("content-type")) === "application/json"
  ) {
    const bodyText = await readBoundedUtf8Body(request, SCOTTY_HATCH_MAX_PROTOCOL_BYTES);
    if (bodyText === undefined) return rejectedRequest("Hatch ensure request body is too large");
    const body = decodeJsonValue(bodyText);
    if (Option.isNone(body)) return rejectedRequest("Request body must be valid JSON");
    const input = decodeHatchToolEnsureRequest(body.value);
    if (Option.isNone(input)) return rejectedRequest("Hatch ensure request is invalid");
    intent = { operation: "ensure", input: { service: input.value.service } };
  } else {
    return rejectedRequest("Hatch requires GET status, JSON POST ensure, or DELETE close");
  }

  const source = Result.try(() => env.SANDBOX.get(env.SANDBOX.idFromString(context.containerId)));
  if (Result.isFailure(source))
    return scottyErrorResponse(
      new ScottyError("auth", "Container Hatch source is unavailable", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );
  let operation: () => Promise<unknown>;
  if (intent.operation === "status") operation = () => source.success.getScottyHatchStatus();
  else if (intent.operation === "close") operation = () => source.success.closeScottyHatch();
  else operation = () => source.success.ensureScottyHatch(intent.input);
  const executed = await Promise.resolve()
    .then(operation)
    .then(Result.succeed, (error) => Result.fail(error));
  return Result.isFailure(executed)
    ? hatchFailureResponse(executed.failure)
    : sanitizeHatchStatus(executed.success);
}

async function handleEvidenceJobEgress(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  if (
    request.method !== "POST" ||
    mediaType(request.headers.get("content-type")) !== "application/json"
  )
    return rejectedRequest("Evidence jobs require a JSON POST request");
  if (
    typeof context.containerId !== "string" ||
    context.containerId.length === 0 ||
    context.className !== SOURCE_SANDBOX_CLASS
  )
    return scottyErrorResponse(
      new ScottyError("auth", "Container evidence source is unavailable", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );
  // The container tool is installed by the image, so omission is the default-on state; any
  // explicit value other than true is an emergency runtime kill switch.
  if (env.SCOTTY_BROWSER_TEST_ENABLED !== undefined && env.SCOTTY_BROWSER_TEST_ENABLED !== "true")
    return evidenceUnavailable();
  const bodyText = await readBoundedUtf8Body(request, EVIDENCE_TOOL_MAX_PROTOCOL_BYTES);
  if (bodyText === undefined) return rejectedRequest("Evidence job request body is too large");
  const body = decodeJsonValue(bodyText);
  if (Option.isNone(body)) return rejectedRequest("Request body must be valid JSON");
  const job = decodeBrowserEvidenceJob(body.value);
  if (Option.isNone(job)) return rejectedRequest("Evidence job is invalid");

  const source = Result.try(() => env.SANDBOX.get(env.SANDBOX.idFromString(context.containerId)));
  if (Result.isFailure(source))
    return scottyErrorResponse(
      new ScottyError("auth", "Container evidence source is unavailable", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );
  const executed = await Promise.resolve()
    .then(() => source.success.runScottyEvidenceJob(job.value))
    .then(Result.succeed, (error) => Result.fail(error));
  return Result.isFailure(executed)
    ? evidenceFailureResponse(executed.failure)
    : sanitizeEvidenceResult(executed.success);
}

export async function handleContainerSessionEgress(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (!validContainerSessionUrl(url)) return rejectedRequest("Invalid container session route");
  if (rejectsAmbientAuthority(request.headers))
    return scottyErrorResponse(
      new ScottyError("auth", "Container session request must not include ambient authority", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );

  if (url.pathname === SCOTTY_EVIDENCE_JOB_ROUTE)
    return handleEvidenceJobEgress(request, env, context);
  if (url.pathname === SCOTTY_HATCH_RESTORE_ROUTE)
    return handleHatchRestoreEgress(request, env, context);
  if (url.pathname === SCOTTY_HATCH_ROUTE) return handleHatchEgress(request, env, context);

  const matched = CONTAINER_SESSION_ROUTE.exec(url.pathname);
  if (matched === null) return rejectedRequest("Invalid container session route");
  const targetId = Result.try({
    try: () => parseSessionId(decodeURIComponent(matched[1] ?? "")),
    catch: () => badRequest("Invalid session id"),
  });
  if (Result.isFailure(targetId)) return scottyErrorResponse(targetId.failure);
  const action = matched[2];
  let operation: ContainerSessionRequest;
  if (action === "inspect") {
    if (request.method !== "GET" || request.body !== null)
      return rejectedRequest("Inspect requires an empty GET request");
    operation = { action, targetId: targetId.success };
  } else {
    if (
      request.method !== "POST" ||
      mediaType(request.headers.get("content-type")) !== "application/json"
    )
      return rejectedRequest("Steer requires a JSON POST request");
    const bodyText = await readBoundedUtf8Body(request, PI_CONSOLE_MAX_COMMAND_BYTES);
    if (bodyText === undefined) return rejectedRequest("Steer request body is too large");
    const body = decodeJsonValue(bodyText);
    if (Option.isNone(body)) return rejectedRequest("Request body must be valid JSON");
    const message = Result.try({
      try: () => parseSteerInput(body.value),
      catch: () => badRequest("Invalid steer request"),
    });
    if (Result.isFailure(message)) return scottyErrorResponse(message.failure);
    operation = {
      action: "steer",
      targetId: targetId.success,
      message: message.success,
    };
  }

  if (typeof context.containerId !== "string" || context.containerId.length === 0)
    return scottyErrorResponse(
      new ScottyError("auth", "Container session source is unavailable", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );
  const source = Result.try(() => env.SANDBOX.get(env.SANDBOX.idFromString(context.containerId)));
  if (Result.isFailure(source))
    return scottyErrorResponse(
      new ScottyError("auth", "Container session source is unavailable", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );
  const relayed = await Promise.resolve()
    .then(() => source.success.containerSessionRequest(operation))
    .then(Result.succeed, () => Result.fail(undefined));
  if (Result.isFailure(relayed))
    return scottyErrorResponse(
      new ScottyError("internal", "Container session request failed", {
        httpStatus: 500,
        exitCode: 1,
      }),
    );
  return sanitizeResponse(relayed.success, operation.action);
}
