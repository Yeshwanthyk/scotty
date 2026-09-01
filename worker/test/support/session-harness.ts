import type {
  BackupOptions,
  DirectoryBackup,
  ExecOptions,
  ExecResult,
  RestoreBackupResult,
} from "@cloudflare/sandbox";
import { Data, Effect, Match, Result } from "effect";
import {
  createDeterministicTarGz,
  gunzipSandboxArchive,
  parseSandboxTar,
} from "../../../cli/src/sandbox-archive";
import type { RunnerOperation } from "../../../protocol/runner";
import type { CredentialGrant } from "../../../protocol/credentials";
import type { Bindings } from "../../src/shared/bindings";
import type {
  CreateSessionInput,
  SessionRecord,
  WorkspaceCreationMarker,
} from "../../src/session/contracts";
import type { CreateIdempotencyMetadata } from "../../src/session/create-idempotency";
import type { EvidenceArtifact } from "../../src/evidence/contracts";
import { HATCH_PRIVATE_READINESS_HEADER } from "../../src/hatch/contracts";
import type { RepoVerifier } from "../../src/repos/verifier";
import type { SandboxConfigStatus } from "../../src/sandbox/config-contracts";
import type { SandboxConfigRpcResult } from "../../src/sandbox/config-object";
import { sandboxBundleTarGzKey } from "../../src/sandbox/bundle-store";
import {
  HATCH_STATE_KEY,
  SESSION_ACTOR_AUTHORITY_KEY,
  SESSION_ACTOR_JOURNAL_SEQUENCE_KEY,
  SESSION_ACTOR_JOURNAL_TAIL_KEY,
  SESSION_ACTOR_METADATA_KEY,
  SESSION_ACTOR_REVISION_KEY,
  SESSION_CONTROL_REVISION_KEY,
} from "../../src/session/store";
import {
  SANDBOX_TEST_ACCEPT_EVIDENCE,
  SANDBOX_TEST_COMPLETE_EVIDENCE_STEP,
  SANDBOX_TEST_EXPOSE_EVIDENCE,
  SANDBOX_TEST_FINALIZE_EVIDENCE,
  Sandbox,
  type PassivePiConsoleRelay,
  type SandboxEffectOptions,
} from "../../src/session/object";
import { EVIDENCE_RECORD_KEY, RUNTIME_EPOCH_KEY } from "../../src/session/store";
import { InMemoryFaultInjectableFake } from "./index";

const RECORD_KEY = "scotty:session";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SANDBOX_BUNDLE_CONTENT_TYPE = "application/gzip";

interface StoredSandboxBundleObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly customMetadata: Readonly<Record<string, string>>;
}

const emptyAdditionsBundleGzip = (): Uint8Array =>
  createDeterministicTarGz([
    {
      path: "manifest.json",
      type: "file",
      modeClass: "regular",
      bytes: new TextEncoder().encode('{"items":[]}\n'),
    },
  ]).archive;

const seedSandboxBundleObject = (
  objects: Map<string, StoredSandboxBundleObject>,
  digest: string,
  gzip: Uint8Array,
): void => {
  objects.set(sandboxBundleTarGzKey(digest), {
    bytes: Uint8Array.from(gzip),
    contentType: SANDBOX_BUNDLE_CONTENT_TYPE,
    customMetadata: { digest },
  });
};

const makeSandboxBundleBucket = (
  objects: Map<string, StoredSandboxBundleObject>,
  deletedKeys: string[],
): R2Bucket => {
  const r2Object = (
    key: string,
    object: StoredSandboxBundleObject,
    includeBody: boolean,
  ): R2Object | R2ObjectBody => {
    const base = {
      key,
      version: "1",
      size: object.bytes.byteLength,
      etag: "etag",
      httpEtag: '"etag"',
      checksums: { toJSON: () => ({}) },
      uploaded: new Date("2026-08-06T12:00:00.000Z"),
      httpMetadata: { contentType: object.contentType },
      customMetadata: { ...object.customMetadata },
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
    };
    if (!includeBody) return base as R2Object;
    return {
      ...base,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(object.bytes);
          controller.close();
        },
      }),
      bodyUsed: false,
      arrayBuffer: () => Promise.resolve(object.bytes.buffer.slice(0)),
      bytes: () => Promise.resolve(Uint8Array.from(object.bytes)),
      text: () => Promise.resolve(""),
      json: <T>() => Promise.resolve({} as T),
      blob: () => Promise.resolve(new Blob([object.bytes], { type: object.contentType })),
    } as R2ObjectBody;
  };

  return {
    put: async (
      key: string,
      value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string | null,
      options?: R2PutOptions,
    ) => {
      if (!(value instanceof Uint8Array))
        throw injectedHarnessFailure("sandbox bundle value was not bytes");
      if (
        options?.onlyIf !== undefined &&
        !(options.onlyIf instanceof Headers) &&
        options.onlyIf.etagDoesNotMatch === "*" &&
        objects.has(String(key))
      )
        return null;
      const contentType =
        options?.httpMetadata instanceof Headers
          ? (options.httpMetadata.get("content-type") ?? SANDBOX_BUNDLE_CONTENT_TYPE)
          : (options?.httpMetadata?.contentType ?? SANDBOX_BUNDLE_CONTENT_TYPE);
      const stored: StoredSandboxBundleObject = {
        bytes: Uint8Array.from(value),
        contentType,
        customMetadata: { ...options?.customMetadata },
      };
      objects.set(String(key), stored);
      return r2Object(String(key), stored, false);
    },
    head: async (key: string) => {
      const object = objects.get(String(key));
      return object === undefined ? null : r2Object(String(key), object, false);
    },
    get: async (key: string) => {
      const object = objects.get(String(key));
      return object === undefined ? null : r2Object(String(key), object, true);
    },
    delete: async (keys: string | string[]) => {
      const deleted = typeof keys === "string" ? [keys] : keys;
      deletedKeys.push(...deleted.map(String));
      for (const key of deleted) objects.delete(String(key));
    },
    list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
  } as never;
};

class InjectedHarnessFailure extends Data.TaggedError("InjectedHarnessFailure")<{
  readonly message: string;
}> {}

export const injectedHarnessFailure = (message: string): InjectedHarnessFailure =>
  new InjectedHarnessFailure({ message });

const readHarnessWriteStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const displayHarnessBytes = (bytes: Uint8Array): string =>
  Result.getOrElse(
    Result.try(() => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)),
    () => `[binary:${bytes.byteLength}]`,
  );

const unquoteHarnessShellArg = (quoted: string): string =>
  quoted.startsWith("'") && quoted.endsWith("'")
    ? quoted.slice(1, -1).replaceAll("'\\''", "'")
    : quoted;

interface StatusProjection {
  readonly id?: string;
  readonly status?: string;
}

type InitialProjection = StatusProjection | WorkspaceCreationMarker;

export type InitialStorageEntries = Partial<{
  [RECORD_KEY]: SessionRecord;
  [CREATE_IDEMPOTENCY_KEY]: CreateIdempotencyMetadata;
  [EVIDENCE_RECORD_KEY]: unknown;
  [HATCH_STATE_KEY]: unknown;
  [RUNTIME_EPOCH_KEY]: unknown;
  [SESSION_CONTROL_REVISION_KEY]: unknown;
}>;

export type InitialProjections = Readonly<{ readonly [key: string]: InitialProjection }>;

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
  newRepo: false,
  hardCapSeconds: 14_400,
};
export const CREATE_IDEMPOTENCY: CreateIdempotencyMetadata = {
  keyDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
};

const DEFAULT_CREDENTIAL_REGISTRY_GRANTS: ReadonlyArray<CredentialGrant> = [
  {
    name: "openai",
    kind: "pi-auth",
    versionRef: "version-default-pi",
    handleSlots: [
      { provider: "openai", slot: "api-key" },
      { provider: "openai-codex", slot: "access" },
    ],
    expires: 1_795_000_123_456,
  },
  {
    name: "github",
    kind: "github-cli",
    versionRef: "version-default-github",
    handleSlots: [{ provider: "github", slot: "git-https" }],
  },
];

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
  | "evidenceRetentionSchedulePostInsert"
  | "evidenceRetentionSchedulePreInsert"
  | "evidenceRetentionSchedulePreInsertOnce"
  | "hardCapSchedule"
  | "hatchHealth"
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
  readonly containerEvidenceRecorder?: SandboxEffectOptions["containerEvidenceRecorder"];
  readonly crashAfterInitialRecordCommit?: boolean;
  readonly destroyBehavior?: "pending" | "reject" | "success";
  readonly evidenceEnabled?: boolean;
  readonly evidencePreviewHostTimeoutMillis?: number;
  readonly failureStage?: HarnessFailureStage;
  readonly initialEntries?: InitialStorageEntries;
  readonly initialArtifactObjects?: ReadonlyArray<EvidenceArtifact>;
  readonly runnerDispatch?: Bindings["RUNNERS"]["getByName"] extends (name: string) => infer Stub
    ? Stub extends { dispatch: infer Dispatch }
      ? Dispatch
      : never
    : never;
  readonly runnerFetch?: (request: Request) => Promise<Response>;
  readonly initialProjections?: InitialProjections;
  readonly passivePiConsoleRelay?: PassivePiConsoleRelay;
  readonly piSessionRunning?: boolean;
  readonly previewBase?: string;
  readonly previewExposeGate?: Promise<void>;
  readonly hatchHealthGate?: Promise<void>;
  readonly hatchPublicProbe?: SandboxEffectOptions["hatchPublicProbe"];
  readonly previewRequestForwarder?: SandboxEffectOptions["previewRequestForwarder"];
  readonly hatchRequestForwarder?: SandboxEffectOptions["hatchRequestForwarder"];
  readonly repoVerifier?: SandboxEffectOptions["repoVerifier"];
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
  readonly sandboxConfigStatus?: SandboxConfigStatus;
  readonly sandboxConfigStatusFailure?: "rpc-error" | "throw";
  readonly credentialRegistryGrants?: ReadonlyArray<CredentialGrant>;
  readonly credentialRegistryIssueFailure?: boolean;
  readonly credentialRegistryGithubCliCredential?: string;
  readonly credentialRegistryGithubCliResolveFailure?: boolean;
  readonly credentialRegistryReleaseFailure?: boolean;
  readonly credentialRegistryReleaseResponseLoss?: boolean;
  readonly sandboxBundleObjects?: ReadonlyArray<{
    readonly digest: string;
    readonly gzip: Uint8Array;
  }>;
  readonly seedPinnedSandboxBundle?: boolean;
  readonly stopCallsOnStop?: boolean;
  readonly terminalDeleteFailure?: unknown;
  readonly transactionFailureCountdown?: number;
  readonly workspaceExists?: boolean;
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
  readonly sandboxBundleKeys: () => ReadonlyArray<string>;
  readonly sandboxBundleDeletedKeys: ReadonlyArray<string>;
  readonly exposedPreviewPorts: () => ReadonlyArray<number>;
  readonly stopHatchProcess: (generation: number) => void;
  readonly startRuntime: () => Promise<void>;
  readonly stopRuntime: () => Promise<void>;
  readonly memory: InMemoryFaultInjectableFake;
  readonly injectFailure: (stage: HarnessFailureStage) => void;
  readonly clearFailure: (stage?: HarnessFailureStage) => void;
  readonly read: <A>(key: string) => A | undefined;
  readonly readRecord: () => SessionRecord | undefined;
  readonly sandboxConfigStatusCallCount: () => number;
  readonly credentialGrantRequests: ReadonlyArray<unknown>;
  readonly credentialGrantReleases: ReadonlyArray<unknown>;
}

class HarnessStorage {
  readonly memory: InMemoryFaultInjectableFake;
  private alarm: number | null = null;
  private failNextGet = false;
  private readonly getCounts = new Map<string, number>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly events: string[],
    private readonly schedules: ReadonlyArray<RecordedSchedule>,
    initialEntries: InitialStorageEntries,
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
    exec: (query: string, ...bindings: ReadonlyArray<unknown>) => {
      const [callback, time] = bindings;
      if (query === "SELECT id FROM container_schedules WHERE callback = ? LIMIT 1")
        return this.schedules.flatMap((schedule, index) =>
          schedule.callback === callback ? [{ id: `schedule-${index}` }] : [],
        );
      if (query === "SELECT id FROM container_schedules WHERE callback = ? AND time > ? LIMIT 1")
        return this.schedules.flatMap((schedule, index) =>
          schedule.callback === callback &&
          schedule.when instanceof Date &&
          Math.floor(schedule.when.getTime() / 1_000) > Number(time)
            ? [{ id: `schedule-${index}` }]
            : [],
        );
      if (query !== "SELECT id FROM container_schedules WHERE callback = ? AND time = ? LIMIT 1")
        return [];
      return this.schedules.flatMap((schedule, index) =>
        schedule.callback === callback &&
        schedule.when instanceof Date &&
        Math.floor(schedule.when.getTime() / 1_000) === time
          ? [{ id: `schedule-${index}` }]
          : [],
      );
    },
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
    } else {
      this.events.push(`storage:put:${key}`);
    }
  }
}

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

const makeCredentialRegistry = (
  options: HarnessOptions,
  requests: unknown[],
  releases: unknown[],
): Bindings["CREDENTIALS"] =>
  ({
    getByName: () => ({
      issueGrants: async (input: unknown) => {
        requests.push(structuredClone(input));
        if (options.credentialRegistryIssueFailure)
          return {
            ok: false as const,
            error: { reason: "storage" as const, message: "injected registry failure" },
          };
        const sessionId =
          typeof input === "object" &&
          input !== null &&
          "sessionId" in input &&
          typeof input.sessionId === "string"
            ? input.sessionId
            : SESSION_ID;
        return {
          ok: true as const,
          value: {
            sessionId,
            grants: structuredClone(
              options.credentialRegistryGrants ?? DEFAULT_CREDENTIAL_REGISTRY_GRANTS,
            ),
          },
        };
      },
      resolveGithubCliCredential: async () =>
        options.credentialRegistryGithubCliResolveFailure
          ? {
              ok: false as const,
              error: {
                reason: "credential_missing" as const,
                message: "injected missing credential",
              },
            }
          : {
              ok: true as const,
              value: {
                value: options.credentialRegistryGithubCliCredential ?? "test-github-token",
              },
            },

      release: async (input: unknown) => {
        releases.push(structuredClone(input));
        if (options.credentialRegistryReleaseFailure)
          return {
            ok: false as const,
            error: { reason: "storage" as const, message: "injected registry failure" },
          };
        if (options.credentialRegistryReleaseResponseLoss && releases.length === 1)
          return Promise.reject(new Error("injected lost credential release response"));
        return {
          ok: true as const,
          value: {
            sessionId: SESSION_ID,
            released: true,
          },
        };
      },
    }),
  }) as never;

interface HarnessArtifactObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly customMetadata: Readonly<Record<string, string>>;
}

const initialArtifactObjectMap = (
  artifacts: HarnessOptions["initialArtifactObjects"],
): Map<string, HarnessArtifactObject> => {
  const objects = new Map<string, HarnessArtifactObject>();
  for (const artifact of artifacts ?? [])
    objects.set(artifact.objectKey, {
      bytes: new Uint8Array(artifact.bytes),
      contentType: artifact.mediaType,
      customMetadata: {
        owner: artifact.sessionId,
        job: artifact.jobId,
        frame: artifact.frameId,
        sha256: artifact.sha256,
      },
    });
  return objects;
};

const initialSandboxBundleObjectMap = (
  options: HarnessOptions,
  sandboxConfigStatus: SandboxConfigStatus,
): Map<string, StoredSandboxBundleObject> => {
  const objects = new Map<string, StoredSandboxBundleObject>();
  for (const { digest, gzip } of options.sandboxBundleObjects ?? [])
    seedSandboxBundleObject(objects, digest, gzip);
  const seedDigest = (digest: string | null | undefined): void => {
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) return;
    if (objects.has(sandboxBundleTarGzKey(digest))) return;
    seedSandboxBundleObject(objects, digest, emptyAdditionsBundleGzip());
  };
  if (options.seedPinnedSandboxBundle ?? true) {
    seedDigest(sandboxConfigStatus.activeDigest);
    seedDigest(options.initialEntries?.[RECORD_KEY]?.sandboxBundle?.digest);
  }
  return objects;
};

const harnessSuccessfulExec = (command: string, stdout = ""): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout,
  stderr: "",
  command,
  duration: 1,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const harnessExecStage = (command: string): HarnessFailureStage | "workspace" | "exec" =>
  command.startsWith("rm -rf ") ||
  command.startsWith("git init -b ") ||
  command.startsWith("git -c http.extraHeader=")
    ? "workspace"
    : command.includes("rev-parse HEAD")
      ? "downSha"
      : command.startsWith("find ") && command.includes("*.jsonl")
        ? "downRollout"
        : command.startsWith("tar -cf ")
          ? "downTar"
          : "exec";

interface HarnessExecContext {
  readonly commands: string[];
  readonly events: string[];
  readonly failures: ReadonlySet<HarnessFailureStage>;
  readonly options: HarnessOptions;
  readonly runtimeFiles: Map<string, Uint8Array>;
}

const injectedExecResult = (
  command: string,
  stage: ReturnType<typeof harnessExecStage>,
  context: HarnessExecContext,
): ExecResult | undefined => {
  if (context.options.workspaceExists === false && command === `test -d '/workspace/${SESSION_ID}'`)
    return {
      ...harnessSuccessfulExec(command),
      success: false,
      exitCode: 1,
      stderr: "workspace missing",
    };
  if (context.failures.has("workspacePrepare") && stage === "workspace")
    throw injectedHarnessFailure("injected workspace failure");
  if (context.failures.has("checkpointSync") && command === "sync")
    throw injectedHarnessFailure("injected checkpoint sync failure");
  if (context.failures.has("checkpointDefect") && command === "sync")
    return {
      ...harnessSuccessfulExec(command),
      get success(): boolean {
        throw injectedHarnessFailure("injected checkpoint defect");
      },
    };
  if (
    (stage === "downSha" && context.failures.has("downSha")) ||
    (stage === "downRollout" && context.failures.has("downRollout")) ||
    (stage === "downTar" && context.failures.has("downTar"))
  )
    throw injectedHarnessFailure(`injected ${stage} failure`);
  return undefined;
};

const applyHarnessArchiveCommand = (
  command: string,
  runtimeFiles: Map<string, Uint8Array>,
): ExecResult | undefined => {
  const failed = (): ExecResult => ({
    ...harnessSuccessfulExec(command),
    success: false,
    exitCode: 1,
  });
  const decompress = /^gzip -dc (.+) \| head -c ([0-9]+) > (.+)$/u.exec(command);
  if (decompress !== null) {
    const archive = runtimeFiles.get(unquoteHarnessShellArg(decompress[1]));
    if (archive === undefined) return failed();
    const tar = gunzipSandboxArchive(archive);
    if (Result.isFailure(tar)) return failed();
    runtimeFiles.set(
      unquoteHarnessShellArg(decompress[3]),
      tar.success.slice(0, Number(decompress[2])),
    );
    return harnessSuccessfulExec(command);
  }
  const sizeCheck = /^test "\$\(wc -c < (.+)\)" -le ([0-9]+)$/u.exec(command);
  if (sizeCheck !== null) {
    const tar = runtimeFiles.get(unquoteHarnessShellArg(sizeCheck[1]));
    return tar === undefined || tar.byteLength > Number(sizeCheck[2])
      ? failed()
      : harnessSuccessfulExec(command);
  }
  const extract = /^tar -xf (.+) -C (.+)$/u.exec(command);
  if (extract === null) return undefined;
  const tar = runtimeFiles.get(unquoteHarnessShellArg(extract[1]));
  if (tar === undefined) return failed();
  const members = parseSandboxTar(tar);
  if (Result.isFailure(members)) return failed();
  const root = unquoteHarnessShellArg(extract[2]);
  for (const member of members.success)
    if (member.type === "file") runtimeFiles.set(`${root}/${member.path}`, member.bytes);
  return harnessSuccessfulExec(command);
};

const applyHarnessFilesystemCommand = (
  command: string,
  runtimeFiles: Map<string, Uint8Array>,
): void => {
  const removeFiles = /^rm -f (.+) (.+)$/u.exec(command);
  if (removeFiles !== null) {
    runtimeFiles.delete(unquoteHarnessShellArg(removeFiles[1]));
    runtimeFiles.delete(unquoteHarnessShellArg(removeFiles[2]));
  }
  const promote = /^rm -rf (.+) && mv (.+) (.+)$/u.exec(command);
  if (promote === null) return;
  const finalRoot = unquoteHarnessShellArg(promote[1]);
  const stagingRoot = unquoteHarnessShellArg(promote[2]);
  for (const path of runtimeFiles.keys())
    if (path === finalRoot || path.startsWith(`${finalRoot}/`)) runtimeFiles.delete(path);
  for (const [path, bytes] of Array.from(runtimeFiles)) {
    if (path !== stagingRoot && !path.startsWith(`${stagingRoot}/`)) continue;
    runtimeFiles.delete(path);
    runtimeFiles.set(`${finalRoot}${path.slice(stagingRoot.length)}`, bytes);
  }
};

const makeHarnessExec =
  (context: HarnessExecContext) =>
  async (command: string, _execOptions?: ExecOptions): Promise<ExecResult> => {
    context.commands.push(command);
    const stage = harnessExecStage(command);
    context.events.push(`host:exec:${stage === "downRollout" ? "exec" : stage}`);
    const injected = injectedExecResult(command, stage, context);
    if (injected !== undefined) return injected;
    const archive = applyHarnessArchiveCommand(command, context.runtimeFiles);
    if (archive !== undefined) return archive;
    applyHarnessFilesystemCommand(command, context.runtimeFiles);
    const configured = context.options.commandStdout?.(command);
    return harnessSuccessfulExec(command, configured ?? (stage === "downSha" ? "deadbeef\n" : ""));
  };

export async function createSessionHarness(options: HarnessOptions = {}): Promise<SessionHarness> {
  const events: string[] = [];
  const schedules: RecordedSchedule[] = [];
  const credentialGrantRequests: unknown[] = [];
  const credentialGrantReleases: unknown[] = [];
  const credentialRegistry = makeCredentialRegistry(
    options,
    credentialGrantRequests,
    credentialGrantReleases,
  );
  const deletedSchedules: string[] = [];
  const aborts: string[] = [];
  const commands: string[] = [];
  const runnerOperations: RunnerOperation[] = [];
  const runnerRequests: Request[] = [];
  const piRequests: Request[] = [];
  const rawPiRequests: Request[] = [];
  const writtenFiles: Array<{ readonly path: string; readonly content: string }> = [];
  const runtimeFiles = new Map<string, Uint8Array>();
  const r2DeletedKeys: ReadonlyArray<string>[] = [];
  const artifactDeletedKeys: string[] = [];
  const sandboxBundleDeletedKeys: string[] = [];
  const exposedPreviewPorts = new Set<number>();
  const artifactObjects = initialArtifactObjectMap(options.initialArtifactObjects);
  let piSessionRunning = options.piSessionRunning ?? false;
  let rawPiContainerRunning = false;
  let runtimeStatus: "running" | "stopped" = "running";
  let hatchHealthGate = options.hatchHealthGate;
  const failures = new Set<HarnessFailureStage>();
  if (options.failureStage !== undefined) failures.add(options.failureStage);
  let sandboxConfigStatusCalls = 0;
  const defaultSandboxConfigStatus: SandboxConfigStatus = {
    revision: 0,
    activeDigest: null,
  };
  const sandboxConfigStatus = options.sandboxConfigStatus ?? defaultSandboxConfigStatus;
  const sandboxBundleObjectMap = initialSandboxBundleObjectMap(options, sandboxConfigStatus);
  const storage = new HarnessStorage(
    events,
    schedules,
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

  // lint-allow-double-cast: boundary: excluded Worker bindings retain removed provider env fields
  const env = {
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
        get: async (name: string) => ({
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
                    resourceId: `runner:${operation.sessionId}`,
                    workspace: `/runner/${operation.sessionId}`,
                  },
                ],
                InspectRuntime: () => [
                  "InspectRuntime",
                  {
                    _tag: "InspectRuntimeResult" as const,
                    phase: "running" as const,
                    resourceId: `runner:${operation.sessionId}`,
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
                    resourceId: `runner:${operation.sessionId}`,
                    workspace: `/runner/${operation.sessionId}`,
                  },
                ],
                RemoveRuntime: () => [
                  "RemoveRuntime",
                  {
                    _tag: "RemoveRuntimeResult" as const,
                    phase: "absent" as const,
                    resourceId: `runner:${operation.sessionId}`,
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
    CREDENTIALS: credentialRegistry,
    SANDBOX_CONFIG: {
      getByName: () => ({
        status: async (): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> => {
          sandboxConfigStatusCalls += 1;
          if (options.sandboxConfigStatusFailure === "throw")
            throw injectedHarnessFailure("injected sandbox config status failure");
          if (options.sandboxConfigStatusFailure === "rpc-error")
            return {
              ok: false,
              error: { reason: "storage", message: "injected sandbox config status failure" },
            };
          return {
            ok: true,
            value: sandboxConfigStatus,
          };
        },
        activate: async () => ({
          ok: true,
          value: { revision: 1, activeDigest: null },
        }),
        listRepos: async () => ({ ok: true, value: [] }),
        addRepo: async () => ({
          ok: true,
          value: {
            repo: "owner/project",
            defaultBranch: "main",
            addedAt: "2026-08-15T12:00:00.000Z",
            lastUsedAt: "2026-08-15T12:00:00.000Z",
          },
        }),
        removeRepo: async () => ({ ok: true, value: true }),
      }),
    },
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
        const object = artifactObjects.get(key);
        if (object === undefined)
          throw injectedHarnessFailure("artifact disappeared after successful put");
        return {
          key,
          size: object.bytes.byteLength,
          httpMetadata: { contentType: object.contentType },
          customMetadata: object.customMetadata,
        };
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
    SANDBOX_BUNDLE_BUCKET: makeSandboxBundleBucket(
      sandboxBundleObjectMap,
      sandboxBundleDeletedKeys,
    ),
    ASSETS: undefined as never,
    SCOTTY_TOKEN: "test-token",
    ...(options.evidenceEnabled === true ? { SCOTTY_EVIDENCE_ENABLED: "true" } : {}),
    ...(options.previewBase === undefined ? {} : { SCOTTY_PREVIEW_BASE: options.previewBase }),
    // The legacy provider bindings remain in the excluded Worker binding adapter (3A); this
    // Session-only harness deliberately omits them because the runtime reads Registry grants.
  } as unknown as Bindings;

  const sandbox = new Sandbox(ctx, env, {
    clock: options.clock,
    containerEvidenceRecorder: options.containerEvidenceRecorder,
    evidencePreviewHostTimeoutMillis: options.evidencePreviewHostTimeoutMillis,
    hatchPublicProbe:
      options.hatchPublicProbe ??
      (async () =>
        new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            [HATCH_PRIVATE_READINESS_HEADER]: "ready",
            "x-robots-tag": "noindex, nofollow, noarchive",
          },
        })),
    passivePiConsoleRelay: options.passivePiConsoleRelay,
    previewRequestForwarder: options.previewRequestForwarder,
    hatchRequestForwarder: options.hatchRequestForwarder,
    terminalSessionControl: {
      delete: async (terminalId) => {
        events.push(`host:terminal:delete:${terminalId}`);
        if (options.terminalDeleteFailure !== undefined) throw options.terminalDeleteFailure;
      },
    },
    repoVerifier:
      options.repoVerifier ??
      ({
        verify: () => Effect.succeed({ exists: true, defaultBranch: "main" }),
      } satisfies RepoVerifier["Service"]),
  });
  await Promise.all(constructorWork);
  rawPiContainerRunning = options.rawPiContainerRunning ?? false;

  Object.defineProperties(sandbox, {
    getState: {
      value: async () => ({ status: runtimeStatus }),
    },
    getContainerPlacementId: {
      value: async () => `placement-${SESSION_ID}`,
    },
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
      value: makeHarnessExec({ commands, events, failures, options, runtimeFiles }),
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
        runtimeStatus = "running";
        return { success: true, id: backup.id, dir: backup.dir };
      },
    },
    writeFile: {
      value: async (
        path: string,
        content: string | Uint8Array | ReadableStream<Uint8Array>,
      ): Promise<void> => {
        const bytes =
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content instanceof Uint8Array
              ? content
              : await readHarnessWriteStream(content);
        runtimeFiles.set(path, bytes);
        writtenFiles.push({ path, content: displayHarnessBytes(bytes) });
        events.push("host:writeFile");
        if (failures.has("downWriteManifest") && path === "/tmp/metadata.json")
          throw injectedHarnessFailure("injected manifest write failure");
      },
    },
    readFile: {
      value: async (path: string, _options?: { readonly encoding?: string }) => {
        const bytes = runtimeFiles.get(path);
        if (bytes !== undefined) return { content: new Blob([bytes]).stream() };
        const latest = writtenFiles.filter((file) => file.path === path).at(-1);
        if (latest === undefined) throw injectedHarnessFailure(`missing harness file ${path}`);
        return {
          content: new Blob([new TextEncoder().encode(latest.content)]).stream(),
        };
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
      value: async (_command: string, processOptions?: { readonly processId?: string }) => {
        const processId = processOptions?.processId ?? "generated";
        piSessionRunning = true;
        events.push(`host:pi:start:${processId}`);
        return {
          id: processId,
          status: "running" as const,
          kill: async () => {
            piSessionRunning = false;
            events.push("host:pi:kill");
          },
          waitForExit: async () => {
            if (piSessionRunning) throw injectedHarnessFailure("process is still running");
            return { exitCode: 0 };
          },
          waitForPort: async () => {
            const descriptor = await sandbox.getScottyHatchRestoreDescriptor();
            if (descriptor !== undefined)
              events.push(
                `host:hatch:extension-restore:${descriptor.hatchId}:${descriptor.generation}:${descriptor.operationNonce}:${descriptor.runtimeEpoch}`,
              );
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
              waitForExit: async () => {
                if (piSessionRunning) throw injectedHarnessFailure("process is still running");
                return { exitCode: 0 };
              },
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
        if (port !== 43_117) {
          events.push(`host:hatch:health:${port}:${pathname}`);
          const healthGate = hatchHealthGate;
          hatchHealthGate = undefined;
          await healthGate;
          return failures.has("hatchHealth")
            ? new Response("unhealthy", { status: 503 })
            : new Response("healthy");
        }
        events.push(`host:pi:fetch:${port}:${pathname}`);
        if (pathname === "/quiesce") events.push("host:hatch:extension-shutdown");
        if (pathname === "/health")
          return Response.json({ status: "ready", epoch: `pi-${SESSION_ID}` });
        if (pathname === "/snapshot") return Response.json({ epoch: `pi-${SESSION_ID}` });
        return failures.has("terminalStop") && pathname === "/quiesce"
          ? Response.json({ error: "injected Pi quiesce failure" }, { status: 502 })
          : Response.json({ status: "quiesced" });
      },
    },
    stop: {
      value: async (): Promise<void> => {
        events.push("host:stop");
        runtimeStatus = "stopped";
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
        if (
          callback === "expireRetainedEvidence" &&
          (failures.has("evidenceRetentionSchedulePreInsert") ||
            failures.delete("evidenceRetentionSchedulePreInsertOnce"))
        )
          throw injectedHarnessFailure("injected pre-insert evidence retention schedule failure");
        if (
          failures.has("hardCapSchedule") &&
          (callback === "enforceHardCap" || callback === "sessionActorHardCap")
        ) {
          throw injectedHarnessFailure("injected hard-cap schedule failure");
        }
        if (failures.has("vaporizeRetrySchedule") && callback === "retryVaporizeSession")
          throw injectedHarnessFailure("injected vaporize retry schedule failure");
        const scheduled = { when, callback, payload };
        schedules.push(scheduled);
        if (
          failures.has("evidenceRetentionSchedulePostInsert") &&
          callback === "expireRetainedEvidence"
        )
          throw injectedHarnessFailure("injected post-insert evidence retention schedule failure");
        return scheduled;
      },
    },
    listSchedules: {
      value: async (callback: string) =>
        schedules
          .filter((schedule) => schedule.callback === callback)
          .map((schedule, index) => {
            if (!(schedule.when instanceof Date))
              throw injectedHarnessFailure("retention schedule must use an absolute time");
            return {
              taskId: `schedule-${index}`,
              callback: schedule.callback,
              payload: schedule.payload,
              type: "scheduled" as const,
              time: Math.floor(schedule.when.getTime() / 1_000),
            };
          }),
    },
    deleteSchedules: {
      value: (callback: string): void => {
        deletedSchedules.push(callback);
        if (callback === "expireRetainedEvidence") {
          for (let index = schedules.length - 1; index >= 0; index -= 1) {
            if (schedules[index]?.callback === callback) schedules.splice(index, 1);
          }
        }
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
    sandboxBundleKeys: () => [...sandboxBundleObjectMap.keys()],
    sandboxBundleDeletedKeys,
    exposedPreviewPorts: () => [...exposedPreviewPorts],
    stopHatchProcess: (generation) => {
      failures.add("hatchHealth");
      events.push(`host:hatch:unexpected-stop:generation-${generation}`);
    },
    startRuntime: async () => {
      if (!rawPiContainerRunning) piSessionRunning = false;
      rawPiContainerRunning = true;
      runtimeStatus = "running";
      await sandbox.onStart();
    },
    stopRuntime: async () => {
      piSessionRunning = false;
      rawPiContainerRunning = false;
      runtimeStatus = "stopped";
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
    sandboxConfigStatusCallCount: () => sandboxConfigStatusCalls,
    credentialGrantRequests,
    credentialGrantReleases,
  };
}

export const sessionHarnessKeys = {
  actorAuthority: SESSION_ACTOR_AUTHORITY_KEY,
  actorJournalSequence: SESSION_ACTOR_JOURNAL_SEQUENCE_KEY,
  actorJournalTail: SESSION_ACTOR_JOURNAL_TAIL_KEY,
  actorMetadata: SESSION_ACTOR_METADATA_KEY,
  actorRevision: SESSION_ACTOR_REVISION_KEY,
  createIdempotency: CREATE_IDEMPOTENCY_KEY,
  evidence: EVIDENCE_RECORD_KEY,
  hatch: HATCH_STATE_KEY,
  record: RECORD_KEY,
  runtimeEpoch: RUNTIME_EPOCH_KEY,
} as const;
