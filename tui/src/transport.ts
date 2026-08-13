import {
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  commandIntentDigest,
  type PiConsoleCommandErrorV1,
  type PiConsoleCommandReceiptV1,
  type PiConsoleCommandV1,
  type PiConsoleEventEnvelopeV1,
  type PiConsoleStaleCommandV1,
  type PiConsoleUnavailableV1,
} from "../../protocol/pi-console.ts";
import { TuiError } from "./errors.ts";
import {
  decodeApiErrorMessage,
  decodeClientCredential,
  decodeCommandError,
  decodeCreateSessionResult,
  decodeEnvelope,
  decodeFleet,
  decodeJsonText,
  decodeReceipt,
  decodeSelected,
  decodeSnapshot,
  decodeStaleCommand,
  decodeUnavailable,
  decodeVaporizeSessionResult,
  type ConsoleSnapshotResult,
  type CreateSessionResult,
  type FleetSession,
  type TuiConfig,
  type SelectedSession,
} from "./schemas.ts";
import { redactRemoteString } from "./redaction.ts";

const MAX_SSE_EVENT_BYTES = 256 * 1024;
const MAX_SSE_BUFFER_BYTES = MAX_SSE_EVENT_BYTES * 2;
const REQUEST_TIMEOUT_MS = 15_000;
const encoder = new TextEncoder();

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ReadOnlyConsoleTransport {
  readonly listFleet: () => Promise<ReadonlyArray<FleetSession>>;
  readonly getSelected: (sessionId: string, signal?: AbortSignal) => Promise<SelectedSession>;
  readonly getSnapshot: (sessionId: string, signal?: AbortSignal) => Promise<ConsoleSnapshotResult>;
  readonly streamEvents: (
    sessionId: string,
    epoch: string,
    since: number,
    signal: AbortSignal,
  ) => AsyncIterable<PiConsoleEventEnvelopeV1>;
}

export type CommandResult =
  | PiConsoleCommandReceiptV1
  | PiConsoleStaleCommandV1
  | PiConsoleUnavailableV1
  | PiConsoleCommandErrorV1;

export interface ConsoleTransport extends ReadOnlyConsoleTransport {
  readonly postCommand: (sessionId: string, command: PiConsoleCommandV1) => Promise<CommandResult>;
}

export interface CreateSessionInput {
  readonly title: string;
  readonly prompt: string;
  readonly repo: string;
  readonly hardCapSeconds: number;
}

export interface DesktopManagementTransport extends ConsoleTransport {
  readonly createSession: (
    input: CreateSessionInput,
    requestId: string,
  ) => Promise<CreateSessionResult>;
  readonly renameSession: (
    sessionId: string,
    title: string,
    requestId: string,
  ) => Promise<SelectedSession>;
  readonly snapshotSession: (sessionId: string, requestId: string) => Promise<SelectedSession>;
  readonly resumeSession: (sessionId: string, requestId: string) => Promise<SelectedSession>;
  readonly vaporizeSession: (sessionId: string, requestId: string) => Promise<void>;
}

export interface HttpConsoleTransportOptions {
  readonly fetch?: FetchImplementation;
  readonly onCredential?: (credential: string) => Promise<void>;
}

export const readBoundedText = async (response: Response, maxBytes: number): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new TuiError("response_too_large", "Scotty response exceeded its size limit");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new TuiError("response_too_large", "Scotty response exceeded its size limit");
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
};

const responseJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const decoded = decodeJsonText(await readBoundedText(response, maxBytes));
  if (decoded === undefined)
    throw new TuiError("response_invalid", "Scotty returned invalid JSON", response.status);
  return decoded;
};

export const extractClientCookie = (header: string | null): string | undefined => {
  if (header === null) return undefined;
  const match = /(?:^|,\s*)__Host-scotty=([^;,\s]+)/u.exec(header);
  return decodeClientCredential(match?.[1]);
};

export class HttpConsoleTransport implements DesktopManagementTransport {
  readonly #origin: string;
  #credential: string;
  readonly #fetch: FetchImplementation;
  readonly #onCredential: ((credential: string) => Promise<void>) | undefined;

  constructor(config: TuiConfig, options: HttpConsoleTransportOptions = {}) {
    this.#origin = config.origin;
    this.#credential = config.credential;
    this.#fetch = options.fetch ?? fetch;
    this.#onCredential = options.onCredential;
  }

  readonly #url = (path: string): URL => {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin)
      throw new TuiError("transport_failed", "Refused a cross-origin Scotty request");
    return url;
  };

  readonly #headers = (accept: string): Headers =>
    new Headers({
      accept,
      cookie: `__Host-scotty=${this.#credential}`,
    });

  readonly #refreshCredential = async (response: Response): Promise<void> => {
    const renewed = extractClientCookie(response.headers.get("set-cookie"));
    if (renewed === undefined || renewed === this.#credential) return;
    this.#credential = renewed;
    await this.#onCredential?.(renewed);
  };

  readonly #get = async (
    path: string,
    accept = "application/json",
    signal?: AbortSignal,
  ): Promise<Response> => {
    const response = await this.#fetch(this.#url(path), {
      method: "GET",
      headers: this.#headers(accept),
      redirect: "error",
      cache: "no-store",
      signal:
        signal === undefined
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (response.url && new URL(response.url).origin !== this.#origin)
      throw new TuiError("transport_failed", "Refused a cross-origin Scotty response");
    await this.#refreshCredential(response);
    return response;
  };

  readonly #mutate = async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> => {
    const headers = this.#headers("application/json");
    headers.set("origin", this.#origin);
    headers.set("sec-fetch-site", "same-origin");
    if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(this.#url(path), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.url && new URL(response.url).origin !== this.#origin)
      throw new TuiError("transport_failed", "Refused a cross-origin Scotty response");
    await this.#refreshCredential(response);
    const json = await responseJson(response, PI_CONSOLE_MAX_RESPONSE_BYTES);
    if (!response.ok) {
      const message = decodeApiErrorMessage(json);
      throw new TuiError(
        "transport_failed",
        message === undefined
          ? `Sandbox operation failed with HTTP ${response.status}`
          : redactRemoteString(message).slice(0, 1024),
        response.status,
      );
    }
    return json;
  };

  readonly listFleet = async (): Promise<ReadonlyArray<FleetSession>> => {
    const response = await this.#get("/api/sessions");
    if (!response.ok)
      throw new TuiError("transport_failed", "Fleet inventory request failed", response.status);
    const decoded = decodeFleet(await responseJson(response, PI_CONSOLE_MAX_RESPONSE_BYTES));
    if (decoded === undefined)
      throw new TuiError("response_invalid", "Fleet inventory response was invalid");
    return decoded;
  };

  readonly getSelected = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SelectedSession> => {
    const response = await this.#get(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      "application/json",
      signal,
    );
    if (!response.ok)
      throw new TuiError(
        "transport_failed",
        "Selected-session metadata request failed",
        response.status,
      );
    const decoded = decodeSelected(await responseJson(response, PI_CONSOLE_MAX_RESPONSE_BYTES));
    if (decoded === undefined)
      throw new TuiError("response_invalid", "Selected-session metadata was invalid");
    return decoded;
  };

  readonly createSession = async (
    input: CreateSessionInput,
    requestId: string,
  ): Promise<CreateSessionResult> => {
    const json = await this.#mutate(
      "/api/sessions",
      "POST",
      { ...input, provider: "cloudflare" },
      `scotty-desktop:create:${requestId}`,
    );
    const result = decodeCreateSessionResult(json);
    if (result === undefined)
      throw new TuiError("response_invalid", "Create-sandbox response was invalid");
    return result;
  };

  readonly renameSession = async (
    sessionId: string,
    title: string,
    _requestId: string,
  ): Promise<SelectedSession> => {
    const json = await this.#mutate(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
      title,
    });
    const result = decodeSelected(json);
    if (result === undefined || result.id !== sessionId)
      throw new TuiError("response_invalid", "Rename-sandbox response was invalid");
    return result;
  };

  readonly snapshotSession = async (
    sessionId: string,
    _requestId: string,
  ): Promise<SelectedSession> => {
    const json = await this.#mutate(
      `/api/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      "POST",
    );
    const result = decodeSelected(json);
    if (result === undefined || result.id !== sessionId)
      throw new TuiError("response_invalid", "Snapshot response was invalid");
    return result;
  };

  readonly resumeSession = async (
    sessionId: string,
    _requestId: string,
  ): Promise<SelectedSession> => {
    const json = await this.#mutate(
      `/api/sessions/${encodeURIComponent(sessionId)}/resume`,
      "POST",
    );
    const result = decodeSelected(json);
    if (result === undefined || result.id !== sessionId)
      throw new TuiError("response_invalid", "Resume response was invalid");
    return result;
  };

  readonly vaporizeSession = async (sessionId: string, _requestId: string): Promise<void> => {
    const json = await this.#mutate(`/api/sessions/${encodeURIComponent(sessionId)}`, "DELETE");
    const result = decodeVaporizeSessionResult(json);
    if (result === undefined || result.id !== sessionId)
      throw new TuiError("response_invalid", "Vaporize response was invalid");
  };

  readonly getSnapshot = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ConsoleSnapshotResult> => {
    const response = await this.#get(
      `/s/${encodeURIComponent(sessionId)}/console/v1/snapshot`,
      "application/json",
      signal,
    );
    const json = await responseJson(response, PI_CONSOLE_MAX_RESPONSE_BYTES);
    const unavailable = decodeUnavailable(json);
    if (unavailable !== undefined) return unavailable;
    if (!response.ok)
      throw new TuiError("transport_failed", "Console snapshot request failed", response.status);
    const snapshot = decodeSnapshot(json);
    if (snapshot === undefined)
      throw new TuiError("response_invalid", "Console snapshot response was invalid");
    return snapshot;
  };

  readonly postCommand = async (
    sessionId: string,
    command: PiConsoleCommandV1,
  ): Promise<CommandResult> => {
    const response = await this.#fetch(
      this.#url(`/s/${encodeURIComponent(sessionId)}/console/v1/command`),
      {
        method: "POST",
        headers: new Headers({
          ...Object.fromEntries(this.#headers("application/json")),
          "content-type": "application/json",
          origin: this.#origin,
          "sec-fetch-site": "same-origin",
        }),
        body: JSON.stringify(command),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (response.url && new URL(response.url).origin !== this.#origin)
      throw new TuiError("transport_failed", "Refused a cross-origin Scotty response");
    await this.#refreshCredential(response);
    const json = await responseJson(response, PI_CONSOLE_MAX_RESPONSE_BYTES);
    const stale = decodeStaleCommand(json);
    if (stale !== undefined) return stale;
    const unavailable = decodeUnavailable(json);
    if (unavailable !== undefined) return unavailable;
    const commandError = decodeCommandError(json);
    if (commandError !== undefined) return commandError;
    const receipt = decodeReceipt(json);
    const expectedDigest = await commandIntentDigest(command.intent);
    if (
      receipt === undefined ||
      receipt.commandId !== command.commandId ||
      receipt.epoch !== command.epoch ||
      receipt.commandDigest !== expectedDigest
    )
      throw new TuiError(
        "response_invalid",
        "Console command outcome could not be verified",
        response.status,
      );
    return receipt;
  };

  readonly streamEvents = async function* (
    this: HttpConsoleTransport,
    sessionId: string,
    epoch: string,
    since: number,
    signal: AbortSignal,
  ): AsyncIterable<PiConsoleEventEnvelopeV1> {
    const query = new URLSearchParams({ epoch, since: String(since) });
    const response = await this.#fetch(
      this.#url(`/s/${encodeURIComponent(sessionId)}/console/v1/events?${query}`),
      {
        method: "GET",
        headers: this.#headers("text/event-stream"),
        redirect: "error",
        cache: "no-store",
        signal,
      },
    );
    if (response.url && new URL(response.url).origin !== this.#origin)
      throw new TuiError("transport_failed", "Refused a cross-origin Scotty response");
    await this.#refreshCredential(response);
    if (!response.ok || response.body === null)
      throw new TuiError("transport_failed", "Console event stream unavailable", response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
        if (encoder.encode(buffer).byteLength > MAX_SSE_BUFFER_BYTES)
          throw new TuiError("stream_invalid", "Console event buffer exceeded its limit");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data && encoder.encode(data).byteLength <= MAX_SSE_EVENT_BYTES) {
            const json = decodeJsonText(data);
            const envelope = json === undefined ? undefined : decodeEnvelope(json);
            if (envelope === undefined)
              throw new TuiError("stream_invalid", "Console event payload was invalid");
            yield envelope;
          } else if (data) {
            throw new TuiError("stream_invalid", "Console event exceeded its size limit");
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
}
