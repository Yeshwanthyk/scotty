import { ContainerProxy, getSandbox } from "@cloudflare/sandbox";
import { Hono } from "hono";
import qrcode from "qrcode-generator";
import type { Bindings } from "./bindings";
import {
  badRequest,
  decodeJsonValue,
  isRecord,
  parseAuthClientId,
  parseCreateInput,
  parseIdempotencyKey,
  parseSessionId,
  ScottyError,
  type CreateSessionInput,
} from "./contracts";
import type { CreateIdempotencyMetadata } from "./create-idempotency";
import { Effect, Layer, Option, Predicate, Result, Schema } from "effect";
import { constantTimeStringEqual, sha256Hex } from "./digest";
import {
  authRegistry,
  browserLabel,
  clearClientAuthCookie,
  type AuthPrincipal,
  type AuthVariables,
  refreshClientAuthCookie,
  requestClientCredential,
  requireAuthRequest,
  requireAuthScope,
  requireClientCookieRequest,
  requireClientCredential,
  requireOwnerPrincipal,
  setClientAuthCookie,
  unwrapAuthRpc,
} from "./auth";
import { ScottyAuthRegistry } from "./auth-object";
import {
  kvSessionProjectionStorage,
  listSessionProjections,
  sessionProjectionLayer,
} from "./session-projection";
import {
  kvRepoProjectionStorage,
  listRepoProjections,
  repoProjectionLayer,
  trackRepoBestEffort,
} from "./repo-projection";
import {
  RunnerControlActionSchema,
  type RunnerControlAction,
  type RunnerControlStatus,
} from "./runner-control";
import { Sandbox as ScottySandbox } from "./session";

export { ContainerProxy, ScottyAuthRegistry, ScottySandbox };

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
const PUBLIC_AUTH_MUTATIONS = new Set([
  "POST /api/auth/owner-transfers/accept",
  "POST /api/auth/pairings/consume",
  "POST /api/auth/recovery-grants/consume",
]);

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

app.use("/api/auth/*", async (c, next) => {
  try {
    await next();
  } finally {
    c.header("cache-control", "no-store");
  }
});

app.use("*", async (c, next) => {
  if (new URL(c.req.url).searchParams.has("t")) c.header("cache-control", "no-store");
  rejectRootQuery(c.req.raw);
  await next();
});

app.get("/api/runners/:name/connect", async (c) => {
  const name = c.req.param("name");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(name) ||
    !c.env.SCOTTY_RUNNER_NAME ||
    name !== c.env.SCOTTY_RUNNER_NAME
  )
    return c.json({ error: { code: "not_found", message: "Runner not found" } }, 404);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    return c.json(
      {
        error: {
          code: "upgrade_required",
          message: "Runner connection requires a WebSocket upgrade",
        },
      },
      426,
    );
  const authorization = c.req.header("authorization");
  if (
    !c.env.SCOTTY_RUNNER_TOKEN ||
    !authorization?.startsWith("Bearer ") ||
    !(await constantTimeStringEqual(authorization.slice(7), c.env.SCOTTY_RUNNER_TOKEN))
  )
    return c.json({ error: { code: "auth", message: "Runner authorization failed" } }, 401);

  const headers = new Headers();
  for (const name of [
    "connection",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
    "upgrade",
  ]) {
    const value = c.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  return c.env.RUNNERS.getByName(name).fetch(new Request(c.req.url, { method: "GET", headers }));
});

app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  if (PUBLIC_AUTH_MUTATIONS.has(`${c.req.method} ${url.pathname}`)) {
    await next();
    return;
  }

  const principal: AuthPrincipal = await requireAuthRequest(c.req.raw, c.env);
  c.set("auth", principal);
  refreshClientAuthCookie(c, principal);
  if (isUnsafeMethod(c.req.method) && principal.kind === "client")
    requireCookieMutationSecurity(c.req.raw);
  await next();
});

app.post("/api/auth/pairings/consume", async (c) => {
  requirePublicMutationSecurity(c.req.raw);
  const input = parsePairingConsumeInput(await readJsonBody(c.req.raw));
  const issued = unwrapAuthRpc(
    await authRegistry(c.env).consumePairing(input.token, input.label, c.req.header("user-agent")),
  );
  setClientAuthCookie(c, issued);
  return c.json({ client: issued.client });
});

app.get("/api/auth/me", (c) => {
  const principal = c.get("auth");
  return c.json({
    kind: principal.kind,
    scopes: principal.scopes,
    ...(principal.kind === "client" ? { client: principal.client } : {}),
  });
});

app.post("/api/auth/pairings", async (c) => {
  const owner = requireOwnerPrincipal(c.get("auth"));
  requireJsonContentType(c.req.raw);
  const input = parsePairingIssueInput(await readOptionalJsonBody(c.req.raw));
  const pairing = unwrapAuthRpc(
    await authRegistry(c.env).issuePairing(requireClientCredential(owner), input.label),
  );
  const pairingUrl = `${new URL(c.req.url).origin}/pair#token=${encodeURIComponent(
    pairing.credential,
  )}`;
  return c.json({
    id: pairing.id,
    url: pairingUrl,
    expiresAt: pairing.expiresAt,
    qr: qrMatrix(pairingUrl),
  });
});

app.get("/api/auth/clients", async (c) => {
  const owner = requireOwnerPrincipal(c.get("auth"));
  return c.json(
    unwrapAuthRpc(await authRegistry(c.env).listClients(requireClientCredential(owner))),
  );
});

app.delete("/api/auth/clients/:id", async (c) => {
  const owner = requireOwnerPrincipal(c.get("auth"));
  const clientId = parseAuthClientId(c.req.param("id"));
  unwrapAuthRpc(await authRegistry(c.env).revokeClient(requireClientCredential(owner), clientId));
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const credential = requireClientCredential(c.get("auth"));
  unwrapAuthRpc(await authRegistry(c.env).logoutClient(credential));
  clearClientAuthCookie(c);
  return c.json({ ok: true });
});

app.post("/api/auth/owner-transfers", async (c) => {
  const owner = requireOwnerPrincipal(c.get("auth"));
  requireJsonContentType(c.req.raw);
  const input = parseOwnerTransferInput(await readJsonBody(c.req.raw));
  const idempotencyKey = c.req.header("idempotency-key");
  if (idempotencyKey !== undefined) parseIdempotencyKey(idempotencyKey);
  const issued = unwrapAuthRpc(
    await authRegistry(c.env).startOwnerTransfer(
      requireClientCredential(owner),
      input.targetClientId,
      idempotencyKey,
    ),
  );
  const transferUrl = `${new URL(c.req.url).origin}/owner-transfer#token=${encodeURIComponent(
    issued.credential,
  )}`;
  return c.json({
    ...issued.transfer,
    url: transferUrl,
    qr: qrMatrix(transferUrl),
  });
});

app.get("/api/auth/owner-transfers/current", async (c) => {
  const owner = requireOwnerPrincipal(c.get("auth"));
  return c.json(
    unwrapAuthRpc(await authRegistry(c.env).currentOwnerTransfer(requireClientCredential(owner))),
  );
});

app.delete("/api/auth/owner-transfers/:id", async (c) => {
  const owner = requireOwnerPrincipal(c.get("auth"));
  const transferId = parseAuthClientId(c.req.param("id"));
  unwrapAuthRpc(
    await authRegistry(c.env).cancelOwnerTransfer(requireClientCredential(owner), transferId),
  );
  return c.json({ ok: true });
});

app.post("/api/auth/owner-transfers/accept", async (c) => {
  requirePublicMutationSecurity(c.req.raw);
  const input = parseGrantConsumeInput(
    await readJsonBody(c.req.raw),
    "Owner transfer request is invalid",
  );
  const targetCredential = requestClientCredential(c.req.raw);
  if (!targetCredential)
    throw new ScottyError("auth", "Owner transfer is invalid or expired", {
      httpStatus: 401,
      exitCode: 4,
    });
  const issued = unwrapAuthRpc(
    await authRegistry(c.env).acceptOwnerTransfer(targetCredential, input.token),
  );
  setClientAuthCookie(c, issued);
  return c.json({ client: issued.client });
});

app.post("/api/auth/recovery-grants", async (c) => {
  const principal = c.get("auth");
  if (principal.kind !== "root")
    throw new ScottyError("auth", "Recovery authorization failed", {
      httpStatus: 401,
      exitCode: 4,
    });
  const rootCredential = bearerCredential(c.req.raw);
  const idempotencyKey = c.req.header("idempotency-key");
  if (idempotencyKey !== undefined) parseIdempotencyKey(idempotencyKey);
  const issued = unwrapAuthRpc(
    await authRegistry(c.env).issueRecoveryGrant(rootCredential, idempotencyKey),
  );
  const recoveryUrl = `${new URL(c.req.url).origin}/recover#token=${encodeURIComponent(
    issued.credential,
  )}`;
  return c.json({ url: recoveryUrl, expiresAt: issued.expiresAt });
});

app.post("/api/auth/recovery-grants/consume", async (c) => {
  requirePublicMutationSecurity(c.req.raw);
  const input = parseGrantConsumeInput(
    await readJsonBody(c.req.raw),
    "Recovery request is invalid",
  );
  const issued = unwrapAuthRpc(
    await authRegistry(c.env).consumeRecoveryGrant(
      input.token,
      browserLabel(c.req.header("user-agent")),
      c.req.header("user-agent"),
    ),
  );
  setClientAuthCookie(c, issued);
  return c.json({ client: issued.client });
});

app.get("/api/providers", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const runners = await configuredRunnerStatuses(c.env);
  const runnerAvailable = runners.some(
    (runner) => runner.desired === "accepting" && runner.connection === "connected",
  );
  return c.json([
    { name: "cloudflare" as const, status: "configured" as const },
    {
      name: "runner" as const,
      status: runnerAvailable ? ("available" as const) : ("unavailable" as const),
    },
  ]);
});

app.get("/api/runners", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  return c.json(await configuredRunnerStatuses(c.env));
});

app.post("/api/runners/:name/:action", async (c) => {
  requireOwnerPrincipal(c.get("auth"));
  const name = requireConfiguredRunnerName(c.env, c.req.param("name"));
  const action = parseRunnerControlAction(c.req.param("action"));
  const runner = c.env.RUNNERS.getByName(name);
  await runner.control(action);
  return c.json(runnerStatus(name, await runner.controlStatus()));
});

app.post("/api/sessions", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  requireJsonContentType(c.req.raw);
  const body: unknown = await c.req.json().catch(() => {
    throw badRequest("Request body must be valid JSON");
  });
  const input = parseCreateInput(body);
  if (input.provider === "runner") {
    const name = requireConfiguredRunnerName(c.env, input.runner ?? "");
    const status = await c.env.RUNNERS.getByName(name).controlStatus();
    if (status.desired !== "accepting" || status.connection !== "connected")
      throw new ScottyError("upstream", "Runner is unavailable", {
        httpStatus: 502,
        exitCode: 1,
      });
  }
  const { id, session } = await createTrackedSession(c.env, c.req.header("idempotency-key"), input);
  const origin = new URL(c.req.url).origin;
  return c.json({
    id,
    url: `${origin}/s/${id}`,
    branch: session.branch,
    provider: session.provider,
    ...(session.runner === undefined ? {} : { runner: session.runner }),
    status: session.status,
  });
});

app.get("/api/repos", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const result = await Effect.runPromise(
    listRepoProjections.pipe(Effect.provide(projectionLayers(c.env)), Effect.scoped, Effect.result),
  );
  return c.json(
    Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (repositories) => repositories,
    }),
  );
});

app.get("/api/sessions", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const result = await Effect.runPromise(
    listSessionProjections.pipe(
      Effect.provide(projectionLayers(c.env)),
      Effect.scoped,
      Effect.result,
    ),
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
  requireAuthScope(c.get("auth"), "sessions:read");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).getScottySession());
});

app.post("/api/sessions/:id/snapshot", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).snapshotScottySession());
});

app.post("/api/sessions/:id/sleep", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).sleepScottySession());
});

app.post("/api/sessions/:id/resume", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).resumeScottySession());
});

app.get("/api/sessions/:id/down", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const id = parseSessionId(c.req.param("id"));
  const sandbox = sessionSandbox(c.env, id);
  const archive = await sandbox.prepareDownArchive();
  const stream = await sandbox.readScottyArchiveStream(archive.path);
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
  requireAuthScope(c.get("auth"), "sessions:write");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).vaporizeScottySession());
});

app.all("/s/:id", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  return proxyPicanRequest(c.env, c.req.raw, id);
});

app.all("/s/:id/*", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  return proxyPicanRequest(c.env, c.req.raw, id);
});

app.get("/sessions", async (c) => {
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  return secureAsset(c.env, c.req.raw, "/sessions.html");
});

app.get("/devices", async (c) => {
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  requireOwnerPrincipal(principal);
  refreshClientAuthCookie(c, principal);
  return authAsset(c.env, c.req.raw, "/devices.html");
});

app.get("/providers", async (c) => {
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  requireOwnerPrincipal(principal);
  refreshClientAuthCookie(c, principal);
  return authAsset(c.env, c.req.raw, "/providers.html");
});

app.get("/pair", (c) => authAsset(c.env, c.req.raw, "/pair.html"));
app.get("/owner-transfer", (c) => authAsset(c.env, c.req.raw, "/owner-transfer.html"));
app.get("/recover", (c) => authAsset(c.env, c.req.raw, "/recover.html"));

app.get("/", (c) => c.redirect("/sessions", 302));

app.get("/health", (c) => c.json({ ok: true }));

app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

const PairingConsumeInputSchema = Schema.Struct({
  token: Schema.NonEmptyString,
  label: Schema.optionalKey(Schema.NonEmptyString),
});
const PairingIssueInputSchema = Schema.Struct({
  label: Schema.optionalKey(Schema.NonEmptyString),
});
const OwnerTransferInputSchema = Schema.Struct({
  targetClientId: Schema.NonEmptyString,
});
const GrantConsumeInputSchema = Schema.Struct({
  token: Schema.NonEmptyString,
});
const decodePairingConsumeInput = Schema.decodeUnknownOption(PairingConsumeInputSchema, {
  onExcessProperty: "error",
});
const decodePairingIssueInput = Schema.decodeUnknownOption(PairingIssueInputSchema, {
  onExcessProperty: "error",
});
const decodeOwnerTransferInput = Schema.decodeUnknownOption(OwnerTransferInputSchema, {
  onExcessProperty: "error",
});
const decodeGrantConsumeInput = Schema.decodeUnknownOption(GrantConsumeInputSchema, {
  onExcessProperty: "error",
});
const decodeRunnerControlAction = Schema.decodeUnknownOption(RunnerControlActionSchema);

function parsePairingConsumeInput(value: unknown): {
  readonly token: string;
  readonly label: string;
} {
  const decoded = decodePairingConsumeInput(value);
  if (Option.isNone(decoded)) throw badRequest("Pairing request is invalid");
  return { token: decoded.value.token, label: decoded.value.label ?? "Paired browser" };
}

function parsePairingIssueInput(value: unknown): { readonly label?: string } {
  const decoded = decodePairingIssueInput(value);
  if (Option.isNone(decoded)) throw badRequest("Pairing request is invalid");
  return decoded.value;
}

function parseOwnerTransferInput(value: unknown): { readonly targetClientId: string } {
  const decoded = decodeOwnerTransferInput(value);
  if (Option.isNone(decoded)) throw badRequest("Owner transfer request is invalid");
  return { targetClientId: parseAuthClientId(decoded.value.targetClientId) };
}

function parseGrantConsumeInput(value: unknown, errorMessage: string): { readonly token: string } {
  const decoded = decodeGrantConsumeInput(value);
  if (Option.isNone(decoded)) throw badRequest(errorMessage);
  return decoded.value;
}

function parseRunnerControlAction(value: unknown): RunnerControlAction {
  const decoded = decodeRunnerControlAction(value);
  if (Option.isSome(decoded)) return decoded.value;
  throw new ScottyError("not_found", "Runner action not found", {
    httpStatus: 404,
    exitCode: 3,
  });
}

function requireConfiguredRunnerName(env: Bindings, value: string): string {
  if (env.SCOTTY_RUNNER_NAME && value === env.SCOTTY_RUNNER_NAME) return value;
  throw new ScottyError("not_found", "Runner not found", {
    httpStatus: 404,
    exitCode: 3,
  });
}

function runnerStatus(name: string, status: RunnerControlStatus) {
  return { name, ...status, assignedSessions: 0 };
}

async function configuredRunnerStatuses(env: Bindings) {
  const name = env.SCOTTY_RUNNER_NAME?.trim();
  if (!name) return [];
  return [runnerStatus(name, await env.RUNNERS.getByName(name).controlStatus())];
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  const decoded = decodeJsonValue(text);
  if (Option.isNone(decoded)) throw badRequest("Request body must be valid JSON");
  return decoded.value;
}

async function readOptionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  const decoded = decodeJsonValue(text);
  if (Option.isNone(decoded)) throw badRequest("Request body must be valid JSON");
  return decoded.value;
}

function requireSameOrigin(request: Request): void {
  const expected = new URL(request.url).origin;
  if (request.headers.get("origin") === expected) return;
  throw badRequest("Request must come from this Scotty origin");
}

function requireFetchMetadata(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === null || fetchSite === "same-origin") return;
  throw badRequest("Request must come from this Scotty origin");
}

function requireJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") return;
  throw badRequest("Request content type must be application/json");
}

function requireCookieMutationSecurity(request: Request): void {
  requireSameOrigin(request);
  requireFetchMetadata(request);
}

function requirePublicMutationSecurity(request: Request): void {
  requireCookieMutationSecurity(request);
  requireJsonContentType(request);
}

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function bearerCredential(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ") && authorization.length > 7)
    return authorization.slice(7);
  throw new ScottyError("auth", "Recovery authorization failed", {
    httpStatus: 401,
    exitCode: 4,
  });
}

function rejectRootQuery(request: Request): void {
  if (!new URL(request.url).searchParams.has("t")) return;
  throw new ScottyError("auth", "Root-token browser links are not supported", {
    httpStatus: 401,
    exitCode: 4,
    hint: "Run scotty owner recover to register a replacement primary device.",
  });
}

function qrMatrix(value: string): { readonly size: number; readonly rows: ReadonlyArray<string> } {
  const code = qrcode(0, "M");
  code.addData(value);
  code.make();
  const size = code.getModuleCount();
  return {
    size,
    rows: Array.from({ length: size }, (_, row) =>
      Array.from({ length: size }, (_, column) => (code.isDark(row, column) ? "1" : "0")).join(""),
    ),
  };
}

function sessionSandbox(env: Bindings, id: string): ScottySandbox {
  return getSandbox(env.SANDBOX, id, {
    sleepAfter: "60m",
    transport: "rpc",
    enableDefaultSession: false,
    normalizeId: true,
  });
}

async function createTrackedSession(
  env: Bindings,
  idempotencyKey: string | undefined,
  input: CreateSessionInput,
) {
  const idempotency = await createSessionIdempotency(idempotencyKey, input);
  const id = idempotency?.keyDigest.slice(0, 12) ?? createSessionId();
  const sandbox = sessionSandbox(env, id);
  const session = idempotency
    ? await sandbox.createScottySession(input, id, idempotency)
    : await sandbox.createScottySession(input, id);
  await Effect.runPromise(
    trackRepoBestEffort(session.repo, session.defaultBranch).pipe(
      Effect.provide(projectionLayers(env)),
      Effect.scoped,
    ),
  );
  return { id, session };
}

function projectionLayers(env: Bindings) {
  return Layer.merge(
    repoProjectionLayer(kvRepoProjectionStorage(env.SESSIONS)),
    sessionProjectionLayer(kvSessionProjectionStorage(env.SESSIONS)),
  );
}

function createSessionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function createSessionIdempotency(
  key: string | undefined,
  input: CreateSessionInput,
): Promise<CreateIdempotencyMetadata | undefined> {
  if (key === undefined) return undefined;
  parseIdempotencyKey(key);
  const [keyDigest, inputDigest] = await Promise.all([
    sha256Hex(key),
    sha256Hex(
      JSON.stringify(
        input.provider === "runner"
          ? [input.prompt, input.provider, input.runner, input.repo, input.hardCapSeconds]
          : [input.prompt, input.provider, input.repo, input.hardCapSeconds],
      ),
    ),
  ]);
  return { keyDigest, inputDigest };
}

function normalizeError(error: unknown): ScottyError {
  if (error instanceof ScottyError) return error;
  if (isRecord(error)) {
    const fields: Record<string, unknown> = error;
    const operation = fields.operation;
    const code = fields.code;
    const message = fields.message;
    const httpStatus = fields.httpStatus;
    const exitCode = fields.exitCode;
    const hint = fields.hint;
    const isSessionProjectionFailure = Predicate.isTagged(fields, "SessionProjectionFailure");
    const isRepoProjectionFailure = Predicate.isTagged(fields, "RepoProjectionFailure");
    if (isSessionProjectionFailure || isRepoProjectionFailure) {
      console.error("Projection failure", {
        tag: isSessionProjectionFailure ? "SessionProjectionFailure" : "RepoProjectionFailure",
        reason: typeof operation === "string" ? operation : "unknown",
      });
      return new ScottyError("internal", "Internal error", { httpStatus: 500, exitCode: 1 });
    }
    const isScottyError = Predicate.isTagged(fields, "ScottyError");
    if (
      (isScottyError || !Predicate.hasProperty(fields, "_tag")) &&
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
      typeof message === "string" &&
      typeof httpStatus === "number" &&
      typeof exitCode === "number"
    ) {
      return new ScottyError(code as ScottyError["code"], message, {
        httpStatus,
        exitCode: exitCode as ScottyError["exitCode"],
        hint: typeof hint === "string" ? hint : undefined,
      });
    }
  }
  console.error("Unhandled Worker error", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return new ScottyError("internal", "Internal error", { httpStatus: 500, exitCode: 1 });
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

async function authAsset(env: Bindings, request: Request, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(asset.body, { status: asset.status, headers });
}

async function proxyPicanRequest(
  env: Bindings,
  request: Request,
  sessionId: string,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
    return new Response("Pican WebSocket proxying is not supported", { status: 501 });

  const headers = sanitizePicanProxyHeaders(request.headers);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
  const init: RequestInit = {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    signal: request.signal,
  };
  if (body !== undefined) Reflect.set(init, "duplex", "half");
  return sessionSandbox(env, sessionId).fetchPican(new Request(request.url, init));
}

function sanitizePicanProxyHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of source.get("connection")?.split(",") ?? []) headers.delete(name.trim());
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("proxy-authorization");
  headers.delete("proxy-authenticate");
  headers.delete("x-pican-proxy-token");
  headers.delete("forwarded");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-port");
  headers.delete("via");
  headers.delete("keep-alive");
  headers.delete("te");
  headers.delete("trailer");
  headers.delete("transfer-encoding");
  headers.delete("upgrade");
  headers.delete("connection");
  return headers;
}
