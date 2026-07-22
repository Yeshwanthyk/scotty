import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Option } from "effect";
import type { Bindings } from "./bindings";
import {
  decodeCredentialPatchOption,
  decodeCredentialRefreshLeaseOption,
  decodeJsonValue,
  decodeOAuthContainerResultOption,
  decodeOAuthRefreshRequestOption,
  decodeOAuthUpstreamSuccessOption,
  decodeRawCodexCredential,
  decodeRawCodexTokenSet,
  decodeRawOAuthUpstreamSuccess,
  decodeStoredCredentialOption,
  type CodexCredentialBundle,
  type CredentialPatch,
  type CredentialRefreshLease,
  type OAuthContainerResult,
  type OAuthRefreshRequest,
  type StoredCredential,
} from "./contracts";

export const CODEX_SENTINEL_PREFIX = "scotty-codex-";
export const GITHUB_SENTINEL_PREFIX = "scotty-github-";

export const ALLOWED_HOSTS = [
  "api.openai.com",
  "chatgpt.com",
  "auth.openai.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
] as const;

export type {
  CodexCredentialBundle,
  CredentialPatch,
  CredentialRefreshLease,
  StoredCredential,
} from "./contracts";

type EgressContext = OutboundHandlerContext<unknown>;

export function parseCodexCredential(raw: string): CodexCredentialBundle {
  const json = decodeJsonValue(raw);
  // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: preserve the synchronous seed parser's fixed, secret-safe error contract
  if (Option.isNone(json)) throw new Error("CODEX_AUTH_JSON is not valid JSON");
  const decoded = decodeRawCodexCredential(json.value);
  // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: preserve the synchronous seed parser's fixed, secret-safe error contract
  if (Option.isNone(decoded)) throw new Error("CODEX_AUTH_JSON must contain a JSON object");

  const apiKey = optionalString(decoded.value.OPENAI_API_KEY);
  const legacyAccountId = optionalString(decoded.value.account_id);
  let tokens: CodexCredentialBundle["tokens"];
  if (decoded.value.tokens !== undefined && decoded.value.tokens !== null) {
    const decodedTokens = decodeRawCodexTokenSet(decoded.value.tokens);
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: preserve the synchronous seed parser's fixed, secret-safe error contract
    if (Option.isNone(decodedTokens)) throw new Error("CODEX_AUTH_JSON tokens must be an object");
    tokens = {
      id_token: optionalString(decodedTokens.value.id_token) ?? undefined,
      access_token: optionalString(decodedTokens.value.access_token) ?? undefined,
      refresh_token: optionalString(decodedTokens.value.refresh_token) ?? undefined,
      account_id: optionalString(decodedTokens.value.account_id),
    };
  }

  if (!apiKey && !tokens?.access_token) {
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: preserve the synchronous seed parser's fixed, secret-safe error contract
    throw new Error("CODEX_AUTH_JSON must contain OPENAI_API_KEY or tokens.access_token");
  }

  return {
    OPENAI_API_KEY: apiKey,
    tokens,
    account_id: legacyAccountId,
    last_refresh: optionalString(decoded.value.last_refresh),
  };
}

export function decodeStoredCredential(value: unknown): StoredCredential {
  const decoded = decodeStoredCredentialOption(value);
  // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: synchronous DO/RPC decoding must fail closed with a fixed secret-safe error
  if (Option.isNone(decoded)) throw new Error("Stored credential record is invalid");
  return decoded.value;
}

export function decodeCredentialPatch(value: unknown): CredentialPatch {
  const decoded = decodeCredentialPatchOption(value);
  // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: synchronous RPC decoding preserves the existing thrown host contract
  if (Option.isNone(decoded)) throw new Error("Credential patch is invalid");
  return decoded.value;
}

export function decodeCredentialRefreshLease(value: unknown): CredentialRefreshLease | null {
  const decoded = decodeCredentialRefreshLeaseOption(value);
  // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: synchronous RPC decoding preserves the existing thrown host contract
  if (Option.isNone(decoded)) throw new Error("Credential refresh lease is invalid");
  return decoded.value;
}

export function parseOAuthRefreshRequest(value: unknown): OAuthRefreshRequest | null {
  return Option.getOrNull(decodeOAuthRefreshRequestOption(value, { onExcessProperty: "preserve" }));
}

export function parseOAuthUpstreamSuccess(value: unknown): CredentialPatch | null {
  const raw = decodeRawOAuthUpstreamSuccess(value);
  if (Option.isNone(raw)) return null;
  const decoded = decodeOAuthUpstreamSuccessOption({
    id_token: optionalString(raw.value.id_token) ?? undefined,
    access_token: optionalString(raw.value.access_token) ?? undefined,
    refresh_token: optionalString(raw.value.refresh_token) ?? undefined,
  });
  if (Option.isNone(decoded)) return null;
  return Option.getOrNull(
    decodeCredentialPatchOption({
      accessToken: decoded.value.access_token,
      ...(decoded.value.id_token === undefined ? {} : { idToken: decoded.value.id_token }),
      ...(decoded.value.refresh_token === undefined
        ? {}
        : { refreshToken: decoded.value.refresh_token }),
    }),
  );
}

export function oauthContainerResult(credential: StoredCredential): OAuthContainerResult {
  const value = {
    id_token: syntheticIdToken(credential.codex.tokens?.account_id ?? credential.codex.account_id),
    access_token: credential.codexSentinel,
    refresh_token: credential.codexSentinel,
  };
  const decoded = decodeOAuthContainerResultOption(value);
  // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: synchronous native response construction preserves the existing thrown host contract
  if (Option.isNone(decoded)) throw new Error("OAuth container result is invalid");
  return decoded.value;
}

export function sentinelAuthJson(credential: StoredCredential): string {
  const accountId = credential.codex.tokens?.account_id ?? credential.codex.account_id;
  return JSON.stringify({
    auth_mode: credential.codex.OPENAI_API_KEY ? "apikey" : "chatgpt",
    OPENAI_API_KEY: credential.codex.OPENAI_API_KEY ? credential.codexSentinel : null,
    tokens: credential.codex.tokens
      ? {
          id_token: syntheticIdToken(accountId),
          access_token: credential.codexSentinel,
          refresh_token: credential.codexSentinel,
          account_id: credential.codexSentinel,
        }
      : null,
    last_refresh: credential.codex.last_refresh ?? null,
  });
}

export async function proxyOpenAI(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  const sentinel = presentedCredential(request.headers);
  const credential = sentinel ? await credentialForSentinel(sentinel, env, context) : null;
  if (!credential || sentinel !== credential.codexSentinel) return forbidden();

  const url = new URL(request.url);
  const headers = sanitizedHeaders(request.headers);
  const token = credential.codex.OPENAI_API_KEY ?? credential.codex.tokens?.access_token;
  if (!token) return forbidden();
  headers.set("authorization", `Bearer ${token}`);
  headers.delete("x-api-key");
  return forward(request, url, headers);
}

export async function proxyChatGpt(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  const sentinel = presentedCredential(request.headers);
  const credential = sentinel ? await credentialForSentinel(sentinel, env, context) : null;
  if (!credential?.codex.tokens?.access_token || sentinel !== credential.codexSentinel)
    return forbidden();

  const url = new URL(request.url);
  const headers = sanitizedHeaders(request.headers);
  headers.set("authorization", `Bearer ${credential.codex.tokens.access_token}`);
  const accountId = credential.codex.tokens.account_id ?? credential.codex.account_id;
  if (accountId) headers.set("chatgpt-account-id", accountId);
  return forward(request, url, headers);
}

export async function proxyOAuthRefresh(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/oauth/token") return forbidden();

  const requestJson = decodeJsonValue(await request.text());
  const body = Option.isSome(requestJson) ? parseOAuthRefreshRequest(requestJson.value) : null;
  if (!body) return forbidden();

  const refreshValue: unknown = await credentialStub(env, context).beginCredentialRefresh(
    body.refresh_token,
  );
  const refresh = decodeCredentialRefreshLease(refreshValue);
  const credential = refresh?.credential;
  const realRefreshToken = credential?.codex.tokens?.refresh_token;
  if (!refresh || !credential || !realRefreshToken) {
    return Response.json(
      { error: { code: "oauth_refresh_busy", message: "OAuth refresh is already in progress" } },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const upstreamBody = JSON.stringify({ ...body, refresh_token: realRefreshToken });
  const headers = sanitizedHeaders(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const upstream = await fetch(
    new Request(`https://auth.openai.com${url.pathname}${url.search}`, {
      method: "POST",
      headers,
      body: upstreamBody,
      redirect: "manual",
    }),
  );
  if (!upstream.ok) {
    await credentialStub(env, context).cancelCredentialRefresh(
      credential.codexSentinel,
      refresh.nonce,
    );
    return Response.json(
      { error: { code: "oauth_refresh_failed", message: "OAuth refresh failed" } },
      { status: upstream.status, headers: { "cache-control": "no-store" } },
    );
  }

  const responseJson = decodeJsonValue(await upstream.text());
  const patch = Option.isSome(responseJson) ? parseOAuthUpstreamSuccess(responseJson.value) : null;
  if (!patch) {
    await credentialStub(env, context).cancelCredentialRefresh(
      credential.codexSentinel,
      refresh.nonce,
    );
    return new Response("Invalid OAuth response", { status: 502 });
  }

  let persisted = false;
  for (let attempt = 0; attempt < 3 && !persisted; attempt += 1) {
    try {
      await credentialStub(env, context).persistRotatedCredential(
        credential.codexSentinel,
        patch,
        refresh.nonce,
      );
      persisted = true;
    } catch {
      // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: native outbound callback preserves the existing exhausted-retry rejection
      if (attempt === 2) throw new Error("Failed to persist rotated OAuth credential");
    }
  }

  const safeBody = JSON.stringify(oauthContainerResult(credential));
  const responseHeaders = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  return new Response(safeBody, { status: upstream.status, headers: responseHeaders });
}

export async function proxyGitHub(
  request: Request,
  env: Bindings,
  context: EgressContext,
): Promise<Response> {
  const presented = presentedCredential(request.headers);
  if (!presented) return passThrough(request);

  const credential = await credentialForSentinel(presented, env, context);
  if (!credential || presented !== credential.githubSentinel) return forbidden();

  const headers = sanitizedHeaders(request.headers);
  const original = request.headers.get("authorization") ?? "";
  if (original.startsWith("Basic ")) {
    headers.set("authorization", `Basic ${btoa(`x-access-token:${credential.githubToken}`)}`);
  } else {
    headers.set("authorization", `Bearer ${credential.githubToken}`);
  }
  return forward(request, new URL(request.url), headers);
}

export async function passThrough(request: Request): Promise<Response> {
  const headers = sanitizedHeaders(request.headers);
  if (headers.has("authorization") || headers.has("proxy-authorization") || headers.has("cookie"))
    return forbidden();
  return forward(request, new URL(request.url), headers);
}

export function denyOutbound(): Response {
  return forbidden();
}

async function credentialForSentinel(
  sentinel: string,
  env: Bindings,
  context: EgressContext,
): Promise<StoredCredential | null> {
  if (!sentinel.startsWith(CODEX_SENTINEL_PREFIX) && !sentinel.startsWith(GITHUB_SENTINEL_PREFIX))
    return null;
  const value: unknown = await credentialStub(env, context).readCredentialForProxy(sentinel);
  if (value === null) return null;
  return decodeStoredCredential(value);
}

function credentialStub(
  env: Bindings,
  context: EgressContext,
): DurableObjectStub<import("./session").Sandbox> {
  // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: native outbound callback requires the SDK-provided container identity
  if (!context.containerId) throw new Error("Missing sandbox container id");
  return env.SANDBOX.get(env.SANDBOX.idFromString(context.containerId));
}

function presentedCredential(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization) return headers.get("x-api-key");
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6));
      const separator = decoded.indexOf(":");
      return separator >= 0 ? decoded.slice(separator + 1) : null;
    } catch {
      return null;
    }
  }
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function sanitizedHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  return headers;
}

function forward(request: Request, url: URL, headers: Headers): Promise<Response> {
  return fetch(
    new Request(`https://${url.hostname}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    }),
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function syntheticIdToken(accountId?: string | null): string {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId ? "scotty-sentinel" : undefined,
        chatgpt_plan_type: "unknown",
      },
    }),
  );
  return `${header}.${payload}.scotty`;
}

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function forbidden(): Response {
  return new Response("Forbidden by Scotty egress policy", { status: 403 });
}
