import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type {
  AuthRpcResult,
  ScottyAuthRegistryNamespace,
  ScottyAuthRegistryStub,
} from "./auth-object";
import type { AuthClientView, AuthScope, IssuedClientCredential } from "./auth-registry";
import { ADMIN_AUTH_SCOPES } from "./auth-registry";
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
  readonly source: "bearer" | "cookie" | "query";
  readonly scopes: ReadonlyArray<AuthScope>;
}

export interface ClientAuthPrincipal {
  readonly kind: "client";
  readonly source: "cookie" | "ticket";
  readonly credential?: string;
  readonly client: AuthClientView;
  readonly scopes: ReadonlyArray<AuthScope>;
}

export type AuthPrincipal = RootAuthPrincipal | ClientAuthPrincipal;

export interface AuthVariables {
  auth: AuthPrincipal;
}

export async function authenticateRequest(
  request: Request,
  env: AuthBindings,
  allowRootQuery = false,
): Promise<AuthPrincipal | undefined> {
  const authorization = request.headers.get("authorization");
  if (
    env.SCOTTY_TOKEN &&
    authorization?.startsWith("Bearer ") &&
    (await constantTimeStringEqual(authorization.slice(7), env.SCOTTY_TOKEN))
  )
    return { kind: "root", source: "bearer", scopes: [...ADMIN_AUTH_SCOPES] };

  const credential = readCookie(request.headers.get("cookie"), AUTH_COOKIE);
  if (credential) {
    if (env.SCOTTY_TOKEN && (await constantTimeStringEqual(credential, env.SCOTTY_TOKEN)))
      return { kind: "root", source: "cookie", scopes: [...ADMIN_AUTH_SCOPES] };
    const result = await authRegistry(env).authenticate(credential);
    if (result.ok)
      return {
        kind: "client",
        source: "cookie",
        credential,
        client: result.value,
        scopes: result.value.scopes,
      };
  }

  if (allowRootQuery && env.SCOTTY_TOKEN) {
    const candidate = new URL(request.url).searchParams.get("t");
    if (candidate && (await constantTimeStringEqual(candidate, env.SCOTTY_TOKEN)))
      return { kind: "root", source: "query", scopes: [...ADMIN_AUTH_SCOPES] };
  }
  return undefined;
}

export async function requireAuthRequest(
  request: Request,
  env: AuthBindings,
  allowRootQuery = false,
): Promise<AuthPrincipal> {
  const principal = await authenticateRequest(request, env, allowRootQuery);
  if (principal) return principal;
  throw authenticationRequired();
}

export function requireAuthScope(principal: AuthPrincipal, scope: AuthScope): void {
  if (principal.scopes.includes(scope)) return;
  throw new ScottyError("auth", "This browser isn't allowed to manage access", {
    httpStatus: 401,
    exitCode: 4,
    hint: "Use an administrator browser to manage registered devices.",
  });
}

export async function registerRootBrowser<T extends AuthBindings>(
  c: Context<{ Bindings: T; Variables: AuthVariables }>,
  principal: AuthPrincipal,
): Promise<AuthPrincipal> {
  if (principal.kind === "client") return principal;
  const result = await authRegistry(c.env).registerBootstrapClient(
    browserLabel(c.req.header("user-agent")),
    c.req.header("user-agent"),
  );
  const issued = unwrapAuthRpc(result);
  setClientAuthCookie(c, issued);
  return {
    kind: "client",
    source: "cookie",
    credential: issued.credential,
    client: issued.client,
    scopes: issued.client.scopes,
  };
}

export async function registeredRootBrowserRedirect<T extends AuthBindings>(
  c: Context<{ Bindings: T; Variables: AuthVariables }>,
  principal: AuthPrincipal,
  location: string,
): Promise<Response | undefined> {
  if (principal.kind !== "root") return undefined;
  await registerRootBrowser(c, principal);
  return c.redirect(location, 302);
}

export function setClientAuthCookie<T extends AuthBindings>(
  c: Context<{ Bindings: T; Variables: AuthVariables }>,
  issued: IssuedClientCredential,
): void {
  const remainingSeconds = Math.max(
    1,
    Math.floor((Date.parse(issued.client.expiresAt) - Date.now()) / 1_000),
  );
  setCookie(c, AUTH_COOKIE, issued.credential, {
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

export function terminalTicketCredential(principal: AuthPrincipal, request: Request): string {
  const credential =
    principal.kind === "client" && principal.source === "cookie"
      ? principal.credential
      : requestClientCredential(request);
  if (credential) return credential;
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
    reason === "ticket_invalid" ||
    reason === "forbidden"
  ) {
    throw new ScottyError("auth", message, { httpStatus: 401, exitCode: 4 });
  }
  if (reason === "client_missing") {
    throw new ScottyError("not_found", message, { httpStatus: 404, exitCode: 3 });
  }
  if (reason === "capacity" || reason === "self_revoke") {
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

export async function isAuthorizedRequest(
  request: Request,
  token: string,
  allowQuery = false,
): Promise<boolean> {
  return Boolean(await rootCredentialSource(request, token, allowQuery));
}

async function rootCredentialSource(
  request: Request,
  token: string,
  allowQuery: boolean,
): Promise<RootAuthPrincipal["source"] | undefined> {
  if (!token) return undefined;
  const authorization = request.headers.get("authorization");
  if (
    authorization?.startsWith("Bearer ") &&
    (await constantTimeStringEqual(authorization.slice(7), token))
  )
    return "bearer";

  const cookie = readCookie(request.headers.get("cookie"), AUTH_COOKIE);
  if (cookie && (await constantTimeStringEqual(cookie, token))) return "cookie";

  if (allowQuery) {
    const candidate = new URL(request.url).searchParams.get("t");
    if (candidate && (await constantTimeStringEqual(candidate, token))) return "query";
  }
  return undefined;
}

function authenticationRequired(): ScottyError {
  return new ScottyError("auth", "Authentication required", {
    httpStatus: 401,
    exitCode: 4,
    hint: "Open a fresh pairing link or run scotty init with a bootstrap token.",
  });
}

function browserLabel(userAgent: string | undefined): string {
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
