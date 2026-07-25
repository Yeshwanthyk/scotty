import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type {
  AuthRpcResult,
  ScottyAuthRegistryNamespace,
  ScottyAuthRegistryStub,
} from "./auth-object";
import {
  ADMIN_AUTH_SCOPES,
  type AuthClientView,
  type AuthScope,
  type IssuedClientCredential,
} from "./auth-registry";
import { ScottyError } from "./contracts";
import { constantTimeStringEqual } from "./digest";

export const AUTH_COOKIE = "__Host-scotty";
const AUTH_OBJECT_NAME = "account";

export interface AuthBindings {
  AUTH: ScottyAuthRegistryNamespace;
  SCOTTY_TOKEN: string;
}

export interface RootAuthPrincipal {
  readonly kind: "root";
  readonly source: "bearer";
  readonly scopes: ReadonlyArray<AuthScope>;
}

export interface ClientAuthPrincipal {
  readonly kind: "client";
  readonly source: "cookie" | "ticket";
  readonly credential?: string;
  readonly client: AuthClientView;
  readonly scopes: ReadonlyArray<AuthScope>;
  readonly renewed?: boolean;
}

export type AuthPrincipal = RootAuthPrincipal | ClientAuthPrincipal;

export interface AuthVariables {
  auth: AuthPrincipal;
}

export async function authenticateRequest(
  request: Request,
  env: AuthBindings,
): Promise<AuthPrincipal | undefined> {
  const authorization = request.headers.get("authorization");
  if (
    env.SCOTTY_TOKEN &&
    authorization?.startsWith("Bearer ") &&
    (await constantTimeStringEqual(authorization.slice(7), env.SCOTTY_TOKEN))
  )
    return { kind: "root", source: "bearer", scopes: [...ADMIN_AUTH_SCOPES] };

  const credential = requestClientCredential(request);
  if (!credential) return undefined;
  if (env.SCOTTY_TOKEN && (await constantTimeStringEqual(credential, env.SCOTTY_TOKEN)))
    return undefined;
  const result = await authRegistry(env).authenticate(credential);
  if (!result.ok) return undefined;
  return {
    kind: "client",
    source: "cookie",
    credential,
    client: result.value.client,
    scopes: result.value.client.scopes,
    ...(result.value.renewed ? { renewed: true } : {}),
  };
}

export async function requireAuthRequest(
  request: Request,
  env: AuthBindings,
): Promise<AuthPrincipal> {
  const principal = await authenticateRequest(request, env);
  if (principal) return principal;
  throw authenticationRequired();
}

export async function requireClientCookieRequest(
  request: Request,
  env: AuthBindings,
): Promise<ClientAuthPrincipal> {
  const principal = await authenticateRequest(request, env);
  if (principal?.kind === "client" && principal.source === "cookie") return principal;
  throw authenticationRequired();
}

export function requireAuthScope(principal: AuthPrincipal, scope: AuthScope): void {
  if (principal.scopes.includes(scope)) return;
  throw new ScottyError("auth", "This client isn't allowed to perform that action", {
    httpStatus: 401,
    exitCode: 4,
    hint: "Use the primary device for device management.",
  });
}

export function requireOwnerPrincipal(principal: AuthPrincipal): ClientAuthPrincipal {
  if (
    principal.kind === "client" &&
    principal.source === "cookie" &&
    principal.client.role === "owner" &&
    principal.credential
  )
    return principal;
  throw new ScottyError("auth", "The primary device is required", {
    httpStatus: 401,
    exitCode: 4,
    hint: "Open this page from the current primary device or use scotty owner recover.",
  });
}

export function setClientAuthCookie<T extends AuthBindings>(
  c: Context<{ Bindings: T; Variables: AuthVariables }>,
  issued: IssuedClientCredential,
): void {
  setClientCredentialCookie(c, issued.credential, issued.client.expiresAt);
}

export function refreshClientAuthCookie<T extends AuthBindings>(
  c: Context<{ Bindings: T; Variables: AuthVariables }>,
  principal: AuthPrincipal,
): void {
  if (
    principal.kind === "client" &&
    principal.source === "cookie" &&
    principal.renewed &&
    principal.credential
  )
    setClientCredentialCookie(c, principal.credential, principal.client.expiresAt);
}

function setClientCredentialCookie<T extends AuthBindings>(
  c: Context<{ Bindings: T; Variables: AuthVariables }>,
  credential: string,
  expiresAt: string,
): void {
  const remainingSeconds = Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000));
  setCookie(c, AUTH_COOKIE, credential, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: remainingSeconds,
  });
}

export function clearClientAuthCookie<T extends AuthBindings>(
  c: Context<{ Bindings: T; Variables: AuthVariables }>,
): void {
  deleteCookie(c, AUTH_COOKIE, {
    secure: true,
    sameSite: "Strict",
    path: "/",
  });
}

export function requestClientCredential(request: Request): string | undefined {
  return readCookie(request.headers.get("cookie"), AUTH_COOKIE);
}

export function requireClientCredential(principal: AuthPrincipal): string {
  if (principal.kind === "client" && principal.source === "cookie" && principal.credential)
    return principal.credential;
  throw authenticationRequired();
}

export function terminalTicketCredential(principal: AuthPrincipal): string {
  if (principal.kind === "client" && principal.source === "cookie" && principal.credential)
    return principal.credential;
  throw new ScottyError("auth", "Pair this browser before opening a terminal", {
    httpStatus: 401,
    exitCode: 4,
  });
}

export function authRegistry(env: AuthBindings): ScottyAuthRegistryStub {
  return env.AUTH.getByName(AUTH_OBJECT_NAME);
}

export function unwrapAuthRpc<A>(result: AuthRpcResult<A>): A {
  if (result.ok) return result.value;
  const { reason, message } = result.error;
  if (
    reason === "credential_invalid" ||
    reason === "pairing_invalid" ||
    reason === "recovery_invalid" ||
    reason === "ticket_invalid" ||
    reason === "transfer_invalid" ||
    reason === "forbidden" ||
    reason === "owner_required"
  ) {
    throw new ScottyError("auth", message, { httpStatus: 401, exitCode: 4 });
  }
  if (reason === "client_missing") {
    throw new ScottyError("not_found", message, { httpStatus: 404, exitCode: 3 });
  }
  if (
    reason === "capacity" ||
    reason === "outcome_unknown" ||
    reason === "self_revoke" ||
    reason === "transfer_pending"
  ) {
    throw new ScottyError("conflict", message, { httpStatus: 409, exitCode: 5 });
  }
  if (reason === "invalid_input") {
    throw new ScottyError("bad_request", message, { httpStatus: 400, exitCode: 2 });
  }
  throw new ScottyError("internal", "Authentication authority failed", {
    httpStatus: 500,
    exitCode: 1,
  });
}

export async function isAuthorizedRequest(request: Request, token: string): Promise<boolean> {
  if (!token) return false;
  const authorization = request.headers.get("authorization");
  return Boolean(
    authorization?.startsWith("Bearer ") &&
    (await constantTimeStringEqual(authorization.slice(7), token)),
  );
}

function authenticationRequired(): ScottyError {
  return new ScottyError("auth", "Authentication required", {
    httpStatus: 401,
    exitCode: 4,
    hint: "Open a fresh pairing or recovery link, or configure the CLI root token.",
  });
}

export function browserLabel(userAgent: string | undefined): string {
  if (!userAgent) return "Trusted browser";
  if (/iPhone|iPad/iu.test(userAgent)) return "iPhone or iPad";
  if (/Android/iu.test(userAgent)) return "Android browser";
  if (/Helium/iu.test(userAgent)) return "Helium browser";
  return "Trusted browser";
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
