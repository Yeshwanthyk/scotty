import { Effect, Option } from "effect";
import {
  CliError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EXIT,
  MAX_RESPONSE_BYTES,
  MUTATION_REQUEST_TIMEOUT_MS,
} from "./core";
import { decodeErrorEnvelope, decodeErrorFields, decodeJsonValue, decodeString } from "./schemas";
import { HttpTransport } from "./services";
import { invalidResponse, redact, statusExit } from "./pure";

const networkError = (): CliError =>
  new CliError(
    "network_error",
    "Could not reach the Scotty Worker",
    "Check --host and your network, then retry.",
    EXIT.GENERIC,
  );

const timeoutError = (): CliError =>
  new CliError(
    "timeout",
    "Request timed out",
    "Check --host and your network, then retry.",
    EXIT.GENERIC,
  );

export const readLimited = Effect.fnUntraced(function* (response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES)
    return yield* new CliError(
      "response_too_large",
      "Server response is too large",
      "Retry the operation or inspect the Worker.",
      EXIT.GENERIC,
    );
  const bytes = new Uint8Array(
    yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: networkError,
    }),
  );
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    return yield* new CliError(
      "response_too_large",
      "Server response is too large",
      "Retry the operation or inspect the Worker.",
      EXIT.GENERIC,
    );
  return bytes;
});

export type ApiRequestTarget =
  | { readonly host: string; readonly token: string }
  | { readonly host: "https://scotty.internal"; readonly token?: never };

export const apiRequest = Effect.fnUntraced(function* (
  target: ApiRequestTarget,
  path: string,
  init: RequestInit = {},
) {
  const transport = yield* HttpTransport;
  const method = init.method || "GET";
  const timeout =
    method === "GET" && !path.endsWith("/down")
      ? DEFAULT_REQUEST_TIMEOUT_MS
      : MUTATION_REQUEST_TIMEOUT_MS;
  const headers = new Headers(init.headers);
  if (target.token !== undefined) headers.set("authorization", `Bearer ${target.token}`);
  headers.set("accept", "application/json, application/x-tar, application/octet-stream");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (method !== "GET" && !headers.has("idempotency-key"))
    headers.set("idempotency-key", crypto.randomUUID());
  const responseOption = yield* transport
    .fetch(`${target.host}${path}`, { ...init, headers })
    .pipe(Effect.timeoutOption(timeout));
  if (Option.isNone(responseOption)) return yield* timeoutError();
  const response = responseOption.value;
  const bytes = yield* readLimited(response);
  if (!response.ok) {
    const json = decodeJsonValue(new TextDecoder().decode(bytes));
    const envelope = Option.isSome(json) ? decodeErrorEnvelope(json.value) : Option.none();
    const fields =
      Option.isSome(envelope) && envelope.value.error !== undefined
        ? decodeErrorFields(envelope.value.error)
        : Option.none();
    const code = Option.isSome(fields)
      ? (Option.getOrUndefined(decodeString(fields.value.code)) ?? `http_${response.status}`)
      : `http_${response.status}`;
    const message =
      (Option.isSome(fields)
        ? Option.getOrUndefined(decodeString(fields.value.message))
        : undefined) ?? `Request failed with HTTP ${response.status}`;
    const hint =
      (Option.isSome(fields)
        ? Option.getOrUndefined(decodeString(fields.value.hint))
        : undefined) ?? "Check the session state and Worker logs.";
    return yield* new CliError(
      redact(code, target.token === undefined ? [] : [target.token]),
      redact(message, target.token === undefined ? [] : [target.token]),
      redact(hint, target.token === undefined ? [] : [target.token]),
      statusExit(response.status, code),
    );
  }
  return { response, bytes };
});

export const decodeJson = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const decoded = decodeJsonValue(new TextDecoder().decode(bytes));
  if (Option.isNone(decoded)) return yield* invalidResponse("Server returned invalid JSON");
  return decoded.value;
});

export const requestJson = Effect.fnUntraced(function* (
  target: ApiRequestTarget,
  path: string,
  init?: RequestInit,
) {
  const { bytes } = yield* apiRequest(target, path, init);
  return yield* decodeJson(bytes);
});
