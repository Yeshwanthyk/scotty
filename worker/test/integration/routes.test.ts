import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  createScottySession: vi.fn(),
  getScottyActorDiagnostics: vi.fn(),
  getScottySession: vi.fn(),
  getScottyDeploymentReadiness: vi.fn(),
  listScottyChanges: vi.fn(),
  getScottyChangedFilePatch: vi.fn(),
  completeScottyEvidenceStep: vi.fn(),
  finalizeScottyEvidenceJob: vi.fn(),
  listScottyEvidence: vi.fn(),
  getScottyEvidence: vi.fn(),
  getScottyEvidenceArtifact: vi.fn(),
  getScottyHatchStatus: vi.fn(),
  ensureScottyHatch: vi.fn(),
  closeScottyHatch: vi.fn(),
  getScottyHatchOpenRoute: vi.fn(),
  renameScottySession: vi.fn(),
  snapshotScottySession: vi.fn(),
  sleepScottySession: vi.fn(),
  resumeScottySession: vi.fn(),
  prepareDownArchive: vi.fn(),
  readScottyArchiveStream: vi.fn(),
  getSession: vi.fn(),
  vaporizeScottySession: vi.fn(),
  fetch: vi.fn(),
  containerFetch: vi.fn(),
  preparePiSessionAccess: vi.fn(),
  prepareTerminalAccess: vi.fn(),
  restartScottyTerminal: vi.fn(),
}));

const sandboxTarget = vi.hoisted((): { current: unknown } => ({
  current: sandbox,
}));
const proxyTerminal = vi.hoisted(() => vi.fn());

const auth = vi.hoisted(() => ({
  acceptOwnerTransfer: vi.fn(),
  authenticate: vi.fn(),
  cancelOwnerTransfer: vi.fn(),
  consumeHatchHandoff: vi.fn(),
  consumePairing: vi.fn(),
  consumeRecoveryGrant: vi.fn(),
  currentOwnerTransfer: vi.fn(),
  issueHatchHandoff: vi.fn(),
  issuePairing: vi.fn(),
  issueRecoveryGrant: vi.fn(),
  listClients: vi.fn(),
  logoutClient: vi.fn(),
  revokeClient: vi.fn(),
  startOwnerTransfer: vi.fn(),
}));

const runner = vi.hoisted(() => ({
  control: vi.fn(),
  controlStatus: vi.fn(),
  fetch: vi.fn(),
  getByName: vi.fn(),
}));

const runnerRegistry = vi.hoisted(() => ({
  authenticate: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  register: vi.fn(),
  remove: vi.fn(),
}));

const sandboxConfig = vi.hoisted(() => ({
  status: vi.fn(),
  activate: vi.fn(),
  listRepos: vi.fn(),
  addRepo: vi.fn(),
  removeRepo: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/sandbox")>()),
  getSandbox: vi.fn(() => sandboxTarget.current),
  proxyTerminal,
}));

const credentialRegistry = vi.hoisted(() => ({
  sync: vi.fn(),
  issueGrants: vi.fn(),
  list: vi.fn(),
  resolve: vi.fn(),
  resolveGithubCliCredential: vi.fn(),
  release: vi.fn(),
}));

import { createDeterministicTarGz } from "../../../cli/src/sandbox-archive";
import { app } from "../../src/index";
import type { Bindings } from "../../src/shared/bindings";
import { commandIntentDigest, decodePiConsoleCommandPromise } from "../../../protocol/pi-console";
import { conflict, ScottyError, toProjection } from "../../src/session/contracts";
import type { EvidenceState } from "../../src/evidence/contracts";
import { orderedEvidenceFrames } from "../../public/evidence/view.js";
import evidenceHtml from "../../public/evidence/index.html?raw";

import evidenceScript from "../../public/evidence/index.js?raw";
import showcaseHtml from "../../public/showcase/index.html?raw";
import showcaseScript from "../../public/showcase/index.js?raw";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
  type SessionHarness,
} from "../support/session-harness";
import { makeSessionRecord } from "../support";

class RouteTestFailure extends Error {
  readonly _tag = "RouteTestFailure" as const;
}

const TOKEN = "worker-test-token-1234567890";
const CLIENT_CREDENTIAL = "scotty_client.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT_CREDENTIAL_GRANTS = [
  {
    name: "codex",
    kind: "pi-auth",
    versionRef: "version-a",
    handleSlots: [
      { provider: "openai", slot: "api-key" },
      { provider: "openai-codex", slot: "access" },
    ],
    expires: 1_800_000_000_000,
  },
  {
    name: "github",
    kind: "github-cli",
    versionRef: "version-b",
    handleSlots: [{ provider: "github", slot: "git-https" }],
  },
] as const;
const routeHarness = () =>
  createSessionHarness({ credentialRegistryGrants: DEFAULT_CREDENTIAL_GRANTS });
const REGISTERED_CLIENT = {
  id: "111111111111",
  label: "Trusted browser",
  scopes: ["sessions:read", "sessions:write", "access:read", "access:write"],
  role: "owner",
  createdAt: "2026-07-22T12:00:00.000Z",
  expiresAt: "2026-08-21T12:00:00.000Z",
  lastSeenAt: "2026-07-22T12:00:00.000Z",
  current: true,
};

function authNamespace(): import("../../src/auth/object").ScottyAuthRegistryNamespace {
  return { getByName: () => auth };
}

function runnerRegistryNamespace(): import("../../src/runner/registry-object").ScottyRunnerRegistryNamespace {
  return { getByName: () => runnerRegistry };
}

function credentialRegistryNamespace(): import("../../src/credentials/object").ScottyCredentialRegistryNamespace {
  return { getByName: () => credentialRegistry };
}

function sandboxConfigNamespace(): import("../../src/sandbox/config-object").ScottySandboxConfigNamespace {
  return { getByName: () => sandboxConfig };
}

function sandboxBundleBucket(): R2Bucket {
  const objects = new Map<
    string,
    {
      readonly size: number;
      readonly contentType: string;
      readonly customMetadata: Record<string, string>;
    }
  >();
  // lint-allow-double-cast: boundary: focused-test-r2-adapter
  return {
    put: async (
      key: string,
      value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string | null,
      options?: R2PutOptions,
    ) => {
      if (!(value instanceof Uint8Array)) throw new RouteTestFailure("expected Uint8Array body");
      if (
        options?.onlyIf !== undefined &&
        !(options.onlyIf instanceof Headers) &&
        options.onlyIf.etagDoesNotMatch === "*" &&
        objects.has(String(key))
      )
        return null;
      objects.set(String(key), {
        size: value.byteLength,
        contentType:
          options?.httpMetadata instanceof Headers
            ? (options.httpMetadata.get("content-type") ?? "")
            : (options?.httpMetadata?.contentType ?? ""),
        customMetadata: { ...options?.customMetadata },
      });
      return {
        key: String(key),
        version: "1",
        size: value.byteLength,
        etag: "etag",
        httpEtag: '"etag"',
        checksums: { toJSON: () => ({}) },
        uploaded: new Date("2026-08-06T12:00:00.000Z"),
        httpMetadata: {
          contentType:
            options?.httpMetadata instanceof Headers
              ? (options.httpMetadata.get("content-type") ?? undefined)
              : options?.httpMetadata?.contentType,
        },
        customMetadata: { ...options?.customMetadata },
        storageClass: "Standard",
        writeHttpMetadata: () => undefined,
      } as R2Object;
    },
    head: async (key: string) => {
      const stored = objects.get(String(key));
      if (stored === undefined) return null;
      return {
        key: String(key),
        version: "1",
        size: stored.size,
        etag: "etag",
        httpEtag: '"etag"',
        checksums: { toJSON: () => ({}) },
        uploaded: new Date("2026-08-06T12:00:00.000Z"),
        httpMetadata: { contentType: stored.contentType },
        customMetadata: stored.customMetadata,
        storageClass: "Standard",
        writeHttpMetadata: () => undefined,
      } as R2Object;
    },
    get: async () => null,
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
  } as unknown as R2Bucket;
}

function emptySessionsNamespace(values = new Map<string, unknown>()): KVNamespace {
  const textValue = (name: string): string | null => {
    const value = values.get(name);
    return value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value);
  };
  return {
    list: async () => ({
      keys: [...values.keys()].map((name) => ({
        name,
        expiration: undefined,
        metadata: undefined,
      })),
      list_complete: true,
      cacheStatus: null,
    }),
    get: async (name: string | string[]) =>
      Array.isArray(name) ? new Map(name.map((key) => [key, textValue(key)])) : textValue(name),
    getWithMetadata: async (name: string | string[]) => {
      const missing = { value: null, metadata: null, cacheStatus: null };
      return Array.isArray(name) ? new Map(name.map((key) => [key, missing])) : missing;
    },
    put: async (_name: string, _value: string | ArrayBuffer | ArrayBufferView | ReadableStream) =>
      undefined,
    delete: async (_name: string) => undefined,
  } as KVNamespace;
}

function env(
  options: {
    readonly assets?: Fetcher;
    readonly artifactBucket?: R2Bucket;
    readonly unused?: never;
  } = {},
): Bindings {
  const assets: Fetcher = options.assets ?? {
    fetch: async () =>
      new Response("<!doctype html><title>Scotty</title>", {
        headers: { "content-type": "text/html" },
      }),
    connect: () => {
      throw new RouteTestFailure("ASSETS.connect isn't used by route tests");
    },
  };
  return {
    SCOTTY_TOKEN: TOKEN,
    CREDENTIALS: credentialRegistryNamespace(),
    ASSETS: assets,
    AUTH: authNamespace(),
    RUNNER_REGISTRY: runnerRegistryNamespace(),
    RUNNERS: { getByName: runner.getByName },
    SANDBOX: {} as DurableObjectNamespace<import("../../src/session/object").Sandbox>,
    SESSIONS: emptySessionsNamespace(),
    BACKUP_BUCKET: {} as R2Bucket,
    ARTIFACT_BUCKET: options.artifactBucket ?? ({} as R2Bucket),
    SANDBOX_BUNDLE_BUCKET: sandboxBundleBucket(),
    SANDBOX_CONFIG: sandboxConfigNamespace(),
  } as Bindings;
}

function useRealSandbox(harness: SessionHarness): void {
  sandboxTarget.current = harness.sandbox;
}

const evidencePng = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);
const evidenceWebm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00]);

const evidenceArtifactBucket = (jobId: string, sha256: string): R2Bucket => {
  const objectFor = (key: string) => {
    const prefix = `evidence/a0b1c2d3e4f5/${jobId}/`;
    const frameId = key.startsWith(prefix) ? key.slice(prefix.length, -".png".length) : "";
    if (!key.endsWith(".png") || (frameId !== "frame-1" && frameId !== "frame-2")) {
      return null;
    }
    return {
      key,
      version: "1",
      size: evidencePng.byteLength,
      etag: "frame-etag",
      httpEtag: '"frame-etag"',
      checksums: { toJSON: () => ({}) },
      uploaded: new Date("2026-08-06T12:00:01.000Z"),
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        owner: "a0b1c2d3e4f5",
        job: jobId,
        frame: frameId,
        sha256,
      },
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(evidencePng);
          controller.close();
        },
      }),
      bodyUsed: false,
      arrayBuffer: () => Promise.resolve(evidencePng.buffer.slice(0)),
      bytes: () => Promise.resolve(Uint8Array.from(evidencePng)),
      text: () => Promise.resolve(""),
      json: <T>() => Promise.resolve({} as T),
      blob: () => Promise.resolve(new Blob([evidencePng], { type: "image/png" })),
    };
  };
  const bucket = {
    get: async (key: string) => objectFor(key),
  };
  return bucket as R2Bucket;
};

const evidenceAssets = (): Fetcher => ({
  fetch: async (input) => {
    const pathname = new URL(new Request(input).url).pathname;
    return new Response(pathname === "/evidence/index.html" ? evidenceHtml : "not found", {
      status: pathname === "/evidence/index.html" ? 200 : 404,
      headers: { "content-type": "text/html" },
    });
  },
  connect: () => {
    throw new RouteTestFailure("evidence asset tests do not use connect");
  },
});

const showcaseAssets = (): Fetcher => ({
  fetch: async (input) => {
    const pathname = new URL(new Request(input).url).pathname;
    return new Response(pathname === "/showcase/index.html" ? showcaseHtml : "not found", {
      status: pathname === "/showcase/index.html" ? 200 : 404,
      headers: { "content-type": "text/html" },
    });
  },
  connect: () => {
    throw new RouteTestFailure("Showcase asset tests do not use connect");
  },
});

const evidenceVideoBucket = (jobId: string, sha256: string): R2Bucket => {
  const key = `evidence/${SESSION_ID}/${jobId}/recording.webm`;
  const object = {
    key,
    version: "1",
    size: evidenceWebm.byteLength,
    etag: "video-etag",
    httpEtag: '"video-etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-08-06T12:00:01.000Z"),
    httpMetadata: { contentType: "video/webm" },
    customMetadata: { owner: SESSION_ID, job: jobId, frame: "recording", sha256 },
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(evidenceWebm);
        controller.close();
      },
    }),
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(evidenceWebm.buffer.slice(0)),
    bytes: () => Promise.resolve(Uint8Array.from(evidenceWebm)),
    text: () => Promise.resolve(""),
    json: <T>() => Promise.resolve({} as T),
    blob: () => Promise.resolve(new Blob([evidenceWebm], { type: "video/webm" })),
  };
  return { get: async (candidate: string) => (candidate === key ? object : null) } as R2Bucket;
};

const projection = {
  id: "a0b1c2d3e4f5",
  title: "Test session",
  status: "failed",
  provider: "cloudflare",
  repo: "owner/repo",
  defaultBranch: "main",
  branch: "scotty/a0b1c2d3e4f5",
  backupId: "backup-1",
  codexThreadId: "thread-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  hardCapAt: "2026-01-01T04:00:00.000Z",
  projectedAt: "2026-01-01T00:01:00.000Z",
  sandboxBundle: { digest: null },
  failure: { code: "backup_failed", message: "Backup failed", recoverable: true },
  secret: "must-not-survive",
};

describe("real Hono boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandboxTarget.current = sandbox;
    sandbox.fetch.mockResolvedValue(new Response("unused"));
    sandbox.containerFetch.mockResolvedValue(
      Response.json({ epoch: "epoch-1", sequence: 0, messages: [] }),
    );
    sandbox.listScottyEvidence.mockResolvedValue([]);
    sandbox.getScottyEvidence.mockResolvedValue({
      sequence: 0,
      jobId: "job-1",
      status: "succeeded",
      acceptedAt: "2026-07-22T12:00:00.000Z",
      completedAt: "2026-07-22T12:00:01.000Z",
      totalSteps: 1,
      completedSteps: 1,
      viewport: { width: 1_280, height: 720 },
      recordVideo: false,
      flowHash: "a".repeat(64),
      steps: [],
      frameCount: 0,
    });
    sandbox.getScottySession.mockResolvedValue({
      id: "a0b1c2d3e4f5",
      title: "Test session",
      status: "warm",
      provider: "cloudflare",
      repo: "owner/repo",
      branch: "scotty/a0b1c2d3e4f5",
    });
    sandbox.listScottyChanges.mockResolvedValue({ files: [], truncated: false });
    sandbox.getScottyChangedFilePatch.mockResolvedValue({
      path: "src/app.ts",
      status: "modified",
      staged: false,
      unstaged: true,
      additions: 1,
      deletions: 1,
      binary: false,
      patchable: true,
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      truncated: false,
    });
    sandbox.getScottyDeploymentReadiness.mockResolvedValue({
      id: "a0b1c2d3e4f5",
      title: "Test session",
      recordStatus: "sleeping",
      operation: null,
      runtime: "stopped",
      pi: "not_running",
      ready: true,
      reason: "sleeping_checkpointed",
    });
    sandbox.preparePiSessionAccess.mockResolvedValue(undefined);
    sandbox.prepareTerminalAccess.mockResolvedValue(undefined);
    sandbox.restartScottyTerminal.mockResolvedValue(undefined);
    proxyTerminal.mockResolvedValue(new Response("terminal-proxy"));
    sandbox.getScottyHatchStatus.mockResolvedValue({ status: "not_configured" });
    sandbox.ensureScottyHatch.mockResolvedValue({
      status: "configured",
      hatchId: "hatch-primary",
      generation: 1,
      service: { name: "docs", port: 4_173 },
      desiredStatus: "open",
      observedStatus: "running",
      exposure: "active",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:01.000Z",
    });
    sandbox.closeScottyHatch.mockResolvedValue({
      status: "configured",
      hatchId: "hatch-primary",
      generation: 2,
      service: { name: "docs", port: 4_173 },
      desiredStatus: "closed",
      observedStatus: "stopped",
      exposure: "closed",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:02.000Z",
    });
    auth.authenticate.mockResolvedValue({
      ok: true,
      value: {
        client: REGISTERED_CLIENT,
        renewed: false,
      },
    });
    runnerRegistry.authenticate.mockImplementation(async (name: string, credential: string) =>
      name !== "test-runner"
        ? { ok: false, error: { reason: "runner_missing", message: "Runner not found" } }
        : credential !== "runner-test-token"
          ? {
              ok: false,
              error: { reason: "credential_invalid", message: "Runner authorization failed" },
            }
          : {
              ok: true,
              value: {
                name: "test-runner",
                createdAt: "2026-07-27T11:00:00.000Z",
                updatedAt: "2026-07-27T11:00:00.000Z",
              },
            },
    );
    runnerRegistry.get.mockImplementation(async (name: string) =>
      name === "test-runner"
        ? {
            ok: true,
            value: {
              name,
              createdAt: "2026-07-27T11:00:00.000Z",
              updatedAt: "2026-07-27T11:00:00.000Z",
            },
          }
        : { ok: false, error: { reason: "runner_missing", message: "Runner not found" } },
    );
    runnerRegistry.list.mockResolvedValue({
      ok: true,
      value: [
        {
          name: "test-runner",
          createdAt: "2026-07-27T11:00:00.000Z",
          updatedAt: "2026-07-27T11:00:00.000Z",
        },
      ],
    });
    runnerRegistry.register.mockResolvedValue({
      ok: true,
      value: {
        credential: "scotty_runner_new-credential",
        replaced: false,
        runner: {
          name: "garage",
          createdAt: "2026-07-29T16:00:00.000Z",
          updatedAt: "2026-07-29T16:00:00.000Z",
        },
      },
    });
    runnerRegistry.remove.mockResolvedValue({ ok: true, value: undefined });
    runner.getByName.mockReturnValue({
      control: runner.control,
      controlStatus: runner.controlStatus,
      fetch: runner.fetch,
    });
    runner.control.mockResolvedValue(undefined);
    runner.controlStatus.mockResolvedValue({
      desired: "accepting",
      connection: "connected",
      lastSeenAt: "2026-07-27T12:00:00.000Z",
    });
    runner.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    sandboxConfig.status.mockResolvedValue({
      ok: true,
      value: { revision: 0, activeDigest: null },
    });
    sandboxConfig.activate.mockResolvedValue({
      ok: true,
      value: { revision: 1, activeDigest: "a".repeat(64) },
    });
    sandboxConfig.listRepos.mockResolvedValue({ ok: true, value: [] });
    sandboxConfig.addRepo.mockImplementation(async (input) => ({
      ok: true,
      value: {
        repo: input.repo,
        defaultBranch: input.defaultBranch,
        addedAt: "2026-08-15T12:00:00.000Z",
        lastUsedAt: "2026-08-15T12:00:00.000Z",
      },
    }));
    sandboxConfig.removeRepo.mockResolvedValue({ ok: true, value: true });
    credentialRegistry.resolveGithubCliCredential.mockImplementation(async () => ({
      ok: true,
      value: { value: "test-github-token" },
    }));
    credentialRegistry.issueGrants.mockImplementation(
      async (input: { readonly sessionId: string }) => ({
        ok: true,
        value: { sessionId: input.sessionId, grants: DEFAULT_CREDENTIAL_GRANTS },
      }),
    );
    credentialRegistry.sync.mockResolvedValue({ ok: true, value: { credentials: [] } });
  });

  it("projects and mutates the Schema-owned primary Hatch through existing auth envelopes", async () => {
    const read = await app.request(
      "/api/sessions/a0b1c2d3e4f5/hatch",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ status: "not_configured" });

    const input = {
      service: {
        name: "docs",
        argv: ["npm", "run", "dev"],
        workingDirectory: "/workspace/a0b1c2d3e4f5",
        port: 4_173,
        healthPath: "/health",
      },
    };
    const opened = await app.request(
      "/api/sessions/a0b1c2d3e4f5/hatch",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          "content-type": "application/json",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify(input),
      },
      env(),
    );
    expect(opened.status).toBe(200);
    expect(sandbox.ensureScottyHatch).toHaveBeenCalledWith(input);
    expect(opened.headers.get("cache-control")).toBe("private, no-store");

    const closed = await app.request(
      "/api/sessions/a0b1c2d3e4f5/hatch",
      {
        method: "DELETE",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(closed.status).toBe(200);
    expect(sandbox.closeScottyHatch).toHaveBeenCalledOnce();
    expect(closed.headers.get("cache-control")).toBe("private, no-store");

    sandbox.resumeScottySession.mockResolvedValue({
      id: "a0b1c2d3e4f5",
      status: "warm",
      provider: "cloudflare",
      repo: "owner/repo",
      branch: "scotty/a0b1c2d3e4f5",
    });
    const woken = await app.request(
      "/api/sessions/a0b1c2d3e4f5/resume",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(woken.status).toBe(200);
    expect(sandbox.resumeScottySession).toHaveBeenCalledOnce();

    const crossSiteStop = await app.request(
      "/api/sessions/a0b1c2d3e4f5/hatch",
      {
        method: "DELETE",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      },
      env(),
    );
    expect(crossSiteStop.status).toBe(400);
    expect(sandbox.closeScottyHatch).toHaveBeenCalledOnce();
  });

  it("returns an auto-submitting exact-host Hatch handoff without forwarding control authority", async () => {
    sandbox.getScottyHatchOpenRoute.mockResolvedValue({
      sessionId: "a0b1c2d3e4f5",
      hatchId: "hatch-primary",
      generation: 1,
      port: 4_173,
      routeNonce: "h0123456789abcd",
      runtimeEpoch: "epoch-current",
    });
    auth.issueHatchHandoff.mockResolvedValue({
      ok: true,
      value: {
        credential: "scotty_hatch.bbbbbbbbbbbb.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
        expiresAt: "2026-08-08T12:01:00.000Z",
      },
    });
    const response = await app.request(
      "/s/a0b1c2d3e4f5/hatch/open",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      { ...env(), SCOTTY_PREVIEW_BASE: "preview.example.test" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; form-action https://4173-a0b1c2d3e4f5-h0123456789abcd.preview.example.test; base-uri 'none'; frame-ancestors 'none'",
    );
    const html = await response.text();
    expect(html).toContain(
      'action="https://4173-a0b1c2d3e4f5-h0123456789abcd.preview.example.test/_scotty/hatch/handoff"',
    );
    expect(html).toContain('method="post"');
    expect(html).toContain("scotty_hatch.bbbbbbbbbbbb");
    expect(html).not.toContain(CLIENT_CREDENTIAL);
    expect(html).not.toContain(TOKEN);
    expect(auth.issueHatchHandoff).toHaveBeenCalledWith(
      CLIENT_CREDENTIAL,
      "a0b1c2d3e4f5",
      "hatch-primary",
    );
  });

  it("accepts only a registered authenticated runner and strips its credential", async () => {
    runner.fetch.mockImplementation(async (request: Request) => {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("user-agent")).toBeNull();
      expect(request.headers.get("upgrade")).toBe("websocket");
      return new Response(null, { status: 204 });
    });

    const response = await app.request(
      "/api/runners/test-runner/connect",
      {
        headers: {
          authorization: "Bearer runner-test-token",
          cookie: "scotty_client=must-not-forward",
          "user-agent": "browser-metadata",
          upgrade: "websocket",
        },
      },
      env(),
    );

    expect(response.status).toBe(204);
    expect(runnerRegistry.authenticate).toHaveBeenCalledWith("test-runner", "runner-test-token");
    expect(runner.getByName).toHaveBeenCalledWith("test-runner");
    expect(runner.fetch).toHaveBeenCalledTimes(1);
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("rejects unregistered, unauthenticated, and non-upgrade runner requests before the DO", async () => {
    const requests = [
      app.request(
        "/api/runners/other/connect",
        {
          headers: {
            authorization: "Bearer runner-test-token",
            upgrade: "websocket",
          },
        },
        env(),
      ),
      app.request("/api/runners/test-runner/connect", { headers: { upgrade: "websocket" } }, env()),
      app.request(
        "/api/runners/test-runner/connect",
        {
          headers: {
            authorization: "Bearer wrong-runner-token",
            upgrade: "websocket",
          },
        },
        env(),
      ),
      app.request(
        "/api/runners/test-runner/connect",
        { headers: { authorization: "Bearer runner-test-token" } },
        env(),
      ),
    ];
    const responses = await Promise.all(requests);

    expect(responses.map(({ status }) => status)).toEqual([404, 401, 401, 426]);
    expect(runner.fetch).not.toHaveBeenCalled();
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated API requests before touching bindings", async () => {
    const response = await app.request("/api/sessions", undefined, env());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth",
        message: "Authentication required",
        hint: "Open a fresh pairing or recovery link, or configure the CLI root token.",
      },
    });
  });

  it("reads deployment readiness from each authoritative Sandbox DO", async () => {
    const record = makeSessionRecord({
      id: "a0b1c2d3e4f5",
      title: "Projected title must not decide readiness",
      status: "warm",
    });
    const sessions = new Map<string, unknown>([
      [
        "session:a0b1c2d3e4f5",
        JSON.stringify(toProjection(record, new Date("2026-08-30T12:00:00.000Z"))),
      ],
    ]);
    sandbox.getScottyDeploymentReadiness.mockResolvedValueOnce({
      id: record.id,
      title: record.title,
      recordStatus: "warm",
      operation: null,
      agentState: "waiting",
      lastAgentEventAt: "2026-08-30T11:59:00.000Z",
      runtime: "running",
      pi: "reachable",
      ready: false,
      reason: "record_warm",
    });
    const response = await app.request(
      "/api/sessions/deployment-readiness",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: emptySessionsNamespace(sessions) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        id: record.id,
        title: record.title,
        recordStatus: "warm",
        operation: null,
        agentState: "waiting",
        lastAgentEventAt: "2026-08-30T11:59:00.000Z",
        runtime: "running",
        pi: "reachable",
        ready: false,
        reason: "record_warm",
      },
    ]);
    expect(sandbox.getScottyDeploymentReadiness).toHaveBeenCalledTimes(1);
  });

  it("syncs a complete redacted credential desired set through the Registry", async () => {
    credentialRegistry.sync.mockResolvedValue({
      ok: true,
      value: {
        credentials: [
          {
            name: "github",
            kind: "github-cli",
            scope: "repository",
            repositories: ["owner/repo"],
            configured: true,
          },
        ],
      },
    });
    const request = {
      credentials: [
        {
          name: "github",
          kind: "github-cli",
          scope: "repository",
          repositories: ["owner/repo"],
          token: "github-token-must-not-be-returned",
        },
      ],
    };
    const response = await app.request(
      "/api/credentials/sync",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credentials: [
        {
          name: "github",
          kind: "github-cli",
          scope: "repository",
          repositories: ["owner/repo"],
          configured: true,
        },
      ],
    });
    expect(credentialRegistry.sync).toHaveBeenCalledWith(request);
  });

  it("reports providers separately from dynamically named runners", async () => {
    const providers = await app.request(
      "/api/providers",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(providers.status).toBe(200);
    await expect(providers.json()).resolves.toEqual([
      { name: "cloudflare", status: "configured" },
      { name: "runner", status: "available" },
    ]);

    const runners = await app.request(
      "/api/runners",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(runners.status).toBe(200);
    await expect(runners.json()).resolves.toEqual([
      {
        name: "test-runner",
        desired: "accepting",
        connection: "connected",
        lastSeenAt: "2026-07-27T12:00:00.000Z",
        assignedSessions: 0,
      },
    ]);

    const assignedProjection = {
      id: "b0b1c2d3e4f5",
      title: "Runner recovery",
      status: "failed",
      provider: "runner",
      runner: "test-runner",
      repo: "owner/repo",
      defaultBranch: "main",
      branch: "scotty/b0b1c2d3e4f5",
      codexThreadId: "thread-2",
      createdAt: "2026-07-27T11:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
      hardCapAt: "2026-07-27T16:00:00.000Z",
      projectedAt: "2026-07-27T12:00:00.000Z",
      sandboxBundle: { digest: null },
      failure: {
        code: "resume_failed",
        message: "Session restore failed",
        recoverable: true,
      },
    };
    const sessions = {
      list: async () => ({
        keys: [{ name: `session:${assignedProjection.id}` }],
        list_complete: true,
        cacheStatus: null,
      }),
      get: async (_name: string) => assignedProjection,
    } as KVNamespace;
    const assigned = await app.request(
      "/api/runners",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    await expect(assigned.json()).resolves.toEqual([
      expect.objectContaining({ name: "test-runner", assignedSessions: 1 }),
    ]);

    runner.controlStatus.mockResolvedValueOnce({
      desired: "draining",
      connection: "connected",
      lastSeenAt: "2026-07-27T12:00:00.000Z",
    });
    const unavailable = await app.request(
      "/api/providers",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    await expect(unavailable.json()).resolves.toEqual([
      { name: "cloudflare", status: "configured" },
      { name: "runner", status: "unavailable" },
    ]);
  });

  it("registers and rotates named runners only with the CLI root credential", async () => {
    const created = await app.request(
      "/api/runners",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "garage", replace: false }),
      },
      env(),
    );
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({
      name: "garage",
      credential: "scotty_runner_new-credential",
      replaced: false,
      createdAt: "2026-07-29T16:00:00.000Z",
      updatedAt: "2026-07-29T16:00:00.000Z",
    });
    expect(runnerRegistry.register).toHaveBeenCalledWith("garage", false);
    expect(runner.control).not.toHaveBeenCalled();

    runnerRegistry.register.mockResolvedValueOnce({
      ok: true,
      value: {
        credential: "scotty_runner_rotated-credential",
        replaced: true,
        runner: {
          name: "test-runner",
          createdAt: "2026-07-27T11:00:00.000Z",
          updatedAt: "2026-07-29T16:00:00.000Z",
        },
      },
    });
    const replaced = await app.request(
      "/api/runners",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "test-runner", replace: true }),
      },
      env(),
    );
    expect(replaced.status).toBe(200);
    expect(runner.control).toHaveBeenCalledWith("disconnect");

    const ownerBrowser = await app.request(
      "/api/runners",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "browser-runner" }),
      },
      env(),
    );
    expect(ownerBrowser.status).toBe(401);
  });

  it("reads and uploads sandbox bundles only with the CLI root credential", async () => {
    const configuration = await app.request(
      "/api/sandbox/configuration",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(configuration.status).toBe(200);
    await expect(configuration.json()).resolves.toEqual({
      revision: 0,
      activeDigest: null,
    });
    expect(sandboxConfig.status).toHaveBeenCalled();

    const built = createDeterministicTarGz([
      {
        path: "manifest.json",
        type: "file",
        modeClass: "regular",
        bytes: new TextEncoder().encode('{"items":[]}\n'),
      },
    ]);
    const uploaded = await app.request(
      `/api/sandbox/bundles/${built.digest}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/gzip",
          "idempotency-key": "sandbox-sync-key-001",
          "if-match": "0",
        },
        body: built.archive,
      },
      env(),
    );
    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toEqual({
      revision: 1,
      activeDigest: "a".repeat(64),
    });
    expect(sandboxConfig.activate).toHaveBeenCalledWith({
      digest: built.digest,
      idempotencyKey: "sandbox-sync-key-001",
      expectedRevision: 0,
    });

    const malformedGzip = await app.request(
      `/api/sandbox/bundles/${built.digest}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/gzip",
          "idempotency-key": "sandbox-sync-key-malformed-gzip",
          "if-match": "1",
        },
        body: new Uint8Array([0x6e, 0x6f, 0x74, 0x2d, 0x67, 0x7a, 0x69, 0x70]),
      },
      env(),
    );
    expect(malformedGzip.status).toBe(400);
    await expect(malformedGzip.json()).resolves.toEqual({
      error: { code: "bad_request", message: "Sandbox archive is not valid gzip" },
    });

    const invalidDigest = await app.request(
      "/api/sandbox/bundles/not-a-digest",
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/gzip",
          "idempotency-key": "sandbox-sync-key-002",
        },
        body: built.archive,
      },
      env(),
    );
    expect(invalidDigest.status).toBe(400);

    sandboxConfig.activate.mockResolvedValueOnce({
      ok: false,
      error: { reason: "conflict", message: "Sandbox configuration revision conflict" },
    });
    const stale = await app.request(
      `/api/sandbox/bundles/${built.digest}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/gzip",
          "idempotency-key": "sandbox-sync-key-003",
          "if-match": "0",
        },
        body: built.archive,
      },
      env(),
    );
    expect(stale.status).toBe(409);

    sandboxConfig.activate.mockResolvedValueOnce({
      ok: true,
      value: { revision: 1, activeDigest: built.digest },
    });
    const replay = await app.request(
      `/api/sandbox/bundles/${built.digest}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/gzip",
          "idempotency-key": "sandbox-sync-key-001",
          "if-match": "0",
        },
        body: built.archive,
      },
      env(),
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({
      revision: 1,
      activeDigest: built.digest,
    });

    const ownerBrowser = await app.request(
      "/api/sandbox/configuration",
      {
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(ownerBrowser.status).toBe(401);
  });

  it("disables and removes only unassigned registered runners", async () => {
    const removed = await app.request(
      "/api/runners/test-runner",
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      env(),
    );
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({
      name: "test-runner",
      status: "removed",
    });
    expect(runner.control.mock.calls.map(([action]) => action)).toEqual(["disable", "disconnect"]);
    expect(runnerRegistry.remove).toHaveBeenCalledWith("test-runner");

    const assignedProjection = {
      id: "b0b1c2d3e4f5",
      title: "Runner recovery",
      status: "warm",
      provider: "runner",
      runner: "test-runner",
      repo: "owner/repo",
      defaultBranch: "main",
      branch: "scotty/b0b1c2d3e4f5",
      createdAt: "2026-07-27T11:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
      hardCapAt: "2026-07-27T16:00:00.000Z",
      projectedAt: "2026-07-27T12:00:00.000Z",
      sandboxBundle: { digest: null },
    };
    const sessions = {
      list: async () => ({
        keys: [{ name: `session:${assignedProjection.id}` }],
        list_complete: true,
        cacheStatus: null,
      }),
      get: async (_name: string) => JSON.stringify(assignedProjection),
    } as KVNamespace;
    vi.clearAllMocks();
    const conflict = await app.request(
      "/api/runners/test-runner",
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      { ...env(), SESSIONS: sessions },
    );
    expect(conflict.status).toBe(409);
    expect(runner.control).not.toHaveBeenCalled();
    expect(runnerRegistry.remove).not.toHaveBeenCalled();
  });

  it("allows only the owner browser to control the configured runner", async () => {
    for (const action of ["enable", "drain", "disable", "disconnect"]) {
      const response = await app.request(
        `/api/runners/test-runner/${action}`,
        {
          method: "POST",
          headers: {
            cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
            origin: "http://localhost",
            "sec-fetch-site": "same-origin",
          },
        },
        env(),
      );
      expect(response.status).toBe(200);
    }
    expect(runner.control.mock.calls.map(([action]) => action)).toEqual([
      "enable",
      "drain",
      "disable",
      "disconnect",
    ]);

    auth.authenticate.mockResolvedValueOnce({
      ok: true,
      value: {
        client: { ...REGISTERED_CLIENT, role: "standard" },
        renewed: false,
      },
    });
    const standard = await app.request(
      "/api/runners/test-runner/drain",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(standard.status).toBe(401);

    const unknownRunner = await app.request(
      "/api/runners/helium/drain",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(unknownRunner.status).toBe(404);

    const unknownAction = await app.request(
      "/api/runners/test-runner/restart",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(unknownAction.status).toBe(404);
    expect(runner.control).toHaveBeenCalledTimes(4);
  });

  it("preserves the create status, output shape, and default hard cap", async () => {
    const harness = await routeHarness();
    useRealSandbox(harness);
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          title: "  Ship dashboard  ",
          prompt: " ship it ",
          provider: "cloudflare",
          repo: "owner/project",
          cap: "90m",
        }),
      },
      env(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
      throw new TypeError("Expected create response object");
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{12}$/u),
      title: "Ship dashboard",
      url: expect.stringMatching(/^http:\/\/localhost\/s\/[0-9a-f]{12}$/u),
      branch: `scotty/${body.id}`,
      provider: "cloudflare",
      status: "warm",
    });
    expect(harness.readRecord()).toMatchObject({
      id: body.id,
      title: "Ship dashboard",
      branch: `scotty/${body.id}`,
      provider: "cloudflare",
      repo: "owner/project",
      defaultBranch: "main",
      status: "warm",
      operation: null,
      hardCapDurationSeconds: 14_400,
    });
    expect(harness.events).toEqual(
      expect.arrayContaining([
        "schedule:sessionActorHardCap",
        "storage:put:scotty:session-actor:authority",
        "storage:put:scotty:session-actor:journal-tail",
        "host:exec:workspace",
        "host:writeFile",
        "host:setEnvVars",
        "projection:warm",
      ]),
    );
  });

  it("rejects an invalid newRepo request field before invoking the sandbox", async () => {
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ship dashboard",
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/project",
          newRepo: "true",
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "newRepo must be a boolean" },
    });
    expect(sandbox.createScottySession).not.toHaveBeenCalled();
  });

  it("maps repeated create keys to one Sandbox identity", async () => {
    const harness = await routeHarness();
    useRealSandbox(harness);
    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "01234567-89ab-4cde-8fab-0123456789ab",
      },
      body: JSON.stringify({
        title: "Ship project",
        prompt: "ship it",
        provider: "cloudflare",
        repo: "owner/project",
      }),
    };
    const first = await app.request("/api/sessions", request, env());
    const second = await app.request("/api/sessions", request, env());
    const firstBody = await first.json();
    const secondBody = await second.json();
    if (
      !firstBody ||
      typeof firstBody !== "object" ||
      !("id" in firstBody) ||
      typeof firstBody.id !== "string"
    )
      throw new TypeError("Expected idempotent create response object");
    expect(firstBody).toEqual(secondBody);
    expect(firstBody).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{12}$/u),
      provider: "cloudflare",
      status: "warm",
    });
    expect(
      harness.read<{ createIdempotency: unknown }>(sessionHarnessKeys.actorMetadata)
        ?.createIdempotency,
    ).toEqual({
      keyDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(
      harness.writtenFiles.filter((file) => file.path.endsWith("/.pi-agent/initial-prompt")),
    ).toHaveLength(1);
    expect(sandboxConfig.addRepo).toHaveBeenCalledTimes(2);
  });

  it("preserves create idempotency for omitted/false newRepo and separates true", async () => {
    const harness = await routeHarness();
    useRealSandbox(harness);
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": "01234567-89ab-4cde-8fab-0123456789ab",
    };
    const first = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Ship project",
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/project",
        }),
      },
      env(),
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Ship project",
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/project",
          newRepo: false,
        }),
      },
      env(),
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual(await first.clone().json());
    const third = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Ship project",
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/project",
          newRepo: true,
        }),
      },
      env(),
    );
    expect(third.status).toBe(409);
    await expect(third.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("upserts the returned repository authority and best-effort projection", async () => {
    const trackedHarness = await routeHarness();
    useRealSandbox(trackedHarness);
    const put = vi.fn(async (_key: string, _value: string) => undefined);
    const tracked = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ship repository",
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/repo",
        }),
      },
      { ...env(), SESSIONS: Object.assign(env().SESSIONS, { put }) },
    );
    expect(tracked.status).toBe(200);
    expect(sandboxConfig.addRepo).toHaveBeenCalledWith({
      repo: "owner/repo",
      defaultBranch: "main",
    });
    expect(put).toHaveBeenCalledWith(
      "repo:owner/repo",
      expect.stringContaining(
        '"repo":"owner/repo","defaultBranch":"main","addedAt":"2026-08-15T12:00:00.000Z"',
      ),
    );

    put.mockImplementation(async (key: string) => {
      if (key === "repo:owner/repo") throw new RouteTestFailure("KV unavailable");
    });
    const unavailableHarness = await routeHarness();
    useRealSandbox(unavailableHarness);
    const unavailable = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ship repository",
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/repo",
        }),
      },
      { ...env(), SESSIONS: Object.assign(env().SESSIONS, { put }) },
    );
    expect(unavailable.status).toBe(200);
  });

  it("retries repository authority registration safely on an idempotent create replay", async () => {
    const harness = await routeHarness();
    useRealSandbox(harness);
    const entry = {
      repo: "owner/repo",
      defaultBranch: "main",
      addedAt: "2026-08-15T12:00:00.000Z",
      lastUsedAt: "2026-08-15T12:00:00.000Z",
    };
    sandboxConfig.addRepo
      .mockResolvedValueOnce({
        ok: false,
        error: { reason: "storage", message: "Repository authority unavailable" },
      })
      .mockResolvedValueOnce({ ok: true, value: entry });
    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "01234567-89ab-4cde-8fab-0123456789ab",
      },
      body: JSON.stringify({
        title: "Retry repository registration",
        prompt: "ship it",
        provider: "cloudflare",
        repo: "owner/repo",
      }),
    };
    const first = await app.request("/api/sessions", request, env());
    expect(first.status).toBe(500);
    expect(harness.readRecord()).toMatchObject({ status: "warm", repo: "owner/repo" });

    const second = await app.request("/api/sessions", request, env());
    expect(second.status).toBe(200);
    expect(sandboxConfig.addRepo).toHaveBeenCalledTimes(2);
    await expect(second.json()).resolves.toMatchObject({ status: "warm" });
  });

  it("requires the creation marker write before reporting create success", async () => {
    const harness = await routeHarness();
    useRealSandbox(harness);
    let releaseMarker = (): void => undefined;
    const markerRelease = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    let markerStarted = (): void => undefined;
    const markerStart = new Promise<void>((resolve) => {
      markerStarted = resolve;
    });
    const put = vi.fn(async (key: string) => {
      if (!key.startsWith("stats:workspace-created:")) return;
      markerStarted();
      await markerRelease;
    });
    let settled = false;
    const responsePromise = Promise.resolve(
      app.request(
        "/api/sessions",
        {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            title: "Track workspace",
            prompt: "ship it",
            provider: "cloudflare",
            repo: "owner/repo",
          }),
        },
        { ...env(), SESSIONS: Object.assign(env().SESSIONS, { put }) },
      ),
    ).then((response) => {
      settled = true;
      return response;
    });

    await markerStart;
    expect(harness.readRecord()?.status).toBe("warm");
    expect(settled).toBe(false);
    releaseMarker();
    expect((await responsePromise).status).toBe(200);
  });

  it("converges the same idempotent create after a marker write failure", async () => {
    const harness = await routeHarness();
    useRealSandbox(harness);
    const values = new Map<string, string>();
    let rejectMarker = true;
    const sessions = {
      ...emptySessionsNamespace(),
      put: async (key: string, value: string) => {
        if (key.startsWith("stats:workspace-created:") && rejectMarker) {
          rejectMarker = false;
          throw new RouteTestFailure("marker unavailable");
        }
        values.set(key, value);
      },
    } as KVNamespace;
    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "stats-marker-retry-0001",
      },
      body: JSON.stringify({
        title: "Track workspace",
        prompt: "ship it",
        provider: "cloudflare",
        repo: "owner/repo",
      }),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await app.request("/api/sessions", request, { ...env(), SESSIONS: sessions });
    expect(first.status).toBe(500);
    expect(harness.readRecord()?.status).toBe("warm");

    const second = await app.request("/api/sessions", request, { ...env(), SESSIONS: sessions });
    expect(second.status).toBe(200);
    const response = await second.json();
    if (!response || typeof response !== "object" || !("id" in response))
      throw new TypeError("Expected create response with id");
    const markerValue = values.get(`stats:workspace-created:${response.id}`);
    expect(markerValue).toBeDefined();
    expect(JSON.parse(markerValue ?? "null")).toEqual({
      sessionId: response.id,
      repository: "owner/repo",
      provider: "cloudflare",
      createdAt: harness.readRecord()?.createdAt,
    });
    expect(markerValue).not.toContain("Track workspace");
    expect(markerValue).not.toContain("ship it");
    expect(logged).toHaveBeenCalledWith("Projection failure", {
      tag: "StatsProjectionFailure",
      reason: "put",
    });
    logged.mockRestore();
  });

  it("rejects malformed create idempotency keys before touching a Sandbox", async () => {
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": "short",
        },
        body: JSON.stringify({ prompt: "ship it", repo: "owner/project" }),
      },
      env(),
    );
    expect(response.status).toBe(400);
    expect(sandbox.createScottySession).not.toHaveBeenCalled();
  });

  it("preserves exact malformed create error envelopes", async () => {
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{",
      },
      env(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "Request body must be valid JSON" },
    });
  });

  it("rejects unsupported providers at the HTTP boundary", async () => {
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ship project",
          prompt: "ship it",
          provider: "box",
          repo: "owner/project",
        }),
      },
      env(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "provider must be cloudflare or runner" },
    });
    expect(sandbox.createScottySession).not.toHaveBeenCalled();
  });

  it("serves authenticated no-store changed files and one encoded lazy patch", async () => {
    sandbox.listScottyChanges.mockResolvedValueOnce({
      files: [
        {
          path: "src/odd name.ts",
          status: "modified",
          staged: true,
          unstaged: true,
          additions: 2,
          deletions: 1,
          binary: false,
          patchable: true,
        },
      ],
      truncated: false,
    });
    const headers = { authorization: `Bearer ${TOKEN}` };

    const list = await app.request("/api/sessions/a0b1c2d3e4f5/changes", { headers }, env());
    const patch = await app.request(
      "/api/sessions/a0b1c2d3e4f5/changes/patch?path=src%2Fodd%20name.ts",
      { headers },
      env(),
    );

    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    await expect(list.json()).resolves.toMatchObject({
      files: [{ path: "src/odd name.ts", staged: true, unstaged: true }],
    });
    expect(patch.status).toBe(200);
    expect(patch.headers.get("cache-control")).toBe("private, no-store");
    expect(sandbox.getScottyChangedFilePatch).toHaveBeenCalledWith("src/odd name.ts");
  });

  it("rejects an invalid changed path before the Session DO", async () => {
    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/changes/patch?path=bad%00path",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "Changed file path is invalid" },
    });
    expect(sandbox.getScottyChangedFilePatch).not.toHaveBeenCalled();
  });

  it("does not expose a source-control publishing route", async () => {
    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/pr",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      },
      env(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });

  it("preserves beam-down streaming status, headers, and filename", async () => {
    sandbox.prepareDownArchive.mockResolvedValue({
      path: "/tmp/scotty-a0b1c2d3e4f5.tar",
      filename: "scotty-a0b1c2d3e4f5.tar",
      manifest: {},
    });
    sandbox.readScottyArchiveStream.mockResolvedValue(new Blob(["archive"]).stream());
    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/down",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="scotty-a0b1c2d3e4f5.tar"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("archive");
  });

  it("preserves 200 pass-through output for ordinary session command routes", async () => {
    const cases = [
      {
        method: "GET",
        path: "/api/sessions/a0b1c2d3e4f5",
        mock: sandbox.getScottySession,
        output: { id: "a0b1c2d3e4f5", status: "warm", ageSeconds: 1 },
      },
      {
        method: "POST",
        path: "/api/sessions/a0b1c2d3e4f5/snapshot",
        mock: sandbox.snapshotScottySession,
        output: { id: "a0b1c2d3e4f5", status: "warm", backupId: "backup-1" },
      },
      {
        method: "POST",
        path: "/api/sessions/a0b1c2d3e4f5/sleep",
        mock: sandbox.sleepScottySession,
        output: { id: "a0b1c2d3e4f5", status: "sleeping", backupId: "backup-1" },
      },
    ] as const;
    for (const entry of cases) {
      entry.mock.mockResolvedValueOnce(entry.output);
      const response = await app.request(
        entry.path,
        { method: entry.method, headers: { authorization: `Bearer ${TOKEN}` } },
        env(),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(entry.output);
    }
  });

  it("serves a sessions:read client a passive Pi snapshot without forwarding credentials or waking Pi", async () => {
    auth.authenticate.mockResolvedValueOnce({
      ok: true,
      value: {
        client: { ...REGISTERED_CLIENT, scopes: ["sessions:read"] },
        renewed: false,
      },
    });
    const snapshot = {
      epoch: "epoch-1",
      baseSequence: 1,
      sequence: 1,
      sessionRevision: 7,
      state: { isStreaming: false },
      messages: [{ role: "assistant", content: "done" }],
      overlapEvents: [],
      activeTools: [],
      queue: { steer: [], followUp: [] },
      pendingUi: [],
      pendingUiAuthority: {
        status: "partial",
        reason: "pi_0_83_signal_cancellation_unobservable",
      },
      extensionSurface: { statuses: {}, widgets: [] },
      capabilities: { models: [], thinkingLevels: [], commands: [] },
      truncated: { messages: false, values: false },
    };
    sandbox.fetch.mockImplementationOnce(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/_scotty/pi-console/snapshot");
      expect(request.method).toBe("GET");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
    });

    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/inspect",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(sandbox.fetch).toHaveBeenCalledOnce();
    expect(sandbox.preparePiSessionAccess).not.toHaveBeenCalled();
    expect(sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it("submits authenticated steer through a fresh passive snapshot without forwarding credentials", async () => {
    const snapshot = {
      epoch: "epoch-1",
      baseSequence: 3,
      sequence: 3,
      sessionRevision: 7,
      state: { isStreaming: true },
      messages: [],
      overlapEvents: [],
      activeTools: [],
      queue: { steer: [], followUp: [] },
      pendingUi: [],
      pendingUiAuthority: {
        status: "partial",
        reason: "pi_0_83_signal_cancellation_unobservable",
      },
      extensionSurface: { statuses: {}, widgets: [] },
      capabilities: { models: [], thinkingLevels: [], commands: [] },
      truncated: { messages: false, values: false },
    };
    const forwarded: Request[] = [];
    sandbox.fetch.mockImplementation(async (request: Request) => {
      forwarded.push(request.clone());
      if (forwarded.length === 1) return Response.json(snapshot);
      const command = await decodePiConsoleCommandPromise(await request.clone().json());
      return Response.json(
        {
          epoch: command.epoch,
          commandId: command.commandId,
          commandDigest: await commandIntentDigest(command.intent),
          status: "accepted",
          response: { success: true },
        },
        { status: 202 },
      );
    });

    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/steer",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "check the focused tests" }),
      },
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "a0b1c2d3e4f5",
      status: "accepted",
      epoch: "epoch-1",
      sessionRevision: 7,
    });
    expect(forwarded).toHaveLength(2);
    expect(new URL(forwarded[0].url).pathname).toBe("/_scotty/pi-console/snapshot");
    expect(forwarded[0].method).toBe("GET");
    expect(new URL(forwarded[1].url).pathname).toBe("/_scotty/pi-console/command");
    expect(forwarded[1].method).toBe("POST");
    expect(await forwarded[1].json()).toMatchObject({
      epoch: "epoch-1",
      expectedSessionRevision: 7,
      intent: {
        type: "prompt",
        message: "check the focused tests",
        streamingBehavior: "steer",
      },
    });
    for (const request of forwarded) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
    }
    expect(sandbox.preparePiSessionAccess).not.toHaveBeenCalled();
    expect(sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it("surfaces stale, unavailable, and ambiguous steer outcomes without retrying", async () => {
    const snapshot = {
      epoch: "epoch-1",
      baseSequence: 0,
      sequence: 0,
      sessionRevision: 7,
      state: { isStreaming: false },
      messages: [],
      overlapEvents: [],
      activeTools: [],
      queue: { steer: [], followUp: [] },
      pendingUi: [],
      pendingUiAuthority: {
        status: "partial",
        reason: "pi_0_83_signal_cancellation_unobservable",
      },
      extensionSurface: { statuses: {}, widgets: [] },
      capabilities: { models: [], thinkingLevels: [], commands: [] },
      truncated: { messages: false, values: false },
    };
    const cases = [
      {
        command: Response.json(
          {
            status: "stale",
            expectedSessionRevision: 7,
            sessionRevision: 8,
            retryable: false,
          },
          { status: 409 },
        ),
        expected: {
          status: "stale",
          reason: "session_revision_changed",
          expectedSessionRevision: 7,
          sessionRevision: 8,
          retryable: false,
        },
      },
      {
        snapshot: Response.json(
          {
            status: "unavailable",
            reason: "session_operation_active",
            retryable: false,
          },
          { status: 409 },
        ),
        expected: {
          status: "unavailable",
          reason: "session_operation_active",
          retryable: false,
        },
      },
      {
        command: Response.json({ accepted: true }, { status: 202 }),
        expected: { status: "ambiguous", reason: "command_receipt_mismatch" },
      },
    ] as const;

    for (const testCase of cases) {
      sandbox.fetch.mockReset();
      if ("snapshot" in testCase) sandbox.fetch.mockResolvedValueOnce(testCase.snapshot);
      else {
        sandbox.fetch.mockResolvedValueOnce(Response.json(snapshot));
        sandbox.fetch.mockResolvedValueOnce(testCase.command);
      }
      const response = await app.request(
        "/api/sessions/a0b1c2d3e4f5/steer",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: "continue" }),
        },
        env(),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        id: "a0b1c2d3e4f5",
        ...testCase.expected,
      });
      expect(sandbox.fetch).toHaveBeenCalledTimes("snapshot" in testCase ? 1 : 2);
    }
  });

  it("requires sessions:write and strictly bounds steer input before passive access", async () => {
    auth.authenticate.mockResolvedValueOnce({
      ok: true,
      value: {
        client: { ...REGISTERED_CLIENT, scopes: ["sessions:read"] },
        renewed: false,
      },
    });
    const forbidden = await app.request(
      "/api/sessions/a0b1c2d3e4f5/steer",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "continue" }),
      },
      env(),
    );
    expect(forbidden.status).toBe(401);
    expect(sandbox.fetch).not.toHaveBeenCalled();

    for (const body of [{ message: "  " }, { message: "/help" }, { message: "ok", extra: true }]) {
      const response = await app.request(
        "/api/sessions/a0b1c2d3e4f5/steer",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        env(),
      );
      expect(response.status).toBe(400);
    }
    const oversized = await app.request(
      "/api/sessions/a0b1c2d3e4f5/steer",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "é".repeat(8_193) }),
      },
      env(),
    );
    expect(oversized.status).toBe(400);
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("keeps passive inspect failures in the public Worker error envelope", async () => {
    for (const [status, code, message] of [
      [409, "wrong_state", "Session is not available for inspection"],
      [503, "upstream", "Pi snapshot is unavailable"],
    ] as const) {
      sandbox.fetch.mockResolvedValueOnce(
        Response.json({ status: "unavailable", retryable: false }, { status }),
      );
      const response = await app.request(
        "/api/sessions/a0b1c2d3e4f5/inspect",
        { headers: { authorization: `Bearer ${TOKEN}` } },
        env(),
      );
      expect(response.status).toBe(status === 409 ? 409 : 502);
      await expect(response.json()).resolves.toMatchObject({ error: { code, message } });
    }
    sandbox.fetch.mockRejectedValueOnce(new TypeError("passive target unavailable"));
    const unavailable = await app.request(
      "/api/sessions/a0b1c2d3e4f5/inspect",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(unavailable.status).toBe(502);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "upstream", message: "Pi snapshot is unavailable" },
    });
    expect(sandbox.preparePiSessionAccess).not.toHaveBeenCalled();
    expect(sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it("renames a session through the authenticated JSON boundary", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.actorFixtureSession]: makeSessionRecord({
          id: SESSION_ID,
          title: "Old title",
        }),
      },
    });
    useRealSandbox(harness);
    const response = await app.request(
      `/api/sessions/${SESSION_ID}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "  Package Pi extensions  " }),
      },
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: SESSION_ID,
      title: "Package Pi extensions",
      status: "warm",
    });
    expect(harness.readRecord()).toMatchObject({
      id: SESSION_ID,
      title: "Package Pi extensions",
      status: "warm",
    });
    expect(harness.events).toContain("projection:warm");
  });

  it("reads validated actor authority and journal evidence through the authenticated boundary", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    useRealSandbox(harness);

    const response = await app.request(
      `/api/sessions/${SESSION_ID}/actor`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authority: { session: { id: SESSION_ID }, state: { _tag: "Stable" } },
      journalTruncated: false,
    });
  });

  it("resumes through real restore, credential, runtime, and state orchestration", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.sleepScottySession();
    useRealSandbox(harness);

    const response = await app.request(
      `/api/sessions/${SESSION_ID}/resume`,
      { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: SESSION_ID,
      status: "warm",
      branch: `scotty/${SESSION_ID}`,
      backupId: "backup-1",
    });
    expect(harness.readRecord()).toMatchObject({ status: "warm", operation: null });
    expect(harness.events).toEqual(
      expect.arrayContaining([
        "schedule:sessionActorHardCap",
        "host:restoreBackup",
        "host:mkdir",
        "host:writeFile",
        "host:setEnvVars",
        "projection:warm",
      ]),
    );
  });

  it("vaporizes through real destruction, grant release, and authority transition", async () => {
    const harness = await createSessionHarness({
      rawPiContainerRunning: true,
      initialEntries: {
        [sessionHarnessKeys.actorFixtureSession]: makeSessionRecord({
          id: SESSION_ID,
          branch: `scotty/${SESSION_ID}`,
        }),
      },
      initialProjections: {
        [`stats:workspace-created:${SESSION_ID}`]: {
          sessionId: SESSION_ID,
          repository: "owner/project",
          provider: "cloudflare",
          createdAt: "2026-07-29T10:00:00.000Z",
        },
      },
    });
    useRealSandbox(harness);

    const response = await app.request(
      `/api/sessions/${SESSION_ID}`,
      { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: SESSION_ID, status: "gone" });
    expect(harness.read(sessionHarnessKeys.actorAuthority)).toMatchObject({
      session: { id: SESSION_ID },
      state: { _tag: "Stable", stable: { _tag: "Gone" } },
    });
    expect(harness.events).toEqual(
      expect.arrayContaining([
        "schedule:sessionActorDeadline",
        "host:destroy",
        `projection:delete:session:${SESSION_ID}`,
      ]),
    );
    expect(harness.credentialGrantReleases).toEqual([]);
    expect(harness.events).not.toContain(`projection:delete:stats:workspace-created:${SESSION_ID}`);
  });

  it("lists only fully decoded KV projections and preserves valid optional fields", async () => {
    const values = new Map<string, unknown>([
      [`session:${projection.id}`, projection],
      ["session:malformed", { ...projection, id: "malformed", backupId: 123 }],
    ]);
    const sessions = {
      list: async () => ({
        keys: [{ name: `session:${projection.id}` }, { name: "session:malformed" }],
        list_complete: true,
        cacheStatus: null,
      }),
      get: async (name: string) => values.get(name) ?? null,
    } as KVNamespace;
    const response = await app.request(
      "/api/sessions",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    if (!Array.isArray(body)) throw new TypeError("Expected session list array");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: projection.id,
      backupId: projection.backupId,
      codexThreadId: projection.codexThreadId,
      failure: projection.failure,
    });
    expect(body[0]).not.toHaveProperty("secret");
  });

  it("serves authenticated creation stats joined to current session statuses", async () => {
    const values = new Map<string, unknown>([
      [
        "stats:workspace-created:a0b1c2d3e4f5",
        {
          sessionId: "a0b1c2d3e4f5",
          repository: "owner/project",
          provider: "cloudflare",
          createdAt: "2026-07-28T10:00:00.000Z",
        },
      ],
      [
        "stats:workspace-created:b0b1c2d3e4f5",
        {
          sessionId: "b0b1c2d3e4f5",
          repository: "owner/project",
          provider: "cloudflare",
          createdAt: "2026-07-29T10:00:00.000Z",
        },
      ],
      ["session:a0b1c2d3e4f5", { ...projection, id: "a0b1c2d3e4f5", status: "warm" }],
      ["session:b0b1c2d3e4f5", { ...projection, id: "b0b1c2d3e4f5", status: "sleeping" }],
    ]);
    const sessions = {
      ...emptySessionsNamespace(),
      list: async (options?: { readonly prefix?: string }) => ({
        keys: [...values.keys()]
          .filter((name) => name.startsWith(options?.prefix ?? ""))
          .map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }),
      get: async (name: string) => values.get(name) ?? null,
    } as KVNamespace;

    const unauthorized = await app.request("/api/stats", undefined, {
      ...env(),
      SESSIONS: sessions,
    });
    expect(unauthorized.status).toBe(401);

    const response = await app.request(
      "/api/stats",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      trackingSince: "2026-07-28T10:00:00.000Z",
      overall: { workspacesCreated: 2, projects: 1, warmNow: 1, sleepingNow: 1 },
      projects: [
        {
          repository: "owner/project",
          workspacesCreated: 2,
          warmNow: 1,
          sleepingNow: 1,
          lastCreated: "2026-07-29T10:00:00.000Z",
        },
      ],
    });
  });

  it("lists authoritative repositories and repairs a stale projection", async () => {
    const repositories = [
      {
        repo: "owner/newer",
        defaultBranch: "dev",
        addedAt: "2026-07-20T12:00:00.000Z",
        lastUsedAt: "2026-07-23T12:00:00.000Z",
      },
      {
        repo: "owner/older",
        defaultBranch: "main",
        addedAt: "2026-07-19T12:00:00.000Z",
        lastUsedAt: "2026-07-22T12:00:00.000Z",
      },
    ];
    sandboxConfig.listRepos.mockResolvedValue({ ok: true, value: repositories });
    const values = new Map<string, unknown>([
      [
        "repo:owner/older",
        {
          repo: "owner/older",
          defaultBranch: "main",
          lastUsedAt: "2026-07-22T12:00:00.000Z",
          secret: "must-not-survive",
        },
      ],
      [
        "repo:owner/newer",
        {
          repo: "owner/newer",
          defaultBranch: "dev",
          lastUsedAt: "2026-07-23T12:00:00.000Z",
        },
      ],
      [
        "repo:owner/malformed",
        {
          repo: "owner/malformed",
          defaultBranch: 123,
          lastUsedAt: "2026-07-23T13:00:00.000Z",
        },
      ],
    ]);
    const put = vi.fn(async (name: string, value: string) => {
      values.set(name, JSON.parse(value));
    });
    const deleteKey = vi.fn(async (name: string) => {
      values.delete(name);
    });
    const sessions = {
      ...emptySessionsNamespace(values),
      list: async () => ({
        keys: [...values.keys()].map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }),
      put,
      delete: deleteKey,
    } as KVNamespace;

    const response = await app.request(
      "/api/repos",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([repositories[0], repositories[1]]);
    expect(sandboxConfig.listRepos).toHaveBeenCalledTimes(1);
    expect(deleteKey).toHaveBeenCalledWith("repo:owner/older");
    expect(deleteKey).toHaveBeenCalledWith("repo:owner/newer");
    expect(deleteKey).toHaveBeenCalledWith("repo:owner/malformed");
    expect(put).toHaveBeenCalledWith("repo:owner/newer", JSON.stringify({ ...repositories[0] }));
    expect(put).toHaveBeenCalledWith("repo:owner/older", JSON.stringify({ ...repositories[1] }));
    const putCountAfterRepair = put.mock.calls.length;
    const deleteCountAfterRepair = deleteKey.mock.calls.length;
    const matching = await app.request(
      "/api/repos",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(matching.status).toBe(200);
    expect(put).toHaveBeenCalledTimes(putCountAfterRepair);
    expect(deleteKey).toHaveBeenCalledTimes(deleteCountAfterRepair);
  });

  it("verifies a repository through GitHub before adding authority", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ default_branch: "trunk" }, { status: 200 }));
    const entry = {
      repo: "owner/project",
      defaultBranch: "trunk",
      addedAt: "2026-08-15T12:00:00.000Z",
      lastUsedAt: "2026-08-15T12:00:00.000Z",
    };
    sandboxConfig.addRepo.mockResolvedValue({ ok: true, value: entry });

    const response = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ repo: "owner/project" }),
      },
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.clone().text()).resolves.not.toContain("test-github-token");
    await expect(response.json()).resolves.toEqual(entry);
    expect(credentialRegistry.resolveGithubCliCredential).toHaveBeenCalledWith({
      repository: "owner/project",
    });
    expect(sandboxConfig.addRepo).toHaveBeenCalledWith({
      repo: "owner/project",
      defaultBranch: "trunk",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]?.[0];
    expect(request instanceof Request ? request.url : String(request)).toBe(
      "https://api.github.com/repos/owner/project",
    );
  });

  it("does not register a repository when GitHub verification fails", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    const put = vi.fn(async (_key: string, _value: string) => undefined);

    const response = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ repo: "owner/missing" }),
      },
      { ...env(), SESSIONS: Object.assign(env().SESSIONS, { put }) },
    );

    expect(response.status).toBe(404);
    expect(sandboxConfig.addRepo).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalledWith("repo:owner/missing", expect.any(String));
    fetch.mockResolvedValue(new Response(null, { status: 503 }));
    const upstream = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ repo: "owner/unavailable" }),
      },
      { ...env(), SESSIONS: Object.assign(env().SESSIONS, { put }) },
    );
    expect(upstream.status).toBe(502);
    expect(sandboxConfig.addRepo).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalledWith("repo:owner/unavailable", expect.any(String));
    fetch.mockRestore();
  });

  it("does not mutate the projection when repository authority removal fails", async () => {
    sandboxConfig.removeRepo.mockResolvedValueOnce({
      ok: false,
      error: { reason: "storage", message: "Repository authority unavailable" },
    });
    const deleteKey = vi.fn(async (_name: string) => undefined);
    const sessions = {
      ...emptySessionsNamespace(),
      list: async () => ({
        keys: [{ name: "repo:owner/project" }],
        list_complete: true,
        cacheStatus: null,
      }),
      delete: deleteKey,
    } as KVNamespace;

    const response = await app.request(
      "/api/repos/owner/project",
      { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(response.status).toBe(500);
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("preserves the generic internal response for provider-level KV list failure", async () => {
    const sessions = {
      list: async () => Promise.reject("list failed"),
    } as KVNamespace;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app.request(
      "/api/sessions",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal", message: "Internal error" },
    });
    expect(logged).toHaveBeenCalledWith("Projection failure", {
      tag: "SessionProjectionFailure",
      reason: "list",
    });
    logged.mockRestore();
  });

  it("consumes a same-origin one-time pairing link into a browser-specific cookie", async () => {
    const credential = "scotty_client.222222222222.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const client = {
      ...REGISTERED_CLIENT,
      id: "222222222222",
      label: "My phone",
      scopes: ["sessions:read", "sessions:write"],
    };
    auth.consumePairing.mockResolvedValue({
      ok: true,
      value: { credential, client },
    });
    const missingOrigin = await app.request(
      "/api/auth/pairings/consume",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "one-time-ticket", label: "My phone" }),
      },
      env(),
    );
    expect(missingOrigin.status).toBe(400);
    expect(auth.consumePairing).not.toHaveBeenCalled();

    const response = await app.request(
      "/api/auth/pairings/consume",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "user-agent": "Phone browser",
        },
        body: JSON.stringify({ token: "one-time-ticket", label: "My phone" }),
      },
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ client });
    expect(auth.consumePairing).toHaveBeenCalledWith(
      "one-time-ticket",
      "My phone",
      "Phone browser",
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`__Host-scotty=${credential}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain(TOKEN);
  });

  it("issues recovery only from the root bearer and consumes it only from this origin", async () => {
    const recoveryCredential =
      "scotty_recovery.222222222222.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    auth.issueRecoveryGrant.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "222222222222",
        credential: recoveryCredential,
        expiresAt: "2026-07-22T12:05:00.000Z",
      },
    });
    const issued = await app.request(
      "/api/auth/recovery-grants",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "idempotency-key": "recovery-test-key-0001",
        },
      },
      env(),
    );
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const issuedBody = await issued.json();
    expect(issuedBody).toEqual({
      url: `http://localhost/recover#token=${recoveryCredential}`,
      expiresAt: "2026-07-22T12:05:00.000Z",
    });
    expect(auth.issueRecoveryGrant).toHaveBeenCalledWith(TOKEN, "recovery-test-key-0001");
    expect(JSON.stringify(issuedBody)).not.toContain(TOKEN);

    const deniedCookie = await app.request(
      "/api/auth/recovery-grants",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
        },
      },
      env(),
    );
    expect(deniedCookie.status).toBe(401);
    expect(auth.issueRecoveryGrant).toHaveBeenCalledTimes(1);

    const recoveredCredential =
      "scotty_client.333333333333.ccccccccccccccccccccccccccccccccccccccccccc";
    const recoveredClient = {
      ...REGISTERED_CLIENT,
      id: "333333333333",
      label: "Recovered browser",
    };
    auth.consumeRecoveryGrant.mockResolvedValueOnce({
      ok: true,
      value: { credential: recoveredCredential, client: recoveredClient },
    });
    const missingOrigin = await app.request(
      "/api/auth/recovery-grants/consume",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: recoveryCredential }),
      },
      env(),
    );
    expect(missingOrigin.status).toBe(400);
    expect(missingOrigin.headers.get("cache-control")).toBe("no-store");
    expect(auth.consumeRecoveryGrant).not.toHaveBeenCalled();

    const consumed = await app.request(
      "/api/auth/recovery-grants/consume",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "user-agent": "Replacement browser",
        },
        body: JSON.stringify({ token: recoveryCredential }),
      },
      env(),
    );
    expect(consumed.status).toBe(200);
    expect(auth.consumeRecoveryGrant).toHaveBeenCalledWith(
      recoveryCredential,
      "Trusted browser",
      "Replacement browser",
    );
    expect(consumed.headers.get("set-cookie")).toContain(`__Host-scotty=${recoveredCredential}`);
    expect(consumed.headers.get("set-cookie")).not.toContain(TOKEN);
  });

  it("issues scannable pairing links and manages registered clients only for the owner", async () => {
    const pairingCredential =
      "scotty_pair.333333333333.ccccccccccccccccccccccccccccccccccccccccccc";
    auth.issuePairing.mockResolvedValue({
      ok: true,
      value: {
        id: "333333333333",
        credential: pairingCredential,
        expiresAt: "2026-07-22T12:05:00.000Z",
      },
    });
    const issued = await app.request(
      "/api/auth/pairings",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "Phone" }),
      },
      env(),
    );
    expect(issued.status).toBe(200);
    expect(auth.issuePairing).toHaveBeenCalledWith(CLIENT_CREDENTIAL, "Phone");
    const body = await issued.json();
    expect(body).toMatchObject({
      id: "333333333333",
      url: `http://localhost/pair#token=${pairingCredential}`,
      expiresAt: "2026-07-22T12:05:00.000Z",
      qr: { size: expect.any(Number), rows: expect.any(Array) },
    });
    if (!body || typeof body !== "object" || !("qr" in body))
      throw new TypeError("Expected pairing QR response");
    const qr = body.qr;
    if (
      !qr ||
      typeof qr !== "object" ||
      !("rows" in qr) ||
      !Array.isArray(qr.rows) ||
      !("size" in qr) ||
      typeof qr.size !== "number"
    )
      throw new TypeError("Expected pairing QR matrix");
    expect(qr.rows).toHaveLength(qr.size);

    auth.listClients.mockResolvedValue({ ok: true, value: [REGISTERED_CLIENT] });
    const listed = await app.request(
      "/api/auth/clients",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(listed.status).toBe(200);
    expect(auth.listClients).toHaveBeenCalledWith(CLIENT_CREDENTIAL);

    auth.revokeClient.mockResolvedValue({ ok: true, value: undefined });
    const revoked = await app.request(
      "/api/auth/clients/222222222222",
      {
        method: "DELETE",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
        },
      },
      env(),
    );
    expect(revoked.status).toBe(200);
    expect(auth.revokeClient).toHaveBeenCalledWith(CLIENT_CREDENTIAL, "222222222222");
  });

  it("does not let a standard paired browser manage owner control pages", async () => {
    const standard = {
      ...REGISTERED_CLIENT,
      scopes: ["sessions:read", "sessions:write"],
      role: "standard",
    };
    auth.authenticate.mockResolvedValue({
      ok: true,
      value: { client: standard, renewed: false },
    });
    const denied = await app.request(
      "/api/auth/clients",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(denied.status).toBe(401);
    expect(auth.listClients).not.toHaveBeenCalled();
    for (const path of ["/devices", "/providers"]) {
      const page = await app.request(
        path,
        { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
        env(),
      );
      expect(page.status, path).toBe(401);
    }
  });

  it("binds owner transfer issuance to the owner and acceptance to the target cookie", async () => {
    const transferCredential =
      "scotty_transfer.333333333333.ccccccccccccccccccccccccccccccccccccccccccc";
    auth.startOwnerTransfer.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "333333333333",
        credential: transferCredential,
        transfer: {
          id: "333333333333",
          sourceOwnerClientId: REGISTERED_CLIENT.id,
          targetClientId: "222222222222",
          ownerEpoch: 7,
          createdAt: "2026-07-22T12:00:00.000Z",
          expiresAt: "2026-07-22T12:05:00.000Z",
        },
      },
    });
    const started = await app.request(
      "/api/auth/owner-transfers",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "content-type": "application/json",
          "idempotency-key": "transfer-test-key-0001",
        },
        body: JSON.stringify({ targetClientId: "222222222222" }),
      },
      env(),
    );
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    const startBody = await started.json();
    expect(startBody).toMatchObject({
      targetClientId: "222222222222",
      url: `http://localhost/owner-transfer#token=${transferCredential}`,
      qr: { size: expect.any(Number), rows: expect.any(Array) },
    });
    expect(auth.startOwnerTransfer).toHaveBeenCalledWith(
      CLIENT_CREDENTIAL,
      "222222222222",
      "transfer-test-key-0001",
    );

    const missingTargetCookie = await app.request(
      "/api/auth/owner-transfers/accept",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: transferCredential }),
      },
      env(),
    );
    expect(missingTargetCookie.status).toBe(401);
    await expect(missingTargetCookie.json()).resolves.toEqual({
      error: {
        code: "auth",
        message: "Owner transfer is invalid or expired",
      },
    });

    const rotatedCredential =
      "scotty_client.222222222222.ddddddddddddddddddddddddddddddddddddddddddd";
    const newOwner = {
      ...REGISTERED_CLIENT,
      id: "222222222222",
      label: "New laptop",
    };
    auth.acceptOwnerTransfer.mockResolvedValueOnce({
      ok: true,
      value: { credential: rotatedCredential, client: newOwner },
    });
    const accepted = await app.request(
      "/api/auth/owner-transfers/accept",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: transferCredential }),
      },
      env(),
    );
    expect(accepted.status).toBe(200);
    expect(auth.acceptOwnerTransfer).toHaveBeenCalledWith(CLIENT_CREDENTIAL, transferCredential);
    expect(accepted.headers.get("set-cookie")).toContain(`__Host-scotty=${rotatedCredential}`);
    expect(await accepted.clone().text()).not.toContain(transferCredential);
  });

  it("rejects every owner route for a standard client", async () => {
    auth.authenticate.mockResolvedValue({
      ok: true,
      value: {
        client: {
          ...REGISTERED_CLIENT,
          role: "standard",
          scopes: ["sessions:read", "sessions:write"],
        },
        renewed: false,
      },
    });
    const requests: ReadonlyArray<readonly [string, RequestInit]> = [
      ["/api/auth/clients", {}],
      ["/api/auth/owner-transfers/current", {}],
      [
        "/api/auth/pairings",
        {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
          },
          body: "{}",
        },
      ],
      [
        "/api/auth/owner-transfers",
        {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({ targetClientId: "222222222222" }),
        },
      ],
      [
        "/api/auth/clients/222222222222",
        {
          method: "DELETE",
          headers: { origin: "http://localhost" },
        },
      ],
      [
        "/api/auth/owner-transfers/333333333333",
        {
          method: "DELETE",
          headers: { origin: "http://localhost" },
        },
      ],
    ];
    for (const [path, init] of requests) {
      const response = await app.request(
        path,
        {
          ...init,
          headers: {
            cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
            ...init.headers,
          },
        },
        env(),
      );
      expect(response.status, path).toBe(401);
    }
    expect(auth.issuePairing).not.toHaveBeenCalled();
    expect(auth.startOwnerTransfer).not.toHaveBeenCalled();
    expect(auth.revokeClient).not.toHaveBeenCalled();
    expect(auth.cancelOwnerTransfer).not.toHaveBeenCalled();
  });

  it("rejects unsafe cookie mutations before owner commands without exact origin metadata", async () => {
    auth.logoutClient.mockResolvedValue({ ok: true, value: undefined });
    const missingOrigin = await app.request(
      "/api/auth/logout",
      {
        method: "POST",
        headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` },
      },
      env(),
    );
    expect(missingOrigin.status).toBe(400);
    expect(auth.logoutClient).not.toHaveBeenCalled();

    const crossSite = await app.request(
      "/api/auth/logout",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "cross-site",
        },
      },
      env(),
    );
    expect(crossSite.status).toBe(400);
    expect(auth.logoutClient).not.toHaveBeenCalled();
  });

  it("rejects the root token in query parameters and cookies", async () => {
    const response = await app.request(`/s/a0b1c2d3e4f5?t=${TOKEN}`, undefined, env());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();

    const rootCookie = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${TOKEN}` } },
      env(),
    );
    expect(rootCookie.status).toBe(401);
    expect(rootCookie.headers.get("set-cookie")).toBeNull();

    const apiQuery = await app.request(
      `/api/sessions?t=${TOKEN}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(apiQuery.status).toBe(401);
    expect(apiQuery.headers.get("cache-control")).toBe("no-store");
    const apiRootCookie = await app.request(
      "/api/sessions",
      { headers: { cookie: `__Host-scotty=${TOKEN}` } },
      env(),
    );
    expect(apiRootCookie.status).toBe(401);
  });

  it("serves the secure locked page for unauthenticated browser entry routes", async () => {
    const assetPaths: string[] = [];
    const assets = {
      fetch: async (request: Request) => {
        assetPaths.push(new URL(request.url).pathname);
        return new Response("<!doctype html><title>Browser access locked · Scotty</title>", {
          headers: { "content-type": "text/html" },
        });
      },
      connect: () => {
        throw new RouteTestFailure("ASSETS.connect isn't used by route tests");
      },
    } as Fetcher;

    for (const path of ["/", "/sessions"]) {
      const response = await app.request(path, undefined, env({ assets }));
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain("Browser access locked");
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("content-security-policy"), path).toContain("default-src 'none'");
      expect(response.headers.get("content-security-policy"), path).toContain("form-action 'none'");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("set-cookie"), path).toBeNull();
    }
    expect(assetPaths).toEqual(["/auth/locked.html", "/auth/locked.html"]);
  });

  it("serves the session shell for Cloudflare sessions with registered-client cookies", async () => {
    const assetPaths: string[] = [];
    const assets = {
      fetch: async (request: Request) => {
        assetPaths.push(new URL(request.url).pathname);
        return new Response("<!doctype html><title>Scotty</title>", {
          headers: { "content-type": "text/html" },
        });
      },
      connect: () => {
        throw new RouteTestFailure("ASSETS.connect isn't used by route tests");
      },
    } as Fetcher;
    const response = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      { ...env({ assets }), SCOTTY_PREVIEW_BASE: "preview.example.test" },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Scotty</title>");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action https://*.preview.example.test",
    );
    expect(response.headers.get("content-security-policy")).not.toContain("form-action 'none'");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(sandbox.fetch).not.toHaveBeenCalled();
    expect(assetPaths[0]).toBe("/session/index.html");

    const sessions = await app.request(
      "/sessions",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(sessions.status).toBe(200);
    expect(sessions.headers.get("cache-control")).toBe("no-store");
    expect(sessions.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const stats = await app.request(
      "/stats",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(stats.status).toBe(200);
    expect(stats.headers.get("cache-control")).toBe("no-store");

    const rootBearer = await app.request(
      "/sessions",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(rootBearer.status).toBe(401);

    const sessionRootBearer = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(sessionRootBearer.status).toBe(401);
  });

  it("shows fake-backed failed evidence frames through authenticated polling", async () => {
    const harness = await createSessionHarness({
      evidenceEnabled: true,
      rawPiContainerRunning: true,
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const accepted = await harness.sandbox.acceptScottyEvidenceJob({
      port: 4_173,
      viewport: { width: 1_280, height: 720 },
      capture: { screenshots: "after-each-step", video: false },
      steps: [
        {
          name: "Open the app",
          action: { kind: "goto", path: "/" },
          expect: [{ kind: "urlPath", expected: "/" }],
        },
        {
          name: "Shows the ready state",
          action: {
            kind: "fill",
            locator: { kind: "testId", value: "status" },
            value: "private-fill-value",
          },
          expect: [
            {
              kind: "textExact",
              locator: { kind: "testId", value: "status" },
              expected: "Ready",
            },
          ],
        },
      ],
    });
    await harness.sandbox.completeScottyEvidenceStep(accepted.operationNonce, {
      index: 0,
      startedAt: "2026-08-06T12:00:00.100Z",
      completedAt: "2026-08-06T12:00:01.000Z",
      offsetMillis: 1_000,
      assertions: [{ kind: "urlPath", passed: true, expected: "/", actual: "/" }],
      frame: {
        frameId: "frame-1",
        bytes: evidencePng,
        capturedAt: "2026-08-06T12:00:01.000Z",
        offsetMillis: 1_000,
      },
    });
    await harness.sandbox.completeScottyEvidenceStep(accepted.operationNonce, {
      index: 1,
      startedAt: "2026-08-06T12:00:01.100Z",
      completedAt: "2026-08-06T12:00:02.000Z",
      offsetMillis: 2_000,
      assertions: [
        {
          kind: "textExact",
          passed: false,
          expected: "Ready",
          actual: "undeclared page text",
        },
      ],
      frame: {
        frameId: "frame-2",
        bytes: evidencePng,
        capturedAt: "2026-08-06T12:00:02.000Z",
        offsetMillis: 2_000,
      },
    });
    const failedSummary = await harness.sandbox.finalizeScottyEvidenceJob(
      accepted.operationNonce,
      "succeeded",
    );
    const internalState = harness.read<EvidenceState>(sessionHarnessKeys.evidence);
    expect(internalState).toBeDefined();
    if (internalState === undefined) return;
    harness.memory.values.set(sessionHarnessKeys.evidence, {
      ...internalState,
      jobs: internalState.jobs.map((summary) =>
        summary.jobId === failedSummary.jobId
          ? {
              ...summary,
              diagnostic: {
                operation: "screenshot",
                reason: "ambiguous",
                step: 1,
              },
            }
          : summary,
      ),
    } satisfies EvidenceState);
    useRealSandbox(harness);
    const firstFrame = failedSummary.steps[0]?.frame;
    expect(firstFrame).toBeDefined();
    const testEnv = env({
      assets: evidenceAssets(),
      artifactBucket: evidenceArtifactBucket(accepted.jobId, firstFrame?.sha256 ?? ""),
    });
    const headers = { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` };
    const summaryPath = `/api/sessions/${SESSION_ID}/evidence/${accepted.jobId}`;
    const detailPath = `/s/${SESSION_ID}/evidence/${accepted.jobId}`;
    const framePath = (frameId: string) =>
      `${detailPath}/frames/${encodeURIComponent(frameId)}.png`;

    const denied = await app.request(summaryPath, undefined, testEnv);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");

    const rootBearer = await app.request(
      `/api/sessions/${SESSION_ID}/evidence/${accepted.jobId}`,
      { headers: { ...headers, authorization: `Bearer ${TOKEN}` } },
      testEnv,
    );
    expect(rootBearer.status).toBe(401);

    const list = await app.request("/api/sessions/a0b1c2d3e4f5/evidence", { headers }, testEnv);
    expect(list.status).toBe(200);
    const listBody: unknown = await list.json();
    expect(listBody).toMatchObject([{ jobId: accepted.jobId, status: "failed" }]);

    const summary = await app.request(summaryPath, { headers }, testEnv);
    expect(summary.status).toBe(200);
    expect(summary.headers.get("cache-control")).toBe("private, no-store");
    const summaryBody: unknown = await summary.json();
    expect(summaryBody).toMatchObject({
      status: "failed",
      frameCount: 2,
      failure: { code: "assertion_mismatch", step: 1 },
    });
    const serializedSummary = JSON.stringify(summaryBody);
    expect(serializedSummary).not.toContain("objectKey");
    expect(serializedSummary).not.toContain("private-fill-value");
    expect(serializedSummary).not.toContain("undeclared page text");
    expect(serializedSummary).not.toContain('"actual"');
    expect(serializedSummary).not.toContain("diagnostic");
    expect(orderedEvidenceFrames(summaryBody).map((frame) => frame.frameId)).toEqual([
      "frame-1",
      "frame-2",
    ]);

    const missingJob = await app.request(
      `/api/sessions/${SESSION_ID}/evidence/not-owned`,
      { headers },
      testEnv,
    );
    expect(missingJob.status).toBe(404);
    expect(missingJob.headers.get("cache-control")).toBe("private, no-store");

    const shell = await app.request(detailPath, { headers }, testEnv);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("private, no-store");
    expect(await shell.text()).toContain("<title>Scotty evidence</title>");
    expect(evidenceScript).toContain('setAttribute("aria-label", "Verified screenshots")');
    expect(evidenceScript).toContain("setTimeout(() => void refresh(), POLL_INTERVAL)");
    expect(evidenceScript).toContain("orderedEvidenceFrames(summary)");

    const missingFrame = await app.request(
      `/s/${SESSION_ID}/evidence/${accepted.jobId}/frames/not-owned.png`,
      { headers },
      testEnv,
    );
    expect(missingFrame.status).toBe(404);
    expect(missingFrame.headers.get("cache-control")).toBe("private, no-store");

    const firstFramePath = framePath("frame-1");
    const frame = await app.request(firstFramePath, { headers }, testEnv);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/png");
    expect(frame.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await frame.arrayBuffer())).toEqual(evidencePng);

    const failedFramePath = framePath("frame-2");
    const failedFrame = await app.request(failedFramePath, { headers }, testEnv);
    expect(failedFrame.status).toBe(200);
    expect(failedFrame.headers.get("content-type")).toBe("image/png");
    expect(failedFrame.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await failedFrame.arrayBuffer())).toEqual(evidencePng);
  });

  it("serves a private matched Showcase and its real WebM recording", async () => {
    const sha256 = "b".repeat(64);
    const summary = (jobId: string, recordVideo: boolean) => ({
      sequence: recordVideo ? 1 : 0,
      jobId,
      status: "succeeded" as const,
      acceptedAt: "2026-08-06T12:00:00.000Z",
      completedAt: "2026-08-06T12:00:01.000Z",
      totalSteps: 1,
      completedSteps: 1,
      viewport: { width: 1_280, height: 720 },
      recordVideo,
      flowHash: "a".repeat(64),
      ...(recordVideo
        ? {
            video: {
              artifactId: "recording" as const,
              sha256,
              bytes: evidenceWebm.byteLength,
              capturedAt: "2026-08-06T12:00:01.000Z",
              offsetMillis: 1_000,
            },
          }
        : {}),
      steps: [
        {
          index: 0,
          name: "Open the app",
          action: "goto" as const,
          status: "passed" as const,
          assertions: [{ kind: "urlPath" as const, passed: true }],
          startedAt: "2026-08-06T12:00:00.000Z",
          completedAt: "2026-08-06T12:00:01.000Z",
          offsetMillis: 1_000,
          frame: {
            frameId: "frame-1",
            sha256: "c".repeat(64),
            bytes: evidencePng.byteLength,
            capturedAt: "2026-08-06T12:00:01.000Z",
            offsetMillis: 1_000,
          },
        },
      ],
      frameCount: 1,
    });
    const before = summary("job-before", false);
    const after = summary("job-after", true);
    sandbox.getScottyEvidence.mockImplementation(async (jobId: string) =>
      jobId === before.jobId ? before : after,
    );
    sandbox.getScottyEvidenceArtifact.mockResolvedValue({
      sessionId: SESSION_ID,
      jobId: after.jobId,
      frameId: "recording",
      objectKey: `evidence/${SESSION_ID}/${after.jobId}/recording.webm`,
      mediaType: "video/webm",
      sha256,
      bytes: evidenceWebm.byteLength,
      capturedAt: "2026-08-06T12:00:01.000Z",
      offsetMillis: 1_000,
      expiresAt: "2026-08-13T12:00:01.000Z",
      status: "available",
    });
    const testEnv = env({
      assets: showcaseAssets(),
      artifactBucket: evidenceVideoBucket(after.jobId, sha256),
    });
    const headers = { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` };
    const path = `/s/${SESSION_ID}/showcase/${before.jobId}/${after.jobId}`;
    const apiPath = `/api/sessions/${SESSION_ID}/showcase/${before.jobId}/${after.jobId}`;

    expect((await app.request(apiPath, undefined, testEnv)).status).toBe(401);
    const apiResponse = await app.request(apiPath, { headers }, testEnv);
    expect(apiResponse.status).toBe(200);
    expect(await apiResponse.json()).toMatchObject({
      paths: {
        hatch: `/s/${SESSION_ID}/hatch/open`,
        video: `/s/${SESSION_ID}/evidence/${after.jobId}/video.webm`,
      },
    });

    const shell = await app.request(path, { headers }, testEnv);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(shell.headers.get("content-security-policy")).toContain("media-src 'self'");
    expect(await shell.text()).toContain("<title>Scotty Showcase</title>");
    expect(showcaseScript).toContain("video.controls = true");
    expect(showcaseScript).toContain('video.preload = "metadata"');

    const video = await app.request(
      `/s/${SESSION_ID}/evidence/${after.jobId}/video.webm`,
      { headers },
      testEnv,
    );
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toBe("video/webm");
    expect(video.headers.get("content-disposition")).toBe("inline");
    expect(video.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(evidenceWebm);

    sandbox.getScottyEvidence.mockResolvedValueOnce({ ...before, flowHash: "d".repeat(64) });
    expect((await app.request(path, { headers }, testEnv)).status).toBe(409);
  });

  it("returns non-warm Cloudflare session pages to focused management for explicit resume", async () => {
    sandbox.getScottySession.mockResolvedValueOnce({
      id: "a0b1c2d3e4f5",
      status: "sleeping",
      provider: "cloudflare",
      repo: "owner/repo",
      branch: "scotty/a0b1c2d3e4f5",
    });
    const response = await app.request(
      "/s/a0b1c2d3e4f5",
      {
        headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` },
        redirect: "manual",
      },
      env(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost/sessions?focus=a0b1c2d3e4f5");
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("serves a JSON not-found response for Cloudflare sub-asset routes", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/assets/app.js?v=7",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
  });

  it("requires a WebSocket upgrade for Cloudflare terminal connections", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/terminal",
      {
        headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` },
      },
      env(),
    );
    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "upgrade_required",
        message: "Terminal connection requires a WebSocket upgrade",
      },
    });
  });

  it("requires same-origin for Cloudflare terminal connections", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/terminal",
      {
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          upgrade: "websocket",
          origin: "https://example.com",
        },
      },
      env(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "Request must come from this Scotty origin" },
    });
  });

  it("requires a registered-client cookie for Cloudflare terminal connections", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/terminal",
      {
        headers: { upgrade: "websocket" },
      },
      env(),
    );
    expect(response.status).toBe(401);
  });

  it("rejects Cloudflare terminal access when the session is sleeping", async () => {
    sandbox.getScottySession.mockResolvedValueOnce({
      id: "a0b1c2d3e4f5",
      status: "sleeping",
      provider: "cloudflare",
      repo: "owner/repo",
      branch: "scotty/a0b1c2d3e4f5",
    });
    const response = await app.request(
      "/s/a0b1c2d3e4f5/terminal",
      {
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          upgrade: "websocket",
          origin: "http://localhost",
        },
      },
      env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "wrong_state",
        message: "Cannot access a session in sleeping state",
        hint: "Resume the session from Home before opening the terminal",
      },
    });
  });

  it("rejects Cloudflare terminal access when an operation is active", async () => {
    sandbox.prepareTerminalAccess.mockRejectedValueOnce(
      conflict("Session is already running snapshot"),
    );
    const response = await app.request(
      "/s/a0b1c2d3e4f5/terminal",
      {
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          upgrade: "websocket",
          origin: "http://localhost",
        },
      },
      env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "conflict", message: "Session is already running snapshot" },
    });
  });

  it("forwards authenticated terminal sockets to the separate native PTY session", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/terminal?cols=142&rows=61",
      {
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          connection: "Upgrade",
          upgrade: "websocket",
          origin: "http://localhost",
        },
      },
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("terminal-proxy");
    expect(proxyTerminal).toHaveBeenCalledWith(
      sandbox,
      "terminal-a0b1c2d3e4f5",
      expect.any(Request),
      {
        cols: 142,
        rows: 61,
        shell: "/workspace/a0b1c2d3e4f5/.pi-agent/scotty-shell",
      },
    );
    expect(sandbox.prepareTerminalAccess).toHaveBeenCalledOnce();
    expect(sandbox.preparePiSessionAccess).not.toHaveBeenCalled();
  });

  it.each(["cols=0&rows=24", "cols=1001&rows=24", "cols=80", "cols=wide&rows=24"])(
    "rejects invalid terminal dimensions: %s",
    async (query) => {
      const response = await app.request(
        `/s/a0b1c2d3e4f5/terminal?${query}`,
        {
          headers: {
            cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
            connection: "Upgrade",
            upgrade: "websocket",
            origin: "http://localhost",
          },
        },
        env(),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "bad_request", message: "Terminal dimensions are invalid" },
      });
      expect(proxyTerminal).not.toHaveBeenCalled();
    },
  );

  it("requires cookie mutation security and returns the typed restart state", async () => {
    const denied = await app.request(
      "/s/a0b1c2d3e4f5/terminal/restart",
      {
        method: "POST",
        headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` },
      },
      env(),
    );
    expect(denied.status).toBe(400);

    const response = await app.request(
      "/s/a0b1c2d3e4f5/terminal/restart",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "restarted" });
    expect(sandbox.restartScottyTerminal).toHaveBeenCalledOnce();
  });

  it("does not expose the removed browser RPC surface", async () => {
    for (const [path, method] of [
      ["/s/a0b1c2d3e4f5/rpc/snapshot", "GET"],
      ["/s/a0b1c2d3e4f5/rpc/events", "GET"],
      ["/s/a0b1c2d3e4f5/rpc/command", "POST"],
    ] as const) {
      const response = await app.request(
        path,
        {
          method,
          headers: {
            cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
            "content-type": "application/json",
            origin: "http://localhost",
            "sec-fetch-site": "same-origin",
          },
        },
        env(),
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "not_found", message: "Route not found" },
      });
    }
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("routes console reads only through the passive sandbox boundary", async () => {
    sandbox.fetch.mockImplementationOnce(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/_scotty/pi-console/snapshot");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("authorization")).toBeNull();
      return Response.json(
        {
          status: "unavailable",
          reason: "provider_passive_relay_unavailable",
          retryable: false,
        },
        { status: 503 },
      );
    });

    const response = await app.request(
      "/s/a0b1c2d3e4f5/console/snapshot",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );

    expect(response.status).toBe(503);
    expect(sandbox.fetch).toHaveBeenCalledOnce();
    expect(sandbox.preparePiSessionAccess).not.toHaveBeenCalled();
    expect(sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it("prepares a missing Pi runtime only through an explicit authenticated mutation", async () => {
    sandbox.getScottySession.mockResolvedValueOnce({
      id: "a0b1c2d3e4f5",
      provider: "cloudflare",
      status: "warm",
    });
    sandbox.preparePiSessionAccess.mockResolvedValueOnce(undefined);

    const response = await app.request(
      "/s/a0b1c2d3e4f5/console/prepare",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sandbox.preparePiSessionAccess).toHaveBeenCalledOnce();
    expect(sandbox.fetch).not.toHaveBeenCalled();
    expect(sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it("decodes revision-bound console mutations before the sandbox", async () => {
    const command = {
      epoch: "epoch-1",
      commandId: "123e4567-e89b-42d3-a456-426614174000",
      expectedSessionRevision: 7,
      intent: { type: "abort" },
    };
    sandbox.fetch.mockImplementationOnce(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/_scotty/pi-console/command");
      expect(await request.json()).toEqual(command);
      return Response.json({ status: "accepted" }, { status: 202 });
    });

    const response = await app.request(
      "/s/a0b1c2d3e4f5/console/command",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      },
      env(),
    );

    expect(response.status).toBe(202);
    expect(sandbox.fetch).toHaveBeenCalledOnce();
  });

  it("rejects console mutations without a selected-session revision", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/console/command",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          epoch: "epoch-1",
          commandId: "123e4567-e89b-42d3-a456-426614174000",
          intent: { type: "abort" },
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin modern console commands before reaching the sandbox", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/console/command",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "https://example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          epoch: "epoch-1",
          commandId: "123e4567-e89b-42d3-a456-426614174000",
          expectedSessionRevision: 7,
          intent: { type: "abort" },
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("does not expose the Cloudflare terminal on runner sessions", async () => {
    sandbox.getScottySession.mockResolvedValueOnce({
      id: "a0b1c2d3e4f5",
      status: "warm",
      provider: "runner",
      repo: "owner/repo",
      branch: "scotty/a0b1c2d3e4f5",
    });
    const response = await app.request(
      "/s/a0b1c2d3e4f5/terminal",
      {
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          connection: "Upgrade",
          upgrade: "websocket",
          origin: "http://localhost",
        },
      },
      env(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Terminal route not found" },
    });
    expect(proxyTerminal).not.toHaveBeenCalled();
  });

  it("redirects runner session roots to the session list", async () => {
    sandbox.getScottySession.mockResolvedValueOnce({
      id: "a0b1c2d3e4f5",
      status: "warm",
      provider: "runner",
      repo: "owner/repo",
      branch: "scotty/a0b1c2d3e4f5",
    });
    const response = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost/sessions?focus=a0b1c2d3e4f5");
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("redirects missing session page routes to an HTML recovery surface", async () => {
    sandbox.getScottySession.mockRejectedValueOnce(
      new ScottyError("not_found", "Session unknown was not found", {
        httpStatus: 404,
        exitCode: 3,
      }),
    );

    const response = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost/sessions?unavailable=a0b1c2d3e4f5",
    );
  });

  it("returns not found for session application subpaths", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/assets/app.js?v=7",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("serves every critical auth page with the external-script CSP and no-store", async () => {
    for (const path of ["/pair", "/owner-transfer", "/recover"]) {
      const response = await app.request(path, undefined, env());
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(csp, path).toContain("connect-src 'self'");
      expect(csp, path).toContain("base-uri 'none'");
      expect(csp, path).toContain("form-action 'none'");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
    }

    const devices = await app.request(
      "/devices",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(devices.status).toBe(200);
    expect(devices.headers.get("content-security-policy")).toContain("script-src 'self'");

    const providers = await app.request(
      "/providers",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(providers.status).toBe(200);
    expect(providers.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("refreshes an owner cookie only when the Auth Durable Object reports renewal", async () => {
    auth.authenticate.mockResolvedValueOnce({
      ok: true,
      value: {
        client: {
          ...REGISTERED_CLIENT,
        },
        renewed: true,
      },
    });
    const response = await app.request(
      "/api/auth/me",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`__Host-scotty=${CLIENT_CREDENTIAL}`);
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  it("keeps root authority out of the public browser entry", async () => {
    const rootBearer = await app.request(
      "/",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(rootBearer.status).toBe(401);

    const rootQuery = await app.request(`/?t=${TOKEN}`, undefined, env());
    expect(rootQuery.status).toBe(401);
    expect(rootQuery.headers.get("set-cookie")).toBeNull();
  });

  it("redirects an authenticated public root to the canonical session manager", async () => {
    const response = await app.request(
      "/",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sessions");
  });

  it("does not expose the legacy PTY API", async () => {
    for (const request of [
      new Request("http://localhost/api/sessions/a0b1c2d3e4f5/pty-ticket", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      new Request("http://localhost/api/sessions/a0b1c2d3e4f5/pty?client=123456abcdef", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      new Request("http://localhost/api/sessions/a0b1c2d3e4f5/pty/123456abcdef", {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    ]) {
      const response = await app.request(request, undefined, env());
      expect(response.status).toBe(404);
    }
  });

  it("rejects invalid ids before creating a Durable Object stub", async () => {
    const response = await app.request(
      "/api/sessions/INVALID",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(response.status).toBe(400);
  });
});
