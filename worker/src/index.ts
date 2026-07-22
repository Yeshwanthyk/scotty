import { ContainerProxy, getSandbox } from "@cloudflare/sandbox";
import { Hono } from "hono";
import type { Bindings } from "./bindings";
import {
  badRequest,
  isRecord,
  parseCreateInput,
  parsePrInput,
  parseSessionId,
  ScottyError,
} from "./contracts";
import { Effect, Result } from "effect";
import { requireAuth, setAuthCookie } from "./auth";
import {
  kvSessionProjectionStorage,
  listSessionProjections,
  sessionProjectionLayer,
} from "./session-projection";
import { Sandbox as ScottySandbox } from "./session";

export { ContainerProxy, ScottySandbox };

const app = new Hono<{ Bindings: Bindings }>();

app.onError((error, c) => {
  const normalized = normalizeError(error);
  return c.json(
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        hint: normalized.hint,
      },
    },
    normalized.httpStatus as 400 | 401 | 404 | 409 | 500 | 502,
  );
});

app.use("/api/*", async (c, next) => {
  const allowQuery = new URL(c.req.url).pathname.endsWith("/pty");
  await requireAuth(c.req.raw, c.env.SCOTTY_TOKEN, allowQuery);
  await next();
});

app.post("/api/sessions", async (c) => {
  const body: unknown = await c.req.json().catch(() => {
    throw badRequest("Request body must be valid JSON");
  });
  const input = parseCreateInput(body);
  const id = createSessionId();
  const sandbox = sessionSandbox(c.env, id);
  const session = await sandbox.createScottySession(input, id);
  const origin = new URL(c.req.url).origin;
  return c.json({
    id,
    url: `${origin}/s/${id}?t=${encodeURIComponent(c.env.SCOTTY_TOKEN)}`,
    branch: session.branch,
    status: session.status,
  });
});

app.get("/api/sessions", async (c) => {
  const layer = sessionProjectionLayer(kvSessionProjectionStorage(c.env.SESSIONS));
  const result = await Effect.runPromise(
    listSessionProjections.pipe(Effect.provide(layer), Effect.scoped, Effect.result),
  );
  return c.json(
    Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (sessions) => sessions,
    }),
  );
});

app.get("/api/sessions/:id", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).getScottySession());
});

app.post("/api/sessions/:id/snapshot", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).snapshotScottySession());
});

app.post("/api/sessions/:id/sleep", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).sleepScottySession());
});

app.post("/api/sessions/:id/resume", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).resumeScottySession());
});

app.post("/api/sessions/:id/pr", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  const body: unknown = await c.req.json().catch(() => ({}));
  return c.json(await sessionSandbox(c.env, id).publishScottySession(parsePrInput(body)));
});

app.get("/api/sessions/:id/down", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  const sandbox = sessionSandbox(c.env, id);
  const archive = await sandbox.prepareDownArchive();
  const stream = await sandbox.readFileStream(archive.path);
  return new Response(stream, {
    headers: {
      "content-type": "application/x-tar",
      "content-disposition": `attachment; filename="${archive.filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

app.delete("/api/sessions/:id", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).vaporizeScottySession());
});

app.get("/api/sessions/:id/pty", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  const clientId = parseTerminalClientId(c.req.query("client"));
  const sandbox = sessionSandbox(c.env, id);
  const status = await sandbox.getScottySession();
  if (status.status !== "warm") {
    throw new ScottyError("wrong_state", `Session is ${status.status}`, {
      httpStatus: 409,
      exitCode: 5,
      hint: status.status === "sleeping" ? "Resume the session before attaching" : undefined,
    });
  }
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  const cols = positiveInteger(c.req.query("cols"), 80);
  const rows = positiveInteger(c.req.query("rows"), 24);
  const terminalSessionId = await sandbox.prepareTerminalAttachment(clientId);
  try {
    const terminalSession = await sandbox.getSession(terminalSessionId);
    const response = await terminalSession.terminal(c.req.raw, {
      cols,
      rows,
      shell: "/usr/local/bin/scotty-attach",
    });
    return bridgeTerminalWebSocket(
      response,
      () => sandbox.releaseTerminalAttachment(clientId),
      (task) => c.executionCtx.waitUntil(task),
    );
  } catch (error) {
    await sandbox.releaseTerminalAttachment(clientId).catch(() => undefined);
    throw error;
  }
});

app.delete("/api/sessions/:id/pty/:client", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  const clientId = parseTerminalClientId(c.req.param("client"));
  await sessionSandbox(c.env, id).releaseTerminalAttachment(clientId);
  return c.json({ ok: true });
});

app.post("/api/sessions/:id/pty/:client/heartbeat", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  const clientId = parseTerminalClientId(c.req.param("client"));
  await sessionSandbox(c.env, id).touchTerminalAttachment(clientId);
  return c.json({ ok: true });
});

app.get("/s/:id", async (c) => {
  parseSessionId(c.req.param("id"));
  const url = new URL(c.req.url);
  await requireAuth(c.req.raw, c.env.SCOTTY_TOKEN, true);
  if (url.searchParams.has("t")) {
    setAuthCookie(c);
    url.searchParams.delete("t");
    return c.redirect(`${url.pathname}${url.search}`, 302);
  }
  return terminalAsset(c.env, c.req.raw);
});

app.get("/sessions", async (c) => {
  await requireAuth(c.req.raw, c.env.SCOTTY_TOKEN, true);
  const url = new URL(c.req.url);
  if (url.searchParams.has("t")) {
    setAuthCookie(c);
    return c.redirect("/sessions", 302);
  }
  return secureAsset(c.env, c.req.raw, "/sessions.html");
});

app.get(
  "/terminal",
  () => new Response("Open a session with scotty attach ID or use its /s/ID URL.", { status: 404 }),
);

app.get("/health", (c) => c.json({ ok: true }));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

function sessionSandbox(env: Bindings, id: string): ScottySandbox {
  return getSandbox(env.SANDBOX, id, {
    sleepAfter: "60m",
    transport: "rpc",
    enableDefaultSession: false,
    normalizeId: true,
  });
}

function createSessionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000)
    throw badRequest("Invalid terminal dimensions");
  return parsed;
}

function parseTerminalClientId(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{12}$/u.test(value)) throw badRequest("Invalid terminal client id");
  return value;
}

function bridgeTerminalWebSocket(
  response: Response,
  cleanup: () => Promise<void>,
  waitUntil: (task: Promise<void>) => void,
): Response {
  const upstream = response.webSocket;
  if (!upstream)
    throw new ScottyError("upstream", "Terminal did not return a WebSocket", {
      httpStatus: 502,
      exitCode: 4,
    });
  const [client, server] = Object.values(new WebSocketPair());
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    waitUntil(cleanup().catch(() => undefined));
  };
  const closeCode = (code: number) => (code === 1005 || code === 1006 ? 1000 : code);

  upstream.accept();
  server.accept();
  server.addEventListener("message", async (event) => {
    try {
      upstream.send(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data);
    } catch {
      server.close(1011, "Terminal forwarding failed");
    }
  });
  upstream.addEventListener("message", async (event) => {
    try {
      server.send(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data);
    } catch {
      upstream.close(1011, "Terminal forwarding failed");
    }
  });
  server.addEventListener("close", (event) => {
    settle();
    upstream.close(closeCode(event.code), event.reason);
  });
  upstream.addEventListener("close", (event) => {
    settle();
    server.close(closeCode(event.code), event.reason);
  });
  server.addEventListener("error", () => {
    settle();
    upstream.close(1011, "Terminal client failed");
  });
  upstream.addEventListener("error", () => {
    settle();
    server.close(1011, "Terminal upstream failed");
  });

  return new Response(null, {
    status: response.status,
    headers: response.headers,
    webSocket: client,
  });
}

function normalizeError(error: unknown): ScottyError {
  if (error instanceof ScottyError) return error;
  if (isRecord(error)) {
    const code = error.code;
    const httpStatus = error.httpStatus;
    const exitCode = error.exitCode;
    if (
      typeof code === "string" &&
      [
        "bad_request",
        "auth",
        "not_found",
        "wrong_state",
        "conflict",
        "upstream",
        "internal",
      ].includes(code) &&
      typeof error.message === "string" &&
      typeof httpStatus === "number" &&
      typeof exitCode === "number"
    ) {
      return new ScottyError(code as ScottyError["code"], error.message, {
        httpStatus,
        exitCode: exitCode as ScottyError["exitCode"],
        hint: typeof error.hint === "string" ? error.hint : undefined,
      });
    }
  }
  console.error("Unhandled Worker error", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return new ScottyError("internal", "Internal error", { httpStatus: 500, exitCode: 1 });
}

async function terminalAsset(env: Bindings, request: Request): Promise<Response> {
  return secureAsset(env, request, "/terminal.html");
}

async function secureAsset(env: Bindings, request: Request, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; font-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(asset.body, { status: asset.status, headers });
}
