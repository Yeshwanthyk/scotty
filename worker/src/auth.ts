import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { ScottyError } from "./contracts";

export const AUTH_COOKIE = "__Host-scotty";

export interface AuthBindings {
  SCOTTY_TOKEN: string;
}

export async function isAuthorizedRequest(
  request: Request,
  token: string,
  allowQuery = false,
): Promise<boolean> {
  if (!token) return false;

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ") && (await safeEqual(authorization.slice(7), token)))
    return true;

  const cookie = readCookie(request.headers.get("cookie"), AUTH_COOKIE);
  if (cookie && (await safeEqual(cookie, token))) return true;

  if (allowQuery) {
    const candidate = new URL(request.url).searchParams.get("t");
    if (candidate && (await safeEqual(candidate, token))) return true;
  }

  return false;
}

export async function requireAuth(
  request: Request,
  token: string,
  allowQuery = false,
): Promise<void> {
  if (await isAuthorizedRequest(request, token, allowQuery)) return;
  throw new ScottyError("auth", "Authentication required", {
    httpStatus: 401,
    exitCode: 4,
    hint: "Run scotty init or provide --token/SCOTTY_TOKEN",
  });
}

export function setAuthCookie<T extends AuthBindings>(c: Context<{ Bindings: T }>): void {
  setCookie(c, AUTH_COOKIE, c.env.SCOTTY_TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export function contextHasAuthCookie(c: Context): boolean {
  return Boolean(getCookie(c, AUTH_COOKIE));
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0 && left.length === right.length;
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
