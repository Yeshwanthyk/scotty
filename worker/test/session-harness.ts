import type {
  BackupOptions,
  DirectoryBackup,
  ExecOptions,
  ExecResult,
  ProcessOptions,
  RestoreBackupResult,
} from "@cloudflare/sandbox";
import { Data, Match } from "effect";
import type { RunnerOperation } from "../../protocol/runner";
import type { Bindings } from "../src/bindings";
import type { CreateSessionInput, SessionRecord, StoredCredential } from "../src/contracts";
import type { CreateIdempotencyMetadata } from "../src/create-idempotency";
import { Sandbox, type SandboxEffectOptions } from "../src/session";
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
  | "backupDelete"
  | "backupList"
  | "checkpointFailureStatePersist"
  | "checkpointFailureStateRead"
  | "checkpointDefect"
  | "checkpointSync"
  | "containerAuthSeed"
  | "downRollout"
  | "downSha"
  | "downTar"
  | "downWriteManifest"
  | "hardCapSchedule"
  | "picanCreate"
  | "picanLaunch"
  | "picanStop"
  | "projectionDelete"
  | "restoreBackup"
  | "rollbackResume"
  | "vaporizeDestroy"
  | "vaporizeRetrySchedule"
  | "workspacePrepare";

export interface HarnessOptions {
  readonly clock?: SandboxEffectOptions["clock"];
  readonly commandStdout?: (command: string) => string | undefined;
  readonly crashAfterInitialRecordCommit?: boolean;
  readonly destroyBehavior?: "pending" | "reject" | "success";
  readonly failureStage?: HarnessFailureStage;
  readonly initialEntries?: Readonly<Record<string, unknown>>;
  readonly initialPicanRunning?: boolean;
  readonly runnerDispatch?: Bindings["RUNNERS"]["getByName"] extends (name: string) => infer Stub
    ? Stub extends { dispatch: infer Dispatch }
      ? Dispatch
      : never
    : never;
  readonly runnerFetch?: (request: Request) => Promise<Response>;
  readonly initialProjections?: Readonly<Record<string, unknown>>;
  readonly onStorageGet?: (
    key: string,
    count: number,
    memory: InMemoryFaultInjectableFake,
  ) => void | Promise<void>;
  readonly picanCreateResponse?: () => Response;
  readonly picanWorkerStatus?: () => Response;
  readonly r2Objects?: ReadonlyArray<string>;
  readonly stopCallsOnStop?: boolean;
  readonly transactionFailureCountdown?: number;
}

export interface RecordedSchedule {
  readonly when: Date | number;
  readonly callback: string;
  readonly payload: unknown;
}

export interface RecordedPicanRequest {
  readonly body: unknown;
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
}

export interface RecordedPicanStart {
  readonly command: string;
  readonly options: ProcessOptions | undefined;
}

export interface SessionHarness {
  readonly sandbox: Sandbox;
  readonly events: string[];
  readonly schedules: RecordedSchedule[];
  readonly deletedSchedules: string[];
  readonly aborts: string[];
  readonly commands: string[];
  readonly picanRequests: RecordedPicanRequest[];
  readonly picanSignals: string[];
  readonly picanStarts: RecordedPicanStart[];
  readonly runnerOperations: ReadonlyArray<RunnerOperation>;
  readonly runnerRequests: ReadonlyArray<Request>;
  readonly writtenFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly r2DeletedKeys: ReadonlyArray<ReadonlyArray<string>>;
  readonly memory: InMemoryFaultInjectableFake;
  readonly injectFailure: (stage: HarnessFailureStage) => void;
  readonly clearFailure: (stage?: HarnessFailureStage) => void;
  readonly read: <A>(key: string) => A | undefined;
  readonly readRecord: () => SessionRecord | undefined;
}

class HarnessStorage {
  readonly memory = new InMemoryFaultInjectableFake();
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
  ) {
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
  };

  delete = async (key: string): Promise<boolean> => {
    const deleted = this.memory.values.delete(key);
    this.events.push(`storage:delete:${key}`);
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
  codex: {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "stored-id-token",
      access_token: "stored-access-token",
      refresh_token: "stored-refresh-token",
      account_id: "stored-account-id",
    },
    account_id: null,
    last_refresh: "2026-01-01T00:00:00.000Z",
  },
  githubToken: "stored-github-token",
  codexSentinel: `scotty-codex-${SESSION_ID}-sentinel`,
  githubSentinel: `scotty-github-${SESSION_ID}-sentinel`,
  picanProxyToken: `scotty-pican-${SESSION_ID}-proxy`,
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
  const picanRequests: RecordedPicanRequest[] = [];
  const picanSignals: string[] = [];
  const picanStarts: RecordedPicanStart[] = [];
  const runnerOperations: RunnerOperation[] = [];
  const runnerRequests: Request[] = [];
  const writtenFiles: Array<{ readonly path: string; readonly content: string }> = [];
  const r2DeletedKeys: ReadonlyArray<string>[] = [];
  const failures = new Set<HarnessFailureStage>();
  if (options.failureStage !== undefined) failures.add(options.failureStage);
  const storage = new HarnessStorage(
    events,
    options.initialEntries ?? {},
    failures,
    options.crashAfterInitialRecordCommit ?? false,
    options.onStorageGet,
    options.transactionFailureCountdown,
  );
  const constructorWork: Promise<unknown>[] = [];

  const ctx: DurableObjectState<{}> = {
    id: {
      toString: () => SESSION_ID,
      equals: () => false,
    } as never,
    storage: storage as never,
    container: {
      running: false,
      monitor: () => Promise.resolve(),
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
            if (path.endsWith("/api/settings")) return Response.json({ ready: true });
            if (path.endsWith("/api/new-session"))
              return Response.json({
                id: "pican-session-1",
                nativeId: "019d0f55-8d43-7b8c-b63f-f3875b66d03b",
                runtime: "codex",
                createState: "created",
                promptDispatchState: "accepted",
              });
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
    SANDBOX: undefined as never,
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
    ASSETS: undefined as never,
    SCOTTY_TOKEN: "test-token",
    SCOTTY_RUNNER_NAME: "slumbers",
    SCOTTY_RUNNER_TOKEN: "runner-test-token",
    CODEX_AUTH_JSON: JSON.stringify({
      tokens: {
        id_token: "seed-id-token",
        access_token: "seed-access-token",
        refresh_token: "seed-refresh-token",
        account_id: "seed-account-id",
      },
    }),
    GH_TOKEN: "seed-github-token",
  };

  const sandbox = new Sandbox(ctx, env, { clock: options.clock });
  await Promise.all(constructorWork);

  const successfulExec = (command: string, stdout = ""): ExecResult => ({
    success: true,
    exitCode: 0,
    stdout,
    stderr: "",
    command,
    duration: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  let picanProcess:
    | {
        readonly id: string;
        readonly status: "running";
        readonly kill: (signal?: string) => Promise<void>;
        readonly waitForExit: (timeout?: number) => Promise<{ readonly exitCode: number }>;
        readonly waitForPort: (port: number) => Promise<void>;
      }
    | undefined;

  const makePicanProcess = () => ({
    id: "scotty-pican",
    status: "running" as const,
    kill: async (signal = "SIGTERM"): Promise<void> => {
      events.push(`host:pican:kill:${signal}`);
      picanSignals.push(signal);
      picanProcess = undefined;
      if (failures.has("picanStop"))
        throw injectedHarnessFailure("injected Pican stop failure after termination");
    },
    waitForExit: async (): Promise<{ readonly exitCode: number }> => {
      events.push("host:pican:waitForExit");
      return { exitCode: 0 };
    },
    waitForPort: async (port: number): Promise<void> => {
      events.push(`host:pican:waitForPort:${port}`);
      if (failures.has("picanLaunch"))
        throw injectedHarnessFailure("injected Pican launch failure");
    },
  });
  if (options.initialPicanRunning === true) picanProcess = makePicanProcess();

  Object.defineProperties(sandbox, {
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
      value: async (command: string, processOptions?: ProcessOptions) => {
        events.push("host:pican:start");
        picanStarts.push({ command, options: processOptions });
        if (failures.has("picanLaunch") || failures.has("rollbackResume")) {
          if (failures.has("checkpointFailureStateRead")) storage.injectNextGetFailure();
          if (failures.has("checkpointFailureStatePersist")) storage.injectNextTransactionFailure();
          throw injectedHarnessFailure("injected Pican launch failure");
        }
        picanProcess = makePicanProcess();
        return picanProcess;
      },
    },
    getProcess: {
      value: async (processId: string) =>
        processId === "scotty-pican" ? (picanProcess ?? null) : null,
    },
    deleteSession: {
      value: async (sessionId: string) => {
        events.push(`host:pi:delete:${sessionId}`);
        if (failures.has("picanStop"))
          throw injectedHarnessFailure("injected Pi terminal stop failure");
        return {
          success: true,
          sessionId,
          timestamp: lifecycleWallClock.nowIso(),
        };
      },
    },
    containerFetch: {
      configurable: true,
      value: async (request: Request, port: number): Promise<Response> => {
        if (new URL(request.url).pathname.endsWith("/api/settings")) {
          events.push("host:pican:ready");
          return Response.json({ ready: true });
        }
        if (new URL(request.url).pathname.endsWith("/api/worker-status")) {
          events.push("host:pican:worker-status");
          return options.picanWorkerStatus?.() ?? Response.json({ state: "idle" });
        }
        const clone = request.clone();
        const body: unknown =
          request.method === "GET" || request.method === "HEAD" ? undefined : await clone.json();
        picanRequests.push({
          body,
          headers: new Headers(request.headers),
          method: request.method,
          url: request.url,
        });
        events.push(`host:pican:fetch:${port}`);
        if (failures.has("picanCreate"))
          throw injectedHarnessFailure("injected Pican create failure");
        if (options.picanCreateResponse !== undefined) return options.picanCreateResponse();
        return Response.json({
          id: "pican-session-1",
          nativeId: "019d0f55-8d43-7b8c-b63f-f3875b66d03b",
          runtime: "codex",
          createState: "created",
          promptDispatchState: "accepted",
        });
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
    sandbox,
    events,
    schedules,
    deletedSchedules,
    aborts,
    commands,
    picanRequests,
    picanSignals,
    picanStarts,
    runnerOperations,
    runnerRequests,
    writtenFiles,
    r2DeletedKeys,
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
  record: RECORD_KEY,
} as const;
