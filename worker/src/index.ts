import { getSandbox } from "@cloudflare/sandbox";
import {
  decodePiConsoleCommandV1Promise,
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_PUBLIC_PATH_SEGMENT,
  PI_CONSOLE_PROXY_PREFIX,
} from "../../protocol/pi-console";
import {
  InstallationPiAuthRecordSchema,
  digestPiAuthProviders,
  parsePiAuthJsonOption,
  piProviderMetadata,
} from "../../protocol/pi-auth";
import { Hono } from "hono";
import qrcode from "qrcode-generator";
import type { Bindings } from "./bindings";
import { readBoundedBytes, readBoundedUtf8Body } from "./bounded-http";
import { ArtifactStore, artifactStoreLayer, r2ArtifactStoreCapabilities } from "./artifact-store";
import { decodeEvidenceIdentifier, evidenceShowcaseProjection } from "./evidence-contracts";
import { handleEvidencePreviewRequest } from "./evidence-preview";
import { handleHatchRequest, hatchPreviewFormAction } from "./hatch-gateway";
import { hatchOrigin } from "./hatch-contracts";
import { ContainerProxy } from "./container-session-egress";
import {
  badRequest,
  conflict,
  decodeJsonValue,
  ApiErrorCodeSchema,
  parseAuthClientId,
  parseCreateInput,
  parseIdempotencyKey,
  parseRenameSessionInput,
  parseRepo,
  parseSessionId,
  parseSteerInput,
  ScottyError,
  wrongState,
  type CreateSessionInput,
} from "./contracts";
import type { CreateIdempotencyMetadata } from "./create-idempotency";
import { Effect, Layer, Option, Predicate, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { sha256Hex } from "./digest";
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
  forgetRepoProjection,
  kvRepoProjectionStorage,
  projectRepoEntryBestEffort,
  rebuildRepoProjection,
  repoProjectionMatches,
  repoProjectionLayer,
} from "./repo-projection";
import {
  decodeRepositoryRegistryRequest,
  isRepositoryIdentity,
  type RepositoryRegistryEntry,
} from "../../protocol/repository";
import { RepoVerifier, repoVerifierLayer } from "./repo-verifier";
import {
  kvStatsProjectionStorage,
  readStats,
  recordWorkspaceCreation,
  statsProjectionLayer,
} from "./stats-projection";
import {
  RunnerControlActionSchema,
  type RunnerControlAction,
  type RunnerControlStatus,
} from "./runner-control";
import {
  ScottyRunnerRegistry,
  type RunnerRegistryRpcResult,
  type ScottyRunnerRegistryStub,
} from "./runner-registry-object";
import { validateSandboxArchive } from "./sandbox-archive";
import {
  SandboxBundleStore,
  SANDBOX_BUNDLE_MAX_GZIP_BYTES,
  sandboxBundleStoreLayer,
  r2SandboxBundleCapabilities,
} from "./sandbox-bundle-store";
import {
  ScottySandboxConfig,
  SANDBOX_CONFIG_OBJECT_NAME,
  type SandboxConfigRpcResult,
  type ScottySandboxConfigStub,
} from "./sandbox-config-object";
import { inspectPassiveSession, steerPassiveSession } from "./passive-session";
import {
  EnvironmentPolicyKeyInputSchema,
  EnvironmentPutInputSchema,
  type ProtectedEnvironmentBinding,
} from "./environment-contracts";
import { Sandbox as ScottySandbox } from "./session";

export {
  ContainerProxy,
  ScottyAuthRegistry,
  ScottyRunnerRegistry,
  ScottySandbox,
  ScottySandboxConfig,
};

export const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
const PUBLIC_AUTH_MUTATIONS = new Set([
  "POST /api/auth/owner-transfers/accept",
  "POST /api/auth/pairings/consume",
  "POST /api/auth/recovery-grants/consume",
]);
const ASSIGNED_RUNNER_SESSION_STATUSES = new Set(["booting", "warm", "sleeping", "failed"]);
const RUNNER_REGISTRY_OBJECT_NAME = "account";
const SANDBOX_BUNDLE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const RUNNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const RunnerRegistrationInputSchema = Schema.Struct({
  name: Schema.String,
  replace: Schema.optionalKey(Schema.Boolean),
});
const decodeRunnerRegistrationInput = Schema.decodeUnknownOption(RunnerRegistrationInputSchema, {
  onExcessProperty: "error",
});
const decodeInstallationPiAuthRecord = Schema.decodeUnknownOption(InstallationPiAuthRecordSchema, {
  onExcessProperty: "error",
});
const decodeEnvironmentPutInput = Schema.decodeUnknownOption(EnvironmentPutInputSchema, {
  onExcessProperty: "error",
});
const decodeEnvironmentPolicyKeyInput = Schema.decodeUnknownOption(
  EnvironmentPolicyKeyInputSchema,
  { onExcessProperty: "error" },
);
const PROTECTED_ENVIRONMENT_BINDINGS: ReadonlyArray<ProtectedEnvironmentBinding> = [
  {
    name: "GH_TOKEN",
    secret: true,
    source: "session-bound GitHub sentinel",
    destination: "process_environment",
    managedBy: "scotty",
  },
  {
    name: "GITHUB_SENTINEL",
    secret: true,
    source: "session-bound GitHub sentinel",
    destination: "process_environment",
    managedBy: "scotty",
  },
  {
    name: "Pi provider credentials",
    secret: true,
    source: "session credential vault sentinels",
    destination: "file",
    path: "$PI_CODING_AGENT_DIR/auth.json",
    managedBy: "scotty",
  },
  {
    name: "Pi session transport credential",
    secret: true,
    source: "session-derived transport token",
    destination: "file",
    path: "$PI_CODING_AGENT_DIR/scotty-pi-session.token",
    managedBy: "scotty",
  },
];
const WorkerErrorSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  operation: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(ApiErrorCodeSchema),
  message: Schema.optionalKey(Schema.String),
  httpStatus: Schema.optionalKey(Schema.Number),
  exitCode: Schema.optionalKey(Schema.Literals([1, 2, 3, 4, 5])),
  hint: Schema.optionalKey(Schema.String),
});
const decodeWorkerError = Schema.decodeUnknownOption(WorkerErrorSchema);
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
  const incomingUrl = new URL(c.req.url);
  if (incomingUrl.searchParams.has("t")) c.header("cache-control", "no-store");
  else if (/^\/(?:api\/sessions|s)\/[^/]+\/(?:evidence|hatch)(?:\/|$)/u.test(incomingUrl.pathname))
    c.header("cache-control", "private, no-store");
  rejectRootQuery(c.req.raw);
  await next();
});

app.get("/api/runners/:name/connect", async (c) => {
  const name = c.req.param("name");
  if (!RUNNER_NAME_PATTERN.test(name))
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
  if (!authorization?.startsWith("Bearer "))
    return c.json({ error: { code: "auth", message: "Runner authorization failed" } }, 401);
  const authenticated = await runnerRegistry(c.env).authenticate(name, authorization.slice(7));
  if (!authenticated.ok) {
    if (authenticated.error.reason === "runner_missing")
      return c.json({ error: { code: "not_found", message: "Runner not found" } }, 404);
    if (
      authenticated.error.reason === "credential_invalid" ||
      authenticated.error.reason === "invalid_input"
    )
      return c.json({ error: { code: "auth", message: "Runner authorization failed" } }, 401);
    unwrapRunnerRegistryRpc(authenticated);
  }

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

app.get("/api/sessions/:id/evidence", async (c) => {
  const principal = await requireEvidenceBrowser(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).listScottyEvidence());
});

app.get("/api/sessions/:id/evidence/:jobId", async (c) => {
  const principal = await requireEvidenceBrowser(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const id = parseSessionId(c.req.param("id"));
  const jobId = parseEvidenceIdentifier(c.req.param("jobId"));
  return c.json(await sessionSandbox(c.env, id).getScottyEvidence(jobId));
});

app.get("/api/sessions/:id/showcase/:beforeJobId/:afterJobId", async (c) => {
  const principal = await requireEvidenceBrowser(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const id = parseSessionId(c.req.param("id"));
  const beforeJobId = parseEvidenceIdentifier(c.req.param("beforeJobId"));
  const afterJobId = parseEvidenceIdentifier(c.req.param("afterJobId"));
  const sandbox = sessionSandbox(c.env, id);
  const [before, after] = await Promise.all([
    sandbox.getScottyEvidence(beforeJobId),
    sandbox.getScottyEvidence(afterJobId),
  ]);
  const showcase = evidenceShowcaseProjection(id, before, after);
  if (showcase === undefined)
    throw wrongState("warm", "evidence", "Evidence runs do not form a matched Showcase");
  return c.json(showcase);
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

app.get("/api/auth/pi", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const authority = unwrapSandboxConfigRpc(await sandboxConfig(c.env).piAuth());
  if (authority !== null)
    return c.json({
      source: authority.source,
      sourceDigest: authority.digest,
      updatedAt: authority.updatedAt,
      providers: piProviderMetadata(authority.providers),
    });
  const providers = parsePiAuthJsonOption(c.env.PI_AUTH_JSON);
  if (Option.isNone(providers))
    throw new ScottyError("internal", "PI_AUTH_JSON is missing or invalid", {
      httpStatus: 500,
      exitCode: 1,
    });
  return c.json({
    source: "bootstrap" as const,
    sourceDigest: await digestPiAuthProviders(providers.value),
    updatedAt: null,
    providers: piProviderMetadata(providers.value),
  });
});

app.post("/api/auth/pi", async (c) => {
  requireRootPrincipal(c.get("auth"));
  requireJsonContentType(c.req.raw);
  const decoded = decodeInstallationPiAuthRecord(await readJsonBody(c.req.raw));
  if (Option.isNone(decoded)) throw badRequest("Pi credential record is invalid");
  if (decoded.value.source !== "sync") throw badRequest("Pi credential record source is invalid");
  const authority = unwrapSandboxConfigRpc(await sandboxConfig(c.env).writePiAuth(decoded.value));
  return c.json({
    source: authority.source,
    sourceDigest: authority.digest,
    updatedAt: authority.updatedAt,
    providers: piProviderMetadata(authority.providers),
  });
});

app.get("/api/environment/approvals", async (c) => {
  requireEnvironmentManager(c.get("auth"));
  const repo = c.req.query("repo");
  if (repo !== undefined && !isRepositoryIdentity(repo))
    throw badRequest("repo must be OWNER/NAME");
  const config = sandboxConfig(c.env);
  if (config.listEnvironmentApprovals === undefined)
    throw new ScottyError("internal", "Environment approvals are unavailable", {
      httpStatus: 500,
      exitCode: 1,
    });
  return c.json(unwrapSandboxConfigRpc(await config.listEnvironmentApprovals(repo)));
});

app.post("/api/environment/approvals/approve", async (c) => {
  requireEnvironmentManager(c.get("auth"));
  requireJsonContentType(c.req.raw);
  const input = parseEnvironmentPolicyKeyInput(await readJsonBody(c.req.raw));
  const config = sandboxConfig(c.env);
  if (config.approveEnvironment === undefined)
    throw new ScottyError("internal", "Environment approvals are unavailable", {
      httpStatus: 500,
      exitCode: 1,
    });
  return c.json(unwrapSandboxConfigRpc(await config.approveEnvironment(input)));
});

app.post("/api/environment/approvals/reject", async (c) => {
  requireEnvironmentManager(c.get("auth"));
  requireJsonContentType(c.req.raw);
  const input = parseEnvironmentPolicyKeyInput(await readJsonBody(c.req.raw));
  const config = sandboxConfig(c.env);
  if (config.rejectEnvironment === undefined)
    throw new ScottyError("internal", "Environment approvals are unavailable", {
      httpStatus: 500,
      exitCode: 1,
    });
  return c.json(unwrapSandboxConfigRpc(await config.rejectEnvironment(input)));
});

app.post("/api/environment/approvals/revoke", async (c) => {
  requireEnvironmentManager(c.get("auth"));
  requireJsonContentType(c.req.raw);
  const input = parseEnvironmentPolicyKeyInput(await readJsonBody(c.req.raw));
  const config = sandboxConfig(c.env);
  if (config.revokeEnvironment === undefined)
    throw new ScottyError("internal", "Environment approvals are unavailable", {
      httpStatus: 500,
      exitCode: 1,
    });
  return c.json(unwrapSandboxConfigRpc(await config.revokeEnvironment(input)));
});
app.get("/api/environment", async (c) => {
  requireEnvironmentManager(c.get("auth"));
  const repo = c.req.query("repo");
  if (repo !== undefined && !isRepositoryIdentity(repo))
    throw badRequest("repo must be OWNER/NAME");
  const environment = unwrapSandboxConfigRpc(await sandboxConfig(c.env).listEnvironment(repo));
  return c.json({ ...environment, protectedBindings: PROTECTED_ENVIRONMENT_BINDINGS });
});

app.put("/api/environment/:name", async (c) => {
  requireEnvironmentManager(c.get("auth"));
  requireJsonContentType(c.req.raw);
  const input = decodeEnvironmentPutInput(await readJsonBody(c.req.raw));
  if (Option.isNone(input)) throw badRequest("Environment variable input is invalid");
  const repo = c.req.query("repo");
  if (repo !== undefined && !isRepositoryIdentity(repo))
    throw badRequest("repo must be OWNER/NAME");
  return c.json(
    unwrapSandboxConfigRpc(
      await sandboxConfig(c.env).putEnvironment(c.req.param("name"), input.value, repo),
    ),
  );
});

app.delete("/api/environment/:name", async (c) => {
  requireEnvironmentManager(c.get("auth"));
  const repo = c.req.query("repo");
  if (repo !== undefined && !isRepositoryIdentity(repo))
    throw badRequest("repo must be OWNER/NAME");
  return c.json(
    unwrapSandboxConfigRpc(await sandboxConfig(c.env).removeEnvironment(c.req.param("name"), repo)),
  );
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

app.post("/api/runners", async (c) => {
  requireRootPrincipal(c.get("auth"));
  requireJsonContentType(c.req.raw);
  const decoded = decodeRunnerRegistrationInput(await readJsonBody(c.req.raw));
  if (Option.isNone(decoded) || !RUNNER_NAME_PATTERN.test(decoded.value.name))
    throw badRequest("Runner registration request is invalid");
  const issued = unwrapRunnerRegistryRpc(
    await runnerRegistry(c.env).register(decoded.value.name, decoded.value.replace ?? false),
  );
  if (issued.replaced) await c.env.RUNNERS.getByName(issued.runner.name).control("disconnect");
  return c.json({
    name: issued.runner.name,
    credential: issued.credential,
    replaced: issued.replaced,
    createdAt: issued.runner.createdAt,
    updatedAt: issued.runner.updatedAt,
  });
});

app.delete("/api/runners/:name", async (c) => {
  requireRootPrincipal(c.get("auth"));
  const name = await requireRegisteredRunnerName(c.env, c.req.param("name"));
  const assignedSessions = await assignedRunnerSessionCount(c.env, name);
  if (assignedSessions > 0)
    throw new ScottyError("conflict", "Runner still owns active sessions", {
      httpStatus: 409,
      exitCode: 5,
      hint: "Drain and vaporize or move every assigned session before removing this runner.",
    });
  const runner = c.env.RUNNERS.getByName(name);
  await runner.control("disable");
  await runner.control("disconnect");
  unwrapRunnerRegistryRpc(await runnerRegistry(c.env).remove(name));
  return c.json({ name, status: "removed" as const });
});

app.get("/api/sandbox/configuration", async (c) => {
  requireRootPrincipal(c.get("auth"));
  return c.json(unwrapSandboxConfigRpc(await sandboxConfig(c.env).status()));
});

app.put("/api/sandbox/bundles/:digest", async (c) => {
  requireRootPrincipal(c.get("auth"));
  const digest = c.req.param("digest");
  if (!SANDBOX_BUNDLE_DIGEST_PATTERN.test(digest))
    throw badRequest("Sandbox bundle digest is invalid");
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/gzip" && contentType !== "application/x-gzip")
    throw badRequest("Sandbox bundle content type must be application/gzip");
  const idempotencyKeyHeader = c.req.header("idempotency-key");
  if (idempotencyKeyHeader === undefined) throw badRequest("Idempotency-Key header is required");
  const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
  const ifMatchHeader = c.req.header("if-match");
  let expectedRevision: number | null = null;
  if (ifMatchHeader !== undefined) {
    const parsed = Number(ifMatchHeader);
    if (!Number.isInteger(parsed) || parsed < 0)
      throw badRequest("If-Match revision must be a non-negative integer");
    expectedRevision = parsed;
  }
  const gzipBytes = await readBoundedBytes(c.req.raw, SANDBOX_BUNDLE_MAX_GZIP_BYTES);
  if (gzipBytes === undefined) throw badRequest("Sandbox bundle body exceeds the size limit");
  const validated = await Effect.runPromise(
    validateSandboxArchive(gzipBytes, digest).pipe(Effect.result),
  );
  if (Result.isFailure(validated)) throw badRequest(validated.failure.message);
  await Effect.runPromise(
    Effect.flatMap(SandboxBundleStore, (store) =>
      store.putBundle({
        digest,
        gzipBytes,
        manifestJson: validated.success.manifestJson,
      }),
    ).pipe(
      Effect.provide(
        sandboxBundleStoreLayer(r2SandboxBundleCapabilities(c.env.SANDBOX_BUNDLE_BUCKET)),
      ),
      Effect.catchTag("SandboxBundleFailure", (error) =>
        Effect.fail(
          new ScottyError(
            error.reason === "metadata_mismatch" ? "internal" : "upstream",
            error.reason === "metadata_mismatch"
              ? "Sandbox bundle storage metadata mismatch"
              : "Sandbox bundle storage failed",
            { httpStatus: error.reason === "metadata_mismatch" ? 500 : 502, exitCode: 1 },
          ),
        ),
      ),
    ),
  );
  return c.json(
    unwrapSandboxConfigRpc(
      await sandboxConfig(c.env).activate({ digest, idempotencyKey, expectedRevision }),
    ),
  );
});

app.post("/api/runners/:name/:action", async (c) => {
  requireOwnerPrincipal(c.get("auth"));
  const name = await requireRegisteredRunnerName(c.env, c.req.param("name"));
  const action = parseRunnerControlAction(c.req.param("action"));
  const runner = c.env.RUNNERS.getByName(name);
  await runner.control(action);
  const [status, assignedSessions] = await Promise.all([
    runner.controlStatus(),
    assignedRunnerSessionCount(c.env, name),
  ]);
  return c.json(runnerStatus(name, status, assignedSessions));
});

app.post("/api/sessions", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  requireJsonContentType(c.req.raw);
  const body: unknown = await c.req.json().catch(() => {
    throw badRequest("Request body must be valid JSON");
  });
  const input = parseCreateInput(body);
  if (input.provider === "runner") {
    throw badRequest(
      "Runner-backed sessions require a native Pi transport and cannot be created yet",
    );
  }
  const { id, session } = await createTrackedSession(c.env, c.req.header("idempotency-key"), input);
  const origin = new URL(c.req.url).origin;
  return c.json({
    id,
    title: session.title,
    url: `${origin}/s/${id}`,
    branch: session.branch,
    provider: session.provider,
    ...(session.runner === undefined ? {} : { runner: session.runner }),
    status: session.status,
  });
});

app.get("/api/repos", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const repositories = unwrapSandboxConfigRpc(await sandboxConfig(c.env).listRepos());
  await repairRepoProjection(c.env, repositories);
  return c.json(repositories);
});

app.post("/api/repos", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  requireJsonContentType(c.req.raw);
  const decoded = decodeRepositoryRegistryRequest(await readJsonBody(c.req.raw));
  if (Option.isNone(decoded)) throw badRequest("repo must be OWNER/NAME");

  const verified = await verifyRepository(c.env, decoded.value.repo);
  if (!verified.exists)
    throw new ScottyError("not_found", `GitHub repository ${decoded.value.repo} was not found`, {
      httpStatus: 404,
      exitCode: 3,
    });

  const entry = unwrapSandboxConfigRpc(
    await sandboxConfig(c.env).addRepo({
      repo: decoded.value.repo,
      defaultBranch: verified.defaultBranch,
    }),
  );
  await Effect.runPromise(
    projectRepoEntryBestEffort(entry).pipe(Effect.provide(projectionLayers(c.env)), Effect.scoped),
  );
  return c.json(entry);
});

app.delete("/api/repos/:owner/:name", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  const repo = parseRepo(`${c.req.param("owner")}/${c.req.param("name")}`);
  const removed = unwrapSandboxConfigRpc(await sandboxConfig(c.env).removeRepo(repo));
  await Effect.runPromise(
    forgetRepoProjection(repo).pipe(Effect.provide(projectionLayers(c.env)), Effect.scoped),
  );
  // `forgotten` is the legacy browser acknowledgement; keep it while exposing
  // the authority's actual no-op/removal result to newer clients.
  return c.json({ repo, removed, forgotten: true });
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

app.get("/api/stats", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const result = await Effect.runPromise(
    readStats.pipe(Effect.provide(projectionLayers(c.env)), Effect.scoped, Effect.result),
  );
  return c.json(
    Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (stats) => stats,
    }),
  );
});

app.get("/api/sessions/:id", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).getScottySession());
});

app.get("/api/sessions/:id/environment", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).getScottyEnvironmentStatus());
});

app.post("/api/sessions/:id/environment/refresh", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).refreshScottyEnvironment());
});

app.get("/api/sessions/:id/hatch", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).getScottyHatchStatus());
});

app.post("/api/sessions/:id/hatch", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  requireJsonContentType(c.req.raw);
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).ensureScottyHatch(await readJsonBody(c.req.raw)));
});

app.delete("/api/sessions/:id/hatch", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).closeScottyHatch());
});

app.get("/api/sessions/:id/inspect", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:read");
  const id = parseSessionId(c.req.param("id"));
  return inspectPassiveSession(sessionSandbox(c.env, id));
});

app.post("/api/sessions/:id/steer", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  requireJsonContentType(c.req.raw);
  const id = parseSessionId(c.req.param("id"));
  const bodyText = await readBoundedUtf8Body(c.req.raw, PI_CONSOLE_MAX_COMMAND_BYTES);
  if (bodyText === undefined) throw badRequest("Steer request body is too large");
  const body = decodeJsonValue(bodyText);
  if (Option.isNone(body)) throw badRequest("Request body must be valid JSON");
  const message = parseSteerInput(body.value);
  return steerPassiveSession(sessionSandbox(c.env, id), id, message);
});

app.patch("/api/sessions/:id", async (c) => {
  requireAuthScope(c.get("auth"), "sessions:write");
  requireJsonContentType(c.req.raw);
  const id = parseSessionId(c.req.param("id"));
  const title = parseRenameSessionInput(await readJsonBody(c.req.raw));
  return c.json(await sessionSandbox(c.env, id).renameScottySession(title));
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

app.post("/api/sessions/:id/auth/reseed", async (c) => {
  const principal = c.get("auth");
  if (principal.kind !== "root") requireOwnerPrincipal(principal);
  const id = parseSessionId(c.req.param("id"));
  return c.json(await sessionSandbox(c.env, id).reseedPiAuth());
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

app.get("/s/:id/evidence", async (c) => {
  const principal = await requireEvidenceBrowser(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const id = parseSessionId(c.req.param("id"));
  await sessionSandbox(c.env, id).listScottyEvidence();
  return evidenceAsset(c.env, c.req.raw);
});

app.get("/s/:id/evidence/:jobId", async (c) => {
  const principal = await requireEvidenceBrowser(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const id = parseSessionId(c.req.param("id"));
  const jobId = parseEvidenceIdentifier(c.req.param("jobId"));
  await sessionSandbox(c.env, id).getScottyEvidence(jobId);
  return evidenceAsset(c.env, c.req.raw);
});

app.get("/s/:id/showcase/:beforeJobId/:afterJobId", async (c) => {
  const principal = await requireEvidenceBrowser(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const id = parseSessionId(c.req.param("id"));
  const beforeJobId = parseEvidenceIdentifier(c.req.param("beforeJobId"));
  const afterJobId = parseEvidenceIdentifier(c.req.param("afterJobId"));
  const sandbox = sessionSandbox(c.env, id);
  const [before, after] = await Promise.all([
    sandbox.getScottyEvidence(beforeJobId),
    sandbox.getScottyEvidence(afterJobId),
  ]);
  if (evidenceShowcaseProjection(id, before, after) === undefined)
    throw wrongState("warm", "evidence", "Evidence runs do not form a matched Showcase");
  return authAsset(c.env, c.req.raw, "/showcase.html");
});

app.get("/s/:id/evidence/:jobId/frames/:frame", async (c) => {
  const principal = await requireEvidenceBrowser(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const id = parseSessionId(c.req.param("id"));
  const jobId = parseEvidenceIdentifier(c.req.param("jobId"));
  const frame = c.req.param("frame");
  const frameId = parseEvidenceIdentifier(frame.endsWith(".png") ? frame.slice(0, -4) : "");
  const artifact = await sessionSandbox(c.env, id).getScottyEvidenceArtifact(jobId, frameId);
  const opened = await Effect.runPromise(
    Effect.flatMap(ArtifactStore, (store) => store.openFrame(artifact)).pipe(
      Effect.provide(artifactStoreLayer(r2ArtifactStoreCapabilities(c.env.ARTIFACT_BUCKET))),
      Effect.result,
    ),
  );
  return Result.match(opened, {
    onFailure: () => {
      throw new ScottyError("internal", "Evidence frame is unavailable", {
        httpStatus: 500,
        exitCode: 1,
      });
    },
    onSuccess: (frame) =>
      new Response(frame.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-length": String(frame.bytes),
          "content-type": frame.mediaType,
          "x-content-type-options": "nosniff",
        },
      }),
  });
});

app.get("/s/:id/evidence/:jobId/video.webm", async (c) => {
  const principal = await requireEvidenceBrowser(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const id = parseSessionId(c.req.param("id"));
  const jobId = parseEvidenceIdentifier(c.req.param("jobId"));
  const artifact = await sessionSandbox(c.env, id).getScottyEvidenceArtifact(jobId, "recording");
  if (artifact.mediaType !== "video/webm") throw badRequest("Evidence video is invalid");
  const opened = await Effect.runPromise(
    Effect.flatMap(ArtifactStore, (store) => store.openArtifact(artifact)).pipe(
      Effect.provide(artifactStoreLayer(r2ArtifactStoreCapabilities(c.env.ARTIFACT_BUCKET))),
      Effect.result,
    ),
  );
  return Result.match(opened, {
    onFailure: () => {
      throw new ScottyError("internal", "Evidence video is unavailable", {
        httpStatus: 500,
        exitCode: 1,
      });
    },
    onSuccess: (video) =>
      new Response(video.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-length": String(video.bytes),
          "content-type": video.mediaType,
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
        },
      }),
  });
});

app.get("/s/:id/hatch/open", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  requireAuthScope(principal, "sessions:read");
  refreshClientAuthCookie(c, principal);
  const previewBase = c.env.SCOTTY_PREVIEW_BASE;
  if (previewBase === undefined) throw wrongState("warm", "hatch", "Hatch routing is unavailable");
  const route = await sessionSandbox(c.env, id).getScottyHatchOpenRoute();
  if (route === undefined) throw wrongState("warm", "hatch", "Hatch is not open");
  const issued = unwrapAuthRpc(
    await authRegistry(c.env).issueHatchHandoff(
      requireClientCredential(principal),
      id,
      route.hatchId,
    ),
  );
  return hatchHandoffPage(hatchOrigin(route, previewBase), issued.credential);
});

app.all("/s/:id/terminal", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    return c.json(
      {
        error: {
          code: "upgrade_required",
          message: "Terminal connection requires a WebSocket upgrade",
        },
      },
      426,
    );
  requireSameOrigin(c.req.raw);
  const sandbox = sessionSandbox(c.env, id);
  await assertCloudflarePiAccess(sandbox);
  return c.json(
    {
      error: {
        code: "terminal_retired",
        message: "This session uses the Pi worklog instead of a terminal",
      },
    },
    410,
  );
});

app.all(`/s/:id/${PI_CONSOLE_PUBLIC_PATH_SEGMENT}/:action`, async (c) => {
  const id = parseSessionId(c.req.param("id"));
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  const action = c.req.param("action");
  const expectedMethod =
    action === "snapshot" || action === "events"
      ? "GET"
      : action === "command"
        ? "POST"
        : undefined;
  if (expectedMethod === undefined || c.req.method !== expectedMethod)
    return c.json({ error: { code: "not_found", message: "Route not found" } }, 404);
  if (c.req.method === "POST") {
    requireCookieMutationSecurity(c.req.raw);
    requireJsonContentType(c.req.raw);
  }

  const incomingUrl = new URL(c.req.url);
  const targetUrl = new URL(`http://scotty.internal${PI_CONSOLE_PROXY_PREFIX}/${action}`);
  targetUrl.search = incomingUrl.search;
  const headers = new Headers();
  for (const name of ["accept", "content-type", "last-event-id"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  let body: string | undefined;
  if (c.req.method === "POST") {
    const text = await readBoundedUtf8Body(c.req.raw, PI_CONSOLE_MAX_COMMAND_BYTES);
    if (text === undefined) throw badRequest("Console command body is too large");
    const json = decodeJsonValue(text);
    if (Option.isNone(json)) throw badRequest("Console command body must be valid JSON");
    const decoded = await decodePiConsoleCommandV1Promise(json.value).then(
      (value) => Result.succeed(value),
      () => Result.fail(undefined),
    );
    if (Result.isFailure(decoded)) throw badRequest("Invalid console command");
    body = JSON.stringify(decoded.success);
  }
  return sessionSandbox(c.env, id).fetch(
    new Request(targetUrl, {
      method: c.req.method,
      headers,
      body,
    }),
  );
});

app.all("/s/:id", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  return serveScottySessionPage(c.env, c.req.raw, id);
});

app.all("/s/:id/*", async (c) => {
  const id = parseSessionId(c.req.param("id"));
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  return serveScottySessionSubpath(c.env, c.req.raw, id);
});

app.get("/sessions", async (c) => {
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  return secureAsset(c.env, c.req.raw, "/sessions.html");
});

app.get("/stats", async (c) => {
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  refreshClientAuthCookie(c, principal);
  return secureAsset(c.env, c.req.raw, "/stats.html");
});

app.get("/devices", async (c) => {
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  requireOwnerPrincipal(principal);
  refreshClientAuthCookie(c, principal);
  return authAsset(c.env, c.req.raw, "/devices.html");
});

app.get("/environment", async (c) => {
  rejectRootQuery(c.req.raw);
  const principal = await requireClientCookieRequest(c.req.raw, c.env);
  requireEnvironmentManager(principal);
  refreshClientAuthCookie(c, principal);
  return authAsset(c.env, c.req.raw, "/environment.html");
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

export const workerFetch = async (
  request: Request,
  env: Bindings,
  executionContext: ExecutionContext,
): Promise<Response> => {
  const hatch = await handleHatchRequest(request, env);
  if (hatch !== null) return hatch;
  const preview = await handleEvidencePreviewRequest(request, env);
  return preview ?? app.fetch(request, env, executionContext);
};

export default { fetch: workerFetch };

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

function parseEnvironmentPolicyKeyInput(value: unknown) {
  const decoded = decodeEnvironmentPolicyKeyInput(value);
  if (Option.isNone(decoded)) throw badRequest("Environment approval request is invalid");
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

function parseEvidenceIdentifier(value: string): string {
  const decoded = decodeEvidenceIdentifier(value);
  if (Option.isSome(decoded)) return decoded.value;
  throw new ScottyError("not_found", "Evidence was not found", {
    httpStatus: 404,
    exitCode: 3,
  });
}

async function requireEvidenceBrowser(request: Request, env: Bindings): Promise<AuthPrincipal> {
  if (request.headers.has("authorization"))
    throw new ScottyError("auth", "Evidence review requires a registered browser", {
      httpStatus: 401,
      exitCode: 4,
    });
  const principal = await requireClientCookieRequest(request, env);
  requireAuthScope(principal, "sessions:read");
  return principal;
}

function requireEnvironmentManager(principal: AuthPrincipal): void {
  if (principal.kind === "root") return;
  requireOwnerPrincipal(principal);
}

function requireRootPrincipal(principal: AuthPrincipal): void {
  if (principal.kind === "root") return;
  throw new ScottyError("auth", "The CLI root credential is required", {
    httpStatus: 401,
    exitCode: 4,
    hint: "Run this command from a machine configured with scotty init.",
  });
}

async function requireRegisteredRunnerName(env: Bindings, value: string): Promise<string> {
  if (!RUNNER_NAME_PATTERN.test(value))
    throw new ScottyError("not_found", "Runner not found", {
      httpStatus: 404,
      exitCode: 3,
    });
  const registration = unwrapRunnerRegistryRpc(await runnerRegistry(env).get(value));
  return registration.name;
}

function runnerStatus(name: string, status: RunnerControlStatus, assignedSessions: number) {
  return { name, ...status, assignedSessions };
}

async function assignedRunnerSessionCount(env: Bindings, name: string): Promise<number> {
  const result = await Effect.runPromise(
    listSessionProjections.pipe(
      Effect.provide(projectionLayers(env)),
      Effect.scoped,
      Effect.result,
    ),
  );
  return Result.match(result, {
    onFailure: (error) => {
      throw error;
    },
    onSuccess: (sessions) =>
      sessions.filter(
        (session) =>
          session.provider === "runner" &&
          session.runner === name &&
          ASSIGNED_RUNNER_SESSION_STATUSES.has(session.status),
      ).length,
  });
}

async function configuredRunnerStatuses(env: Bindings) {
  const registrations = unwrapRunnerRegistryRpc(await runnerRegistry(env).list());
  return Promise.all(
    registrations.map(async ({ name }) => {
      const [status, assignedSessions] = await Promise.all([
        env.RUNNERS.getByName(name).controlStatus(),
        assignedRunnerSessionCount(env, name),
      ]);
      return runnerStatus(name, status, assignedSessions);
    }),
  );
}

function runnerRegistry(env: Bindings): ScottyRunnerRegistryStub {
  return env.RUNNER_REGISTRY.getByName(RUNNER_REGISTRY_OBJECT_NAME);
}

function sandboxConfig(env: Bindings): ScottySandboxConfigStub {
  return env.SANDBOX_CONFIG.getByName(SANDBOX_CONFIG_OBJECT_NAME);
}

function unwrapSandboxConfigRpc<A>(result: SandboxConfigRpcResult<A>): A {
  if (result.ok) return result.value;
  const { reason, message } = result.error;
  if (reason === "conflict" || reason === "stale") throw conflict(message);
  if (reason === "invalid_input") throw badRequest(message);
  console.error("Sandbox configuration RPC failed", { reason });
  throw new ScottyError("internal", "Sandbox configuration failed", {
    httpStatus: 500,
    exitCode: 1,
  });
}

function unwrapRunnerRegistryRpc<A>(result: RunnerRegistryRpcResult<A>): A {
  if (result.ok) return result.value;
  const { reason, message } = result.error;
  if (reason === "runner_missing")
    throw new ScottyError("not_found", message, { httpStatus: 404, exitCode: 3 });
  if (reason === "runner_exists")
    throw new ScottyError("conflict", message, {
      httpStatus: 409,
      exitCode: 5,
      hint: "Choose another name or pass --replace to rotate this runner credential.",
    });
  if (reason === "invalid_input")
    throw new ScottyError("bad_request", message, { httpStatus: 400, exitCode: 2 });
  if (reason === "credential_invalid")
    throw new ScottyError("auth", message, { httpStatus: 401, exitCode: 4 });
  console.error("Runner registry RPC failed", { reason });
  throw new ScottyError("internal", "Runner registry failed", {
    httpStatus: 500,
    exitCode: 1,
  });
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

async function serveScottySessionPage(
  env: Bindings,
  request: Request,
  sessionId: string,
): Promise<Response> {
  const session = await sessionSandbox(env, sessionId).getScottySession();
  if (session.status !== "warm")
    return Response.redirect(new URL("/sessions", request.url).toString(), 302);
  if (session.provider === "runner")
    return Response.redirect(new URL("/sessions", request.url).toString(), 302);
  return secureAsset(env, request, "/terminal.html", true);
}

async function serveScottySessionSubpath(
  env: Bindings,
  _request: Request,
  sessionId: string,
): Promise<Response> {
  await sessionSandbox(env, sessionId).getScottySession();
  return new Response(
    JSON.stringify({ error: { code: "not_found", message: "Route not found" } }),
    {
      status: 404,
      headers: { "content-type": "application/json" },
    },
  );
}

async function assertCloudflarePiAccess(sandbox: ScottySandbox): Promise<void> {
  const session = await sandbox.getScottySession();
  if (session.provider === "runner")
    throw new ScottyError("not_found", "Pi session route not found", {
      httpStatus: 404,
      exitCode: 3,
    });
  if (session.status !== "warm")
    throw wrongState(
      session.status,
      "access",
      session.status === "sleeping"
        ? "Resume the session from Home before opening the worklog"
        : undefined,
    );
  await sandbox.preparePiSessionAccess();
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
  if (session.status === "warm")
    await Effect.runPromise(
      recordWorkspaceCreation({
        sessionId: session.id,
        repository: session.repo,
        provider: session.provider,
        createdAt: session.createdAt,
      }).pipe(Effect.provide(projectionLayers(env)), Effect.scoped),
    );
  if (session.status !== "failed" && session.status !== "gone") {
    const entry = unwrapSandboxConfigRpc(
      await sandboxConfig(env).addRepo({
        repo: session.repo,
        defaultBranch: session.defaultBranch,
      }),
    );
    await Effect.runPromise(
      projectRepoEntryBestEffort(entry).pipe(Effect.provide(projectionLayers(env)), Effect.scoped),
    );
  }
  return { id, session };
}

async function verifyRepository(
  env: Bindings,
  repo: string,
): Promise<{ readonly exists: true; readonly defaultBranch: string } | { readonly exists: false }> {
  const result = await Effect.runPromise(
    Effect.flatMap(RepoVerifier, (verifier) => verifier.verify(repo, env.GH_TOKEN)).pipe(
      Effect.provide(repoVerifierLayer.pipe(Layer.provide(FetchHttpClient.layer))),
      Effect.result,
    ),
  );
  if (Result.isFailure(result)) {
    console.error("Repository verification failed", { reason: result.failure.reason });
    throw new ScottyError("upstream", "Repository verification failed", {
      httpStatus: 502,
      exitCode: 1,
      hint: "GitHub repository verification did not complete; retry the request",
    });
  }
  return result.success;
}

async function repairRepoProjection(
  env: Bindings,
  repositories: ReadonlyArray<RepositoryRegistryEntry>,
): Promise<void> {
  const matches = await Effect.runPromise(
    repoProjectionMatches(repositories).pipe(
      Effect.provide(projectionLayers(env)),
      Effect.scoped,
      Effect.result,
    ),
  );
  if (Result.isSuccess(matches) && matches.success) return;
  await Effect.runPromise(
    rebuildRepoProjection(repositories).pipe(
      Effect.provide(projectionLayers(env)),
      Effect.scoped,
      Effect.ignore,
    ),
  );
}

function projectionLayers(env: Bindings) {
  return Layer.mergeAll(
    repoProjectionLayer(kvRepoProjectionStorage(env.SESSIONS)),
    sessionProjectionLayer(kvSessionProjectionStorage(env.SESSIONS)),
    statsProjectionLayer(kvStatsProjectionStorage(env.SESSIONS)),
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
          ? input.newRepo
            ? [
                input.title,
                input.prompt,
                input.provider,
                input.runner,
                input.repo,
                true,
                input.hardCapSeconds,
              ]
            : [
                input.title,
                input.prompt,
                input.provider,
                input.runner,
                input.repo,
                input.hardCapSeconds,
              ]
          : input.newRepo
            ? [input.title, input.prompt, input.provider, input.repo, true, input.hardCapSeconds]
            : [input.title, input.prompt, input.provider, input.repo, input.hardCapSeconds],
      ),
    ),
  ]);
  return { keyDigest, inputDigest };
}

function normalizeError(error: unknown): ScottyError {
  if (error instanceof ScottyError) return error;
  const decoded = decodeWorkerError(error);
  if (Option.isSome(decoded)) {
    const fields = decoded.value;
    const operation = fields.operation;
    const isSessionProjectionFailure = Predicate.isTagged(fields, "SessionProjectionFailure");
    const isRepoProjectionFailure = Predicate.isTagged(fields, "RepoProjectionFailure");
    const isStatsProjectionFailure = Predicate.isTagged(fields, "StatsProjectionFailure");
    if (isSessionProjectionFailure || isRepoProjectionFailure || isStatsProjectionFailure) {
      console.error("Projection failure", {
        tag: isSessionProjectionFailure
          ? "SessionProjectionFailure"
          : isRepoProjectionFailure
            ? "RepoProjectionFailure"
            : "StatsProjectionFailure",
        reason: typeof operation === "string" ? operation : "unknown",
      });
      return new ScottyError("internal", "Internal error", { httpStatus: 500, exitCode: 1 });
    }
    const isScottyError = Predicate.isTagged(error, "ScottyError");
    if (
      (isScottyError || !Predicate.hasProperty(error, "_tag")) &&
      fields.code !== undefined &&
      fields.message !== undefined &&
      fields.httpStatus !== undefined &&
      fields.exitCode !== undefined
    ) {
      return new ScottyError(fields.code, fields.message, {
        httpStatus: fields.httpStatus,
        exitCode: fields.exitCode,
        hint: fields.hint,
      });
    }
  }
  console.error("Unhandled Worker error", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return new ScottyError("internal", "Internal error", { httpStatus: 500, exitCode: 1 });
}

function hatchHandoffPage(origin: string, handoff: string): Response {
  const action = `${origin}/_scotty/hatch/handoff`;
  const escape = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening Hatch</title></head><body><form id="handoff" method="post" action="${escape(action)}"><input type="hidden" name="handoff" value="${escape(handoff)}"></form><script>document.getElementById("handoff").submit()</script><noscript><button form="handoff" type="submit">Open Hatch</button></noscript></body></html>`;
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; form-action ${origin}; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

async function secureAsset(
  env: Bindings,
  request: Request,
  pathname: string,
  allowHatchHandoff = false,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    `default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' data: ws: wss:; font-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action ${allowHatchHandoff ? hatchPreviewFormAction(env.SCOTTY_PREVIEW_BASE) : "'none'"}`,
  );
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(asset.body, { status: asset.status, headers });
}

async function evidenceAsset(env: Bindings, request: Request): Promise<Response> {
  const asset = await authAsset(env, request, "/evidence.html");
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "private, no-store");
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
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(asset.body, { status: asset.status, headers });
}
