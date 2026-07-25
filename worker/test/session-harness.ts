import type {
  BackupOptions,
  DirectoryBackup,
  ExecOptions,
  ExecResult,
  RestoreBackupResult,
  SessionOptions,
} from "@cloudflare/sandbox";
import type { Bindings } from "../src/bindings";
import type { CreateSessionInput, SessionRecord, StoredCredential } from "../src/contracts";
import type { CreateIdempotencyMetadata } from "../src/create-idempotency";
import { Sandbox, type SandboxEffectOptions } from "../src/session";
import { InMemoryFaultInjectableFake } from "./support";

const RECORD_KEY = "scotty:session";
const CREDENTIAL_KEY = "scotty:credential";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";
const TERMINAL_ATTACHMENTS_KEY = "scotty:terminal-attachments";

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
  repo: "anomalyco/rift",
  hardCapSeconds: 14_400,
};
export const CREATE_IDEMPOTENCY: CreateIdempotencyMetadata = {
  keyDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
};

export type HarnessFailureStage =
  | "agentLaunch"
  | "backupDelete"
  | "backupList"
  | "containerAuthSeed"
  | "downRollout"
  | "downSha"
  | "downTar"
  | "downWriteManifest"
  | "hardCapSchedule"
  | "projectionDelete"
  | "restoreBackup"
  | "rollbackResume"
  | "terminalAttachmentCleanup"
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
  readonly initialExecutionSessions?: ReadonlyArray<string>;
  readonly initialProjections?: Readonly<Record<string, unknown>>;
  readonly onStorageGet?: (key: string, count: number, memory: InMemoryFaultInjectableFake) => void;
  readonly r2Objects?: ReadonlyArray<string>;
  readonly stopCallsOnStop?: boolean;
  readonly transactionFailureCountdown?: number;
}

export interface RecordedSchedule {
  readonly when: Date | number;
  readonly callback: string;
  readonly payload: unknown;
}

export interface SessionHarness {
  readonly sandbox: Sandbox;
  readonly events: string[];
  readonly schedules: RecordedSchedule[];
  readonly deletedSchedules: string[];
  readonly aborts: string[];
  readonly commands: string[];
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
    const value = structuredClone(this.memory.values.get(key)) as A | undefined;
    const count = (this.getCounts.get(key) ?? 0) + 1;
    this.getCounts.set(key, count);
    this.onStorageGet?.(key, count, this.memory);
    return value;
  };

  put = async <A>(key: string, value: A): Promise<void> => {
    this.memory.values.set(key, structuredClone(value));
    this.recordMutation(key, value);
  };

  delete = async (key: string): Promise<boolean> => {
    if (this.failures.has("terminalAttachmentCleanup") && key === TERMINAL_ATTACHMENTS_KEY) {
      throw new Error("injected terminal attachment cleanup failure");
    }
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
          throw new Error("simulated DO crash after initial record commit");
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
  const writtenFiles: Array<{ readonly path: string; readonly content: string }> = [];
  const r2DeletedKeys: ReadonlyArray<string>[] = [];
  const executionSessions = new Set(options.initialExecutionSessions ?? []);
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
      if (failures.has("projectionDelete")) throw new Error("injected projection deletion failure");
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
    SANDBOX: undefined as never,
    SESSIONS: sessions,
    BACKUP_BUCKET: {
      list: async (listOptions?: { readonly prefix?: string }) => {
        events.push(`r2:list:${listOptions?.prefix ?? ""}`);
        if (failures.has("backupList")) throw new Error("injected backup list failure");
        return {
          objects: (options.r2Objects ?? [])
            .filter((key) => key.startsWith(listOptions?.prefix ?? ""))
            .map((key) => ({ key })),
          truncated: false,
          delimitedPrefixes: [],
        };
      },
      delete: async (keys: string | string[]) => {
        if (failures.has("backupDelete")) throw new Error("injected backup delete failure");
        const deleted = typeof keys === "string" ? [keys] : keys;
        r2DeletedKeys.push(deleted);
        events.push(`r2:delete:${deleted.join(",")}`);
      },
    } as never,
    ASSETS: undefined as never,
    SCOTTY_TOKEN: "test-token",
    CODEX_AUTH_JSON: JSON.stringify({
      tokens: {
        id_token: "seed-id-token",
        access_token: "seed-access-token",
        refresh_token: "seed-refresh-token",
        account_id: "seed-account-id",
      },
    }),
    GH_TOKEN: "seed-github-token",
    SCOTTY_FAKE_AGENT: "1",
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

  Object.defineProperties(sandbox, {
    exec: {
      value: async (command: string, _execOptions?: ExecOptions): Promise<ExecResult> => {
        commands.push(command);
        const stage = command.startsWith("gh repo view")
          ? "workspace"
          : command.includes("sheppard spawn")
            ? "agent"
            : command.includes("rev-parse HEAD")
              ? "downSha"
              : command.startsWith("find ") && command.includes("*.jsonl")
                ? "downRollout"
                : command.startsWith("tar -cf ")
                  ? "downTar"
                  : "exec";
        events.push(`host:exec:${stage === "downRollout" ? "exec" : stage}`);
        if (failures.has("workspacePrepare") && stage === "workspace")
          throw new Error("injected workspace failure");
        if (failures.has("agentLaunch") && stage === "agent")
          throw new Error("injected agent failure");
        if (failures.has("rollbackResume") && command.includes("sheppard resume --tab"))
          throw new Error("injected managed-stop rollback failure");
        if (
          (stage === "downSha" && failures.has("downSha")) ||
          (stage === "downRollout" && failures.has("downRollout")) ||
          (stage === "downTar" && failures.has("downTar"))
        )
          throw new Error(`injected ${stage} failure`);
        const configured = options.commandStdout?.(command);
        const stdout =
          configured ??
          (stage === "workspace" ? "main\n" : stage === "downSha" ? "deadbeef\n" : "");
        return successfulExec(command, stdout);
      },
    },
    createSession: {
      value: async (sessionOptions?: SessionOptions): Promise<void> => {
        events.push("host:createSession");
        if (sessionOptions?.id) executionSessions.add(sessionOptions.id);
      },
    },
    getSession: {
      value: (sessionId: string) => ({
        killAllProcesses: async (): Promise<number> => {
          events.push(`host:killAllProcesses:${sessionId}`);
          return 1;
        },
      }),
    },
    getState: {
      value: async () => ({
        status: executionSessions.size > 0 ? "running" : "stopped",
      }),
    },
    deleteSession: {
      value: async (sessionId: string): Promise<void> => {
        events.push("host:deleteSession");
        executionSessions.delete(sessionId);
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
        if (options.failureStage === "restoreBackup") throw new Error("injected restore failure");
        return { success: true, id: backup.id, dir: backup.dir };
      },
    },
    writeFile: {
      value: async (path: string, content: string): Promise<void> => {
        writtenFiles.push({ path, content });
        events.push("host:writeFile");
        if (failures.has("downWriteManifest") && path === "/tmp/metadata.json")
          throw new Error("injected manifest write failure");
      },
    },
    mkdir: {
      value: async (_path: string): Promise<void> => {
        events.push("host:mkdir");
        if (options.failureStage === "containerAuthSeed")
          throw new Error("injected container auth failure");
      },
    },
    setEnvVars: {
      value: async (_envVars: Record<string, string | undefined>): Promise<void> => {
        events.push("host:setEnvVars");
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
          throw new Error("injected destroy failure");
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
          throw new Error("injected hard-cap schedule failure");
        }
        if (failures.has("vaporizeRetrySchedule") && callback === "retryVaporizeSession")
          throw new Error("injected vaporize retry schedule failure");
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
    client: {
      value: {
        disconnect: () => undefined,
        utils: {
          listSessions: async () => ({ sessions: [...executionSessions] }),
        },
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
  terminalAttachments: TERMINAL_ATTACHMENTS_KEY,
} as const;
