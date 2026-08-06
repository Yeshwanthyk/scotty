import type { OutboundHandlerContext } from "@cloudflare/containers";
import { ContainerProxy as SandboxContainerProxy } from "@cloudflare/sandbox";
import { Option, Result, Schema } from "effect";
import {
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  PiConsoleSnapshotV1Schema,
} from "../../protocol/pi-console";
import type { Bindings } from "./bindings";
import { readBoundedJson, readBoundedUtf8Body } from "./bounded-http";
import {
  badRequest,
  decodeJsonValue,
  parseSessionId,
  parseSteerInput,
  ScottyError,
  type ContainerSessionRequest,
} from "./contracts";
import { scottyErrorResponse } from "./passive-session";

// Deployed-canary gate: cloudflare/sandbox:0.12.3 must prove that its TLS trust store
// accepts the SDK interception certificate for this reserved host.
export const SCOTTY_INTERNAL_HOST = "scotty.internal";

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
  Schema.Union([PiConsoleSnapshotV1Schema, ErrorEnvelopeSchema]),
  { onExcessProperty: "error" },
);
const decodeSteerResponse = Schema.decodeUnknownOption(
  Schema.Union([SteerResponseSchema, ErrorEnvelopeSchema]),
  { onExcessProperty: "error" },
);

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

export async function handleContainerSessionEgress(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== SCOTTY_INTERNAL_HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return rejectedRequest("Invalid container session route");
  if (rejectsAmbientAuthority(request.headers))
    return scottyErrorResponse(
      new ScottyError("auth", "Container session request must not include ambient authority", {
        httpStatus: 401,
        exitCode: 4,
      }),
    );

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
    operation = { version: 1, action, targetId: targetId.success };
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
      version: 1,
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
