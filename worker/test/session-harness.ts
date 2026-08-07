import type {
  BackupOptions,
  DirectoryBackup,
  ExecOptions,
  ExecResult,
  RestoreBackupResult,
} from "@cloudflare/sandbox";
import { Data, Match } from "effect";
import type { RunnerOperation } from "../../protocol/runner";
import type { Bindings } from "../src/bindings";
import type { CreateSessionInput, SessionRecord, StoredCredential } from "../src/contracts";
import type { CreateIdempotencyMetadata } from "../src/create-idempotency";
import {
  SANDBOX_TEST_ACCEPT_EVIDENCE,
  SANDBOX_TEST_COMPLETE_EVIDENCE_STEP,
  SANDBOX_TEST_EXPOSE_EVIDENCE,
  SANDBOX_TEST_FINALIZE_EVIDENCE,
  Sandbox,
  type PassivePiConsoleRelay,
  type SandboxEffectOptions,
} from "../src/session";
import { EVIDENCE_RECORD_KEY, RUNTIME_EPOCH_KEY } from "../src/session-store";
import { InMemoryFaultInjectableFake } from "./support";

const RECORD_KEY = "scotty:session";
const CREDENTIAL_KEY = "scotty:credential";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";

class InjectedHarnessFailure extends Data.TaggedError("InjectedHarnessFailure")<{
  readonly message: string;
}> {}

export const injectedHarnessFailure = (message: string): InjectedHarnessFailure =>
  new InjectedHarnessFailure({ message });

interface StatusProjection {
  readonly status?: string;
}

const isStatusProjection = (value: unknown): value is StatusProjection =>
  typeof value === "object" &&
  value !== null &&
  (!("status" in value) || typeof value.status === "string");

export const SESSION_ID = "a0b1c2d3e4f5";
export const CREATE_INPUT: CreateSessionInput = {
  title: "Investigate failing build",
  prompt: "Investigate the failing build",
  provider: "cloudflare",
  repo: "owner/project",
  hardCapSeconds: 14_400,
};
export const CREATE_IDEMPOTENCY: CreateIdempotencyMetadata = {
  keyDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
};

export type HarnessFailureStage =
  | "artifactDelete"
  | "artifactDeleteAmbiguous"
  | "artifactPutAmbiguous"
  | "backupDelete"
  | "backupList"
  | "checkpointDefect"
  | "checkpointSync"
  | "containerAuthSeed"
  | "downRollout"
  | "downSha"
  | "downTar"
  | "downWriteManifest"
  | "hardCapSchedule"
  | "previewExpose"
  | "previewUnexpose"
  | "projectionDelete"
  | "runtimeEpochDelete"
  | "runtimeEpochPut"
  | "restoreBackup"
  | "terminalStop"
  | "vaporizeDestroy"
  | "vaporizeRetrySchedule"
  | "workspacePrepare";

export interface HarnessOptions {
  readonly clock?: SandboxEffectOptions["clock"];
  readonly commandStdout?: (command: string) => string | undefined;
  readonly crashAfterInitialRecordCommit?: boolean;
  readonly destroyBehavior?: "pending" | "reject" | "success";
  readonly evidenceEnabled?: boolean;
  readonly evidencePreviewHostTimeoutMillis?: number;
  readonly failureStage?: HarnessFailureStage;
  readonly initialEntries?: Readonly<Record<string, unknown>>;
  readonly kitesurfClient?: SandboxEffectOptions["kitesurfClient"];
  readonly runnerDispatch?: Bindings["RUNNERS"]["getByName"] extends (name: string) => infer Stub
    ? Stub extends { dispatch: infer Dispatch }
      ? Dispatch
      : never
    : never;
  readonly runnerFetch?: (request: Request) => Promise<Response>;
  readonly initialProjections?: Readonly<Record<string, unknown>>;
  readonly passivePiConsoleRelay?: PassivePiConsoleRelay;
  readonly piSessionRunning?: boolean;
  readonly previewBase?: string;
  readonly previewExposeGate?: Promise<void>;
  readonly previewRequestForwarder?: SandboxEffectOptions["previewRequestForwarder"];
  readonly rawPiContainerRunning?: boolean;
  readonly rawPiFetch?: (request: Request, port: number) => Promise<Response>;
  readonly rawPiGetTcpPortError?: unknown;
  readonly rotateEpochAfterPreviewExpose?: boolean;
  readonly sharedMemory?: InMemoryFaultInjectableFake;
  readonly onStorageGet?: (
    key: string,
    count: number,
    memory: InMemoryFaultInjectableFake,
  ) => void | Promise<void>;
  readonly r2Objects?: ReadonlyArray<string>;
  readonly sandboxNamespace?: Bindings["SANDBOX"];
  readonly stopCallsOnStop?: boolean;
  readonly transactionFailureCountdown?: number;
}

export interface RecordedSchedule {
  readonly when: Date | number;
  readonly callback: string;
  readonly payload: unknown;
}

type SandboxHarness = Sandbox & {
  readonly acceptScottyEvidenceJob: Sandbox[typeof SANDBOX_TEST_ACCEPT_EVIDENCE];
  readonly completeScottyEvidenceStep: Sandbox[typeof SANDBOX_TEST_COMPLETE_EVIDENCE_STEP];
  readonly exposeScottyEvidencePreview: Sandbox[typeof SANDBOX_TEST_EXPOSE_EVIDENCE];
  readonly finalizeScottyEvidenceJob: Sandbox[typeof SANDBOX_TEST_FINALIZE_EVIDENCE];
};

export interface SessionHarness {
  readonly sandbox: SandboxHarness;
  readonly events: string[];
  readonly schedules: RecordedSchedule[];
  readonly deletedSchedules: string[];
  readonly aborts: string[];
  readonly commands: string[];
  readonly runnerOperations: ReadonlyArray<RunnerOperation>;
  readonly runnerRequests: ReadonlyArray<Request>;
  readonly piRequests: ReadonlyArray<Request>;
  readonly rawPiRequests: ReadonlyArray<Request>;
  readonly writtenFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly r2DeletedKeys: ReadonlyArray<ReadonlyArray<string>>;
  readonly artifactDeletedKeys: ReadonlyArray<string>;
  readonly artifactKeys: () => ReadonlyArray<string>;
  readonly exposedPreviewPorts: () => ReadonlyArray<number>;
  readonly startRuntime: () => Promise<void>;
  readonly stopRuntime: () => Promise<void>;
  readonly memory: InMemoryFaultInjectableFake;
  readonly injectFailure: (stage: HarnessFailureStage) => void;
  readonly clearFailure: (stage?: HarnessFailureStage) => void;
  readonly read: <A>(key: string) => A | undefined;
  readonly readRecord: () => SessionRecord | undefined;
}

class HarnessStorage {
  readonly memory: InMemoryFaultInjectableFake;
  private alarm: number | null = null;
  private failNextGet = false;
  private readonly getCounts = new Map<string, number>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly events: string[],
    initialEntries: Readonly<Record<string, unknown>>,
    private readonly failures: ReadonlySet<HarnessFailureStage>,
    private readonly crashAfterInitialRecordCommit: boolean,
    private readonly onStorageGet?: HarnessOptions["onStorageGet"],
    transactionFailureCountdown?: number,
    sharedMemory?: InMemoryFaultInjectableFake,
  ) {
    this.memory = sharedMemory ?? new InMemoryFaultInjectableFake();
    for (const [key, value] of Object.entries(initialEntries)) {
      this.memory.values.set(key, structuredClone(value));
    }
    if (transactionFailureCountdown !== undefined) {
      this.memory.injectFailure("transaction", {
        countdown: transactionFailureCountdown,
        error: new Error("injected storage failure"),
        times: 1,
      });
    }
  }

  readonly kv = {
    get: <A>(key: string): A | undefined => this.memory.values.get(key) as A | undefined,
    list: <A>(): Iterable<[string, A]> => [...this.memory.values.entries()] as Array<[string, A]>,
    put: <A>(key: string, value: A): void => {
      this.memory.values.set(key, structuredClone(value));
    },
    delete: (key: string): boolean => this.memory.values.delete(key),
  };

  readonly sql = {
    exec: (): ReadonlyArray<never> => [],
    databaseSize: 0,
    Cursor: class {},
    Statement: class {},
  };

  get = async <A>(key: string): Promise<A | undefined> => {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw injectedHarnessFailure("injected storage get failure");
    }
    const value = structuredClone(this.memory.values.get(key)) as A | undefined;
    const count = (this.getCounts.get(key) ?? 0) + 1;
    this.getCounts.set(key, count);
    await this.onStorageGet?.(key, count, this.memory);
    return value;
  };

  put = async <A>(key: string, value: A): Promise<void> => {
    this.memory.values.set(key, structuredClone(value));
    this.recordMutation(key, value);
    if (key === RUNTIME_EPOCH_KEY && this.failures.has("runtimeEpochPut"))
      throw injectedHarnessFailure("injected ambiguous runtime epoch put failure");
  };

  delete = async (key: string): Promise<boolean> => {
    const deleted = this.memory.values.delete(key);
    this.events.push(`storage:delete:${key}`);
    if (key === RUNTIME_EPOCH_KEY && this.failures.has("runtimeEpochDelete"))
      throw injectedHarnessFailure("injected ambiguous runtime epoch delete failure");
    return deleted;
  };

  transaction = async <A>(
    operation: (transaction: {
      readonly get: <T>(key: string) => Promise<T | undefined>;
      readonly put: <T>(key: string, value: T) => Promise<void>;
      readonly delete: (key: string) => Promise<boolean>;
    }) => Promise<A>,
  ): Promise<A> =>
    this.memory.invoke("transaction", [], async () => {
      const preceding = this.transactionTail;
      let unlock = (): void => undefined;
      this.transactionTail = new Promise((resolve) => {
        unlock = resolve;
      });
      await preceding;
      const staged = structuredClone(this.memory.values);
      const mutations: Array<
        | { readonly kind: "delete"; readonly key: string }
        | { readonly kind: "put"; readonly key: string; readonly value: unknown }
      > = [];
      try {
        const result = await operation({
          get: async <T>(key: string) => structuredClone(staged.get(key)) as T | undefined,
          put: async <T>(key: string, value: T) => {
            staged.set(key, structuredClone(value));
            mutations.push({ kind: "put", key, value });
          },
          delete: async (key: string) => {
            const deleted = staged.delete(key);
            mutations.push({ kind: "delete", key });
            return deleted;
          },
        });
        this.memory.values.clear();
        for (const [key, value] of staged) this.memory.values.set(key, value);
        for (const mutation of mutations) {
          if (mutation.kind === "delete") this.events.push(`storage:delete:${mutation.key}`);
          else this.recordMutation(mutation.key, mutation.value);
        }
        if (
          this.crashAfterInitialRecordCommit &&
          mutations.some(
            (mutation) =>
              mutation.kind === "put" &&
              mutation.key === RECORD_KEY &&
              (mutation.value as SessionRecord).status === "booting" &&
              (mutation.value as SessionRecord).operation?.kind === "create",
          )
        ) {
          throw injectedHarnessFailure("simulated DO crash after initial record commit");
        }
        return result;
      } finally {
        unlock();
      }
    });

  setAlarm = async (scheduledTime: number | Date): Promise<void> => {
    this.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  };

  getAlarm = async (): Promise<number | null> => this.alarm;

  deleteAlarm = async (): Promise<void> => {
    this.alarm = null;
  };

  sync = async (): Promise<void> => undefined;

  read<A>(key: string): A | undefined {
    return structuredClone(this.memory.values.get(key)) as A | undefined;
  }

  injectNextGetFailure(): void {
    this.failNextGet = true;
  }

  injectNextTransactionFailure(): void {
    this.memory.injectFailure("transaction", {
      error: new Error("injected storage transaction failure"),
      times: 1,
    });
  }

  private recordMutation(key: string, value: unknown): void {
    if (key === RECORD_KEY) {
      this.events.push(`record:${(value as SessionRecord).status}`);
    } else if (key === CREDENTIAL_KEY) {
      this.events.push("credential:put");
    } else {
      this.events.push(`storage:put:${key}`);
    }
  }
}

export const makeStoredCredential = (
  overrides: Partial<StoredCredential> = {},
): StoredCredential => ({
  providers: {
    "openai-codex": {
      credential: {
        type: "oauth",
        access: "stored-access-token",
        refresh: "stored-refresh-token",
        expires: 0,
        accountId: "stored-account-id",
        idToken: "stored-id-token",
      },
      sentinel: `scotty-pi-${SESSION_ID}-sentinel-0`,
    },
  },
  githubToken: "stored-github-token",
  githubSentinel: `scotty-github-${SESSION_ID}-sentinel`,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

export const makeResumeBackup = (): DirectoryBackup => ({
  id: "backup-1",
  dir: `/workspace/${SESSION_ID}`,
  localBucket: true,
});

const LIFECYCLE_TEST_TIME = Date.parse("2026-07-24T12:00:00.000Z");

export const lifecycleWallClock = {
  isoAgo: (milliseconds: number): string =>
    new Date(LIFECYCLE_TEST_TIME - milliseconds).toISOString(),
  nowIso: (): string => new Date(LIFECYCLE_TEST_TIME).toISOString(),
};

export async function createSessionHarness(options: HarnessOptions = {}): Promise<SessionHarness> {
  const events: string[] = [];
  const schedules: RecordedSchedule[] = [];
  const deletedSchedules: string[] = [];
  const aborts: string[] = [];
  const commands: string[] = [];
  const runnerOperations: RunnerOperation[] = [];
  const runnerRequests: Request[] = [];
  const piRequests: Request[] = [];
  const rawPiRequests: Request[] = [];
  const writtenFiles: Array<{ readonly path: string; readonly content: string }> = [];
  const r2DeletedKeys: ReadonlyArray<string>[] = [];
  const artifactDeletedKeys: string[] = [];
  const exposedPreviewPorts = new Set<number>();
  const artifactObjects = new Map<
    string,
    {
      readonly bytes: Uint8Array;
      readonly contentType: string | undefined;
      readonly customMetadata: Readonly<Record<string, string>>;
    }
  >();
  let piSessionRunning = options.piSessionRunning ?? false;
  let rawPiContainerRunning = false;
  const failures = new Set<HarnessFailureStage>();
  if (options.failureStage !== undefined) failures.add(options.failureStage);
  const storage = new HarnessStorage(
    events,
    options.initialEntries ?? {},
    failures,
    options.crashAfterInitialRecordCommit ?? false,
    options.onStorageGet,
    options.transactionFailureCountdown,
    options.sharedMemory,
  );
  const constructorWork: Promise<unknown>[] = [];

  const ctx: DurableObjectState<{}> = {
    id: {
      toString: () => SESSION_ID,
      equals: () => false,
    } as never,
    storage: storage as never,
    container: {
      get running() {
        return rawPiContainerRunning;
      },
      monitor: () => Promise.resolve(),
      getTcpPort: (port: number) => {
        if (options.rawPiGetTcpPortError !== undefined) throw options.rawPiGetTcpPortError;
        return {
          fetch: async (request: Request) => {
            const copy = request.clone();
            rawPiRequests.push(copy);
            events.push(`host:pi:raw-fetch:${port}:${new URL(request.url).pathname}`);
            if (options.rawPiFetch !== undefined) return options.rawPiFetch(request, port);
            throw injectedHarnessFailure("Pi supervisor is not listening");
          },
        };
      },
    } as never,
    blockConcurrencyWhile: <A>(operation: () => Promise<A>): Promise<A> => {
      const work = operation();
      constructorWork.push(work);
      return work;
    },
    waitUntil: () => undefined,
    abort: (reason?: string) => {
      aborts.push(reason ?? "");
    },
    exports: {} as never,
    props: {},
    facets: {} as never,
    acceptWebSocket: () => undefined,
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => undefined,
    getWebSocketAutoResponse: () => null,
    getWebSocketAutoResponseTimestamp: () => null,
    setHibernatableWebSocketEventTimeout: () => undefined,
    getHibernatableWebSocketEventTimeout: () => null,
    getTags: () => [],
  };

  const projections = new Map<string, string>();
  for (const [key, value] of Object.entries(options.initialProjections ?? {})) {
    projections.set(key, JSON.stringify(value));
  }
  const sessions = {
    get: async (key: string): Promise<string | null> => projections.get(key) ?? null,
    put: async (key: string, value: string): Promise<void> => {
      projections.set(key, value);
      const decoded: unknown = JSON.parse(value);
      events.push(
        `projection:${isStatusProjection(decoded) ? (decoded.status ?? "unknown") : "unknown"}`,
      );
    },
    delete: async (key: string): Promise<void> => {
      if (failures.has("projectionDelete"))
        throw injectedHarnessFailure("injected projection deletion failure");
      projections.delete(key);
      events.push(`projection:delete:${key}`);
    },
    list: async (): Promise<{
      readonly keys: ReadonlyArray<{ readonly name: string }>;
      readonly list_complete: true;
      readonly cacheStatus: null;
    }> => ({
      keys: [...projections.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as KVNamespace;

  const env: Bindings = {
    AUTH: undefined as never,
    RUNNER_REGISTRY: {
      getByName: () => ({
        authenticate: async () => ({
          ok: true,
          value: {
            name: "test-runner",
            createdAt: "2026-07-29T12:00:00.000Z",
            updatedAt: "2026-07-29T12:00:00.000Z",
          },
        }),
        get: async (name) => ({
          ok: true,
          value: {
            name,
            createdAt: "2026-07-29T12:00:00.000Z",
            updatedAt: "2026-07-29T12:00:00.000Z",
          },
        }),
        list: async () => ({ ok: true, value: [] }),
        register: async () => ({
          ok: false,
          error: { reason: "invalid_input", message: "Unavailable in the session harness" },
        }),
        remove: async () => ({ ok: true, value: undefined }),
      }),
    },
    RUNNERS: {
      getByName: () => ({
        dispatch:
          options.runnerDispatch ??
          (async (operation) => {
            runnerOperations.push(operation);
            const [operationTag, result] = Match.value(operation).pipe(
              Match.discriminatorsExhaustive("_tag")({
                EnsureRuntime: () => [
                  "EnsureRuntime",
                  {
                    _tag: "EnsureRuntimeResult" as const,
                    phase: "running" as const,
                    resourceId: `runner-v1:${operation.sessionId}`,
                    workspace: `/runner/${operation.sessionId}`,
                  },
                ],
                InspectRuntime: () => [
                  "InspectRuntime",
                  {
                    _tag: "InspectRuntimeResult" as const,
                    phase: "running" as const,
                    resourceId: `runner-v1:${operation.sessionId}`,
                    workspace: `/runner/${operation.sessionId}`,
                  },
                ],
                ExecRuntime: () => [
                  "ExecRuntime",
                  {
                    _tag: "ExecRuntimeResult" as const,
                    exitCode: 0,
                    stdout: operation.operationId.includes("bootstrap")
                      ? JSON.stringify({ defaultBranch: "main", repoExists: true })
                      : "",
                    stderr: "",
                  },
                ],
                StopRuntime: () => [
                  "StopRuntime",
                  {
                    _tag: "StopRuntimeResult" as const,
                    phase: "stopped" as const,
                    resourceId: `runner-v1:${operation.sessionId}`,
                    workspace: `/runner/${operation.sessionId}`,
                  },
                ],
                RemoveRuntime: () => [
                  "RemoveRuntime",
                  {
                    _tag: "RemoveRuntimeResult" as const,
                    phase: "absent" as const,
                    resourceId: `runner-v1:${operation.sessionId}`,
                    workspace: `/runner/${operation.sessionId}`,
                  },
                ],
              }),
            );
            events.push(`runner:dispatch:${operationTag}:${operation.operationId}`);
            return {
              ok: true,
              response: {
                _tag: "RunnerSuccess",
                version: 2,
                operationId: operation.operationId,
                sessionId: operation.sessionId,
                result,
              },
            } as never;
          }),
        fetch:
          options.runnerFetch ??
          (async (request) => {
            const copy = request.clone();
            runnerRequests.push(copy);
            const path = new URL(request.url).pathname;
            events.push(`runner:fetch:${path}`);
            return new Response("runner fixture");
          }),
        status: async () => "connected",
        controlStatus: async () => ({
          desired: "accepting",
          connection: "connected",
          lastSeenAt: "2026-07-24T12:00:00.000Z",
        }),
        control: async () => undefined,
      }),
    },
    SANDBOX: options.sandboxNamespace ?? (undefined as never),
    SESSIONS: sessions,
    BACKUP_BUCKET: {
      list: async (listOptions?: { readonly prefix?: string }) => {
        events.push(`r2:list:${listOptions?.prefix ?? ""}`);
        if (failures.has("backupList"))
          throw injectedHarnessFailure("injected backup list failure");
        return {
          objects: (options.r2Objects ?? [])
            .filter((key) => key.startsWith(listOptions?.prefix ?? ""))
            .map((key) => ({ key })),
          truncated: false,
          delimitedPrefixes: [],
        };
      },
      delete: async (keys: string | string[]) => {
        if (failures.has("backupDelete"))
          throw injectedHarnessFailure("injected backup delete failure");
        const deleted = typeof keys === "string" ? [keys] : keys;
        r2DeletedKeys.push(deleted);
        events.push(`r2:delete:${deleted.join(",")}`);
      },
    } as never,
    ARTIFACT_BUCKET: {
      put: async (key: string, value: unknown, putOptions?: R2PutOptions) => {
        if (!(value instanceof Uint8Array))
          throw injectedHarnessFailure("artifact value was not bytes");
        const contentType =
          putOptions?.httpMetadata instanceof Headers
            ? (putOptions.httpMetadata.get("content-type") ?? undefined)
            : putOptions?.httpMetadata?.contentType;
        artifactObjects.set(key, {
          bytes: Uint8Array.from(value),
          contentType,
          customMetadata: putOptions?.customMetadata ?? {},
        });
        events.push(`artifact:put:${key}`);
        if (failures.has("artifactPutAmbiguous"))
          throw injectedHarnessFailure("injected ambiguous artifact put failure");
        return {};
      },
      head: async (key: string) => {
        if (failures.has("artifactPutAmbiguous"))
          throw injectedHarnessFailure("injected artifact head failure after ambiguous put");
        const object = artifactObjects.get(key);
        return object === undefined
          ? null
          : {
              key,
              size: object.bytes.byteLength,
              httpMetadata: { contentType: object.contentType },
              customMetadata: object.customMetadata,
            };
      },
      get: async (key: string) => {
        const object = artifactObjects.get(key);
        if (object === undefined) return null;
        return {
          key,
          size: object.bytes.byteLength,
          httpMetadata: { contentType: object.contentType },
          customMetadata: object.customMetadata,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(object.bytes);
              controller.close();
            },
          }),
        };
      },
      delete: async (key: string) => {
        events.push(`artifact:delete:${key}`);
        if (failures.has("artifactDelete"))
          throw injectedHarnessFailure("injected artifact delete failure");
        artifactObjects.delete(key);
        artifactDeletedKeys.push(key);
        if (failures.has("artifactDeleteAmbiguous"))
          throw injectedHarnessFailure("injected ambiguous artifact delete failure");
      },
    } as never,
    BROWSER: undefined as never,
    ASSETS: undefined as never,
    SCOTTY_TOKEN: "test-token",
    PI_AUTH_JSON: JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "seed-access-token",
        refresh: "seed-refresh-token",
        expires: 0,
        accountId: "seed-account-id",
      },
    }),
    GH_TOKEN: "seed-github-token",
    ...(options.evidenceEnabled === true ? { SCOTTY_EVIDENCE_ENABLED: "true" } : {}),
    ...(options.previewBase === undefined ? {} : { SCOTTY_PREVIEW_BASE: options.previewBase }),
  };

  const sandbox = new Sandbox(ctx, env, {
    clock: options.clock,
    evidencePreviewHostTimeoutMillis: options.evidencePreviewHostTimeoutMillis,
    kitesurfClient: options.kitesurfClient,
    passivePiConsoleRelay: options.passivePiConsoleRelay,
    previewRequestForwarder: options.previewRequestForwarder,
  });
  await Promise.all(constructorWork);
  rawPiContainerRunning = options.rawPiContainerRunning ?? false;

  const successfulExec = (command: string, stdout = ""): ExecResult => ({
    success: true,
    exitCode: 0,
    stdout,
    stderr: "",
    command,
    duration: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  Object.defineProperties(sandbox, {
    acceptScottyEvidenceJob: {
      value: (value: unknown) => sandbox[SANDBOX_TEST_ACCEPT_EVIDENCE](value),
    },
    completeScottyEvidenceStep: {
      value: (nonce: string, value: unknown) =>
        sandbox[SANDBOX_TEST_COMPLETE_EVIDENCE_STEP](nonce, value),
    },
    exposeScottyEvidencePreview: {
      value: (nonce: string) => sandbox[SANDBOX_TEST_EXPOSE_EVIDENCE](nonce),
    },
    finalizeScottyEvidenceJob: {
      value: (
        nonce: string,
        status: Parameters<Sandbox[typeof SANDBOX_TEST_FINALIZE_EVIDENCE]>[1],
      ) => sandbox[SANDBOX_TEST_FINALIZE_EVIDENCE](nonce, status),
    },
    start: {
      value: async (): Promise<void> => {
        events.push("host:container:start");
      },
    },
    startAndWaitForPorts: {
      value: async (): Promise<void> => {
        events.push("host:container:startAndWaitForPorts");
      },
    },
    waitForPort: {
      value: async (): Promise<number> => {
        events.push("host:container:waitForPort");
        return 0;
      },
    },
    renewActivityTimeout: {
      value: (): void => {
        events.push("host:container:renewActivityTimeout");
      },
    },
    exec: {
      value: async (command: string, _execOptions?: ExecOptions): Promise<ExecResult> => {
        commands.push(command);
        const stage = command.startsWith("gh repo view")
          ? "workspace"
          : command.includes("rev-parse HEAD")
            ? "downSha"
            : command.startsWith("find ") && command.includes("*.jsonl")
              ? "downRollout"
              : command.startsWith("tar -cf ")
                ? "downTar"
                : "exec";
        events.push(`host:exec:${stage === "downRollout" ? "exec" : stage}`);
        if (failures.has("workspacePrepare") && stage === "workspace")
          throw injectedHarnessFailure("injected workspace failure");
        if (failures.has("checkpointSync") && command === "sync")
          throw injectedHarnessFailure("injected checkpoint sync failure");
        if (failures.has("checkpointDefect") && command === "sync") {
          return {
            ...successfulExec(command),
            get success(): boolean {
              throw injectedHarnessFailure("injected checkpoint defect");
            },
          };
        }
        if (
          (stage === "downSha" && failures.has("downSha")) ||
          (stage === "downRollout" && failures.has("downRollout")) ||
          (stage === "downTar" && failures.has("downTar"))
        )
          throw injectedHarnessFailure(`injected ${stage} failure`);
        const configured = options.commandStdout?.(command);
        const stdout =
          configured ??
          (stage === "workspace" ? "main\n" : stage === "downSha" ? "deadbeef\n" : "");
        return successfulExec(command, stdout);
      },
    },
    exposePort: {
      value: async (
        port: number,
        exposeOptions: {
          readonly hostname: string;
          readonly token?: string;
          readonly name?: string;
        },
      ) => {
        events.push(`host:preview:expose:${port}`);
        await options.previewExposeGate;
        const token = exposeOptions.token ?? "generated_token";
        exposedPreviewPorts.add(port);
        if (failures.has("previewExpose"))
          throw injectedHarnessFailure("injected ambiguous preview exposure failure");
        if (options.rotateEpochAfterPreviewExpose)
          storage.kv.put(RUNTIME_EPOCH_KEY, "runtime-epoch-rotated-after-expose");
        return {
          url: `https://${port}-${SESSION_ID}-${token}.${exposeOptions.hostname}/`,
          port,
          name: exposeOptions.name,
        };
      },
    },
    unexposePort: {
      value: async (port: number): Promise<void> => {
        events.push(`host:preview:unexpose:${port}`);
        if (failures.has("previewUnexpose"))
          throw injectedHarnessFailure("injected preview unexpose failure");
        exposedPreviewPorts.delete(port);
      },
    },
    createBackup: {
      value: async (_backupOptions: BackupOptions): Promise<DirectoryBackup> => {
        events.push("host:createBackup");
        return makeResumeBackup();
      },
    },
    restoreBackup: {
      value: async (backup: DirectoryBackup): Promise<RestoreBackupResult> => {
        events.push("host:restoreBackup");
        if (options.failureStage === "restoreBackup")
          throw injectedHarnessFailure("injected restore failure");
        return { success: true, id: backup.id, dir: backup.dir };
      },
    },
    writeFile: {
      value: async (path: string, content: string): Promise<void> => {
        writtenFiles.push({ path, content });
        events.push("host:writeFile");
        if (failures.has("downWriteManifest") && path === "/tmp/metadata.json")
          throw injectedHarnessFailure("injected manifest write failure");
      },
    },
    mkdir: {
      value: async (_path: string): Promise<void> => {
        events.push("host:mkdir");
        if (options.failureStage === "containerAuthSeed")
          throw injectedHarnessFailure("injected container auth failure");
      },
    },
    setEnvVars: {
      value: async (_envVars: Record<string, string | undefined>): Promise<void> => {
        events.push("host:setEnvVars");
      },
    },
    startProcess: {
      value: async (_command: string, options?: { readonly processId?: string }) => {
        piSessionRunning = true;
        events.push(`host:pi:start:${options?.processId ?? "generated"}`);
        return {
          id: options?.processId ?? "generated",
          status: "running" as const,
          kill: async () => {
            piSessionRunning = false;
            events.push("host:pi:kill");
          },
          waitForExit: async () => ({ exitCode: 0 }),
          waitForPort: async () => {
            events.push("host:pi:ready");
          },
        };
      },
    },
    getProcess: {
      value: async (processId: string) =>
        piSessionRunning
          ? {
              id: processId,
              status: "running" as const,
              kill: async () => {
                piSessionRunning = false;
                events.push("host:pi:kill");
              },
              waitForExit: async () => ({ exitCode: 0 }),
              waitForPort: async () => {
                events.push("host:pi:ready");
              },
            }
          : null,
    },
    containerFetch: {
      value: async (request: Request, port: number) => {
        piRequests.push(request.clone());
        const pathname = new URL(request.url).pathname;
        events.push(`host:pi:fetch:${port}:${pathname}`);
        return failures.has("terminalStop") && pathname === "/quiesce"
          ? Response.json({ error: "injected Pi quiesce failure" }, { status: 502 })
          : Response.json({ status: "quiesced" });
      },
    },
    stop: {
      value: async (): Promise<void> => {
        events.push("host:stop");
        if (options.stopCallsOnStop) await sandbox.onStop();
      },
    },
    destroy: {
      value: async (): Promise<void> => {
        events.push("host:destroy");
        if (failures.has("vaporizeDestroy") || options.destroyBehavior === "reject")
          throw injectedHarnessFailure("injected destroy failure");
        if (options.destroyBehavior === "pending") return new Promise<void>(() => undefined);
      },
    },
    schedule: {
      value: async (
        when: Date | number,
        callback: string,
        payload: unknown,
      ): Promise<RecordedSchedule> => {
        events.push(`schedule:${callback}`);
        if (failures.has("hardCapSchedule") && callback === "enforceHardCap") {
          throw injectedHarnessFailure("injected hard-cap schedule failure");
        }
        if (failures.has("vaporizeRetrySchedule") && callback === "retryVaporizeSession")
          throw injectedHarnessFailure("injected vaporize retry schedule failure");
        const scheduled = { when, callback, payload };
        schedules.push(scheduled);
        return scheduled;
      },
    },
    deleteSchedules: {
      value: (callback: string): void => {
        deletedSchedules.push(callback);
        events.push(`schedule:delete:${callback}`);
      },
    },
  });

  return {
    sandbox: sandbox as SandboxHarness,
    events,
    schedules,
    deletedSchedules,
    aborts,
    commands,
    runnerOperations,
    runnerRequests,
    piRequests,
    rawPiRequests,
    writtenFiles,
    r2DeletedKeys,
    artifactDeletedKeys,
    artifactKeys: () => [...artifactObjects.keys()],
    exposedPreviewPorts: () => [...exposedPreviewPorts],
    startRuntime: async () => {
      rawPiContainerRunning = true;
      await sandbox.onStart();
    },
    stopRuntime: async () => {
      rawPiContainerRunning = false;
      await sandbox.onStop();
    },
    memory: storage.memory,
    injectFailure: (stage) => {
      failures.add(stage);
    },
    clearFailure: (stage) => {
      if (stage === undefined) failures.clear();
      else failures.delete(stage);
    },
    read: <A>(key: string) => storage.read<A>(key),
    readRecord: () => storage.read<SessionRecord>(RECORD_KEY),
  };
}

export const sessionHarnessKeys = {
  credential: CREDENTIAL_KEY,
  createIdempotency: CREATE_IDEMPOTENCY_KEY,
  evidence: EVIDENCE_RECORD_KEY,
  record: RECORD_KEY,
  runtimeEpoch: RUNTIME_EPOCH_KEY,
} as const;
