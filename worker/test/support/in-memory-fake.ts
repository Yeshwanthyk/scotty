import type { BackupOptions, ExecResult, RestoreBackupResult } from "@cloudflare/sandbox";
import type { BackupCapabilities, BackupObjectPage } from "../../src/backup-store";
import type { DirectoryBackup, StoredCredential } from "../../src/contracts";
import type {
  CredentialVaultStorage,
  CredentialVaultTransaction,
} from "../../src/credential-vault";
import type { RepoProjectionStorage } from "../../src/repo-projection";
import type { SandboxExecOptions, SandboxRuntimeCapabilities } from "../../src/sandbox-runtime";
import type { SessionProjectionStorage } from "../../src/session-projection";
import type { SessionRecordStorage, SessionRecordTransaction } from "../../src/session-store";

interface InjectedFailure {
  readonly error: unknown;
  remaining: number;
  countdown: number;
}

type Handler = (...args: ReadonlyArray<unknown>) => unknown | Promise<unknown>;

export class InMemoryFaultInjectableFake<Operation extends string = string> {
  value: unknown | undefined;
  readonly values = new Map<string, unknown>();
  readonly pages: BackupObjectPage[] = [];
  private readonly callLog = new Map<Operation, Array<ReadonlyArray<unknown>>>();
  private readonly failures = new Map<Operation, InjectedFailure>();
  private readonly handlers = new Map<Operation, Handler>();
  private readonly responses = new Map<Operation, unknown>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(value?: unknown) {
    this.value = structuredClone(value);
  }

  calls(operation: Operation): ReadonlyArray<ReadonlyArray<unknown>> {
    return this.callLog.get(operation) ?? [];
  }

  injectFailure(
    operation: Operation,
    options: {
      readonly countdown?: number;
      readonly error?: unknown;
      readonly times?: number;
    } = {},
  ): void {
    this.failures.set(operation, {
      countdown: options.countdown ?? 0,
      error: options.error ?? `${operation} failed`,
      remaining: options.times ?? Number.POSITIVE_INFINITY,
    });
  }

  clearFailure(operation?: Operation): void {
    if (operation === undefined) this.failures.clear();
    else this.failures.delete(operation);
  }

  respond(operation: Operation, value: unknown): void {
    this.responses.set(operation, value);
  }

  handle(operation: Operation, handler: Handler): void {
    this.handlers.set(operation, handler);
  }

  snapshot(): unknown | undefined {
    return structuredClone(this.value);
  }

  async invoke<A>(
    operation: Operation,
    args: ReadonlyArray<unknown> = [],
    fallback?: () => A | Promise<A>,
  ): Promise<A> {
    const calls = this.callLog.get(operation) ?? [];
    calls.push(args);
    this.callLog.set(operation, calls);

    const failure = this.failures.get(operation);
    if (failure !== undefined && failure.countdown > 0) {
      failure.countdown -= 1;
    } else if (failure !== undefined && failure.remaining > 0) {
      failure.remaining -= 1;
      throw failure.error;
    }

    const handler = this.handlers.get(operation);
    if (handler !== undefined) return (await handler(...args)) as A;
    if (this.responses.has(operation)) return this.responses.get(operation) as A;
    if (fallback !== undefined) return fallback();
    return undefined as A;
  }

  async transaction<A>(
    operation: (value: {
      readonly get: () => Promise<unknown | undefined>;
      readonly put: (next: unknown) => Promise<void>;
      readonly delete: () => Promise<void>;
    }) => Promise<A>,
  ): Promise<A> {
    return this.invoke("transaction" as Operation, [], async () => {
      const preceding = this.transactionTail;
      let unlock = (): void => undefined;
      this.transactionTail = new Promise((resolve) => {
        unlock = resolve;
      });
      await preceding;
      let staged = structuredClone(this.value);
      try {
        const result = await operation({
          get: async () => structuredClone(staged),
          put: async (next) => {
            staged = structuredClone(next);
          },
          delete: async () => {
            staged = undefined;
          },
        });
        this.value = staged;
        return result;
      } finally {
        unlock();
      }
    });
  }
}

export const sessionRecordStorageFake = (
  memory = new InMemoryFaultInjectableFake(),
): SessionRecordStorage => ({
  get: () => memory.invoke("get", [], () => memory.snapshot()),
  deleteCreateIdempotency: () =>
    memory.invoke("deleteCreateIdempotency", [], () => {
      memory.values.delete("scotty:create-idempotency");
    }),
  put: (record) =>
    memory.invoke("put", [record], () => {
      memory.value = structuredClone(record);
    }),
  transaction: <A>(operation: (transaction: SessionRecordTransaction) => Promise<A>) =>
    memory.transaction((transaction) =>
      operation({
        get: transaction.get,
        put: (record) => transaction.put(record),
      }),
    ),
});

export const credentialVaultStorageFake = (
  memory = new InMemoryFaultInjectableFake(),
): CredentialVaultStorage => ({
  transaction: <A>(operation: (transaction: CredentialVaultTransaction) => Promise<A>) =>
    memory.transaction((transaction) =>
      operation({
        get: transaction.get,
        put: (credential: StoredCredential) => transaction.put(credential),
        delete: transaction.delete,
      }),
    ),
});

export interface InMemoryCredentialVaultStorage extends CredentialVaultStorage {
  readonly snapshot: () => unknown | undefined;
}

export const makeCredentialVaultStorageFake = (
  initial?: unknown,
  memory = new InMemoryFaultInjectableFake(initial),
): InMemoryCredentialVaultStorage => {
  return {
    ...credentialVaultStorageFake(memory),
    snapshot: () => memory.snapshot(),
  };
};

const projectionGet = (memory: InMemoryFaultInjectableFake, key: string): Promise<unknown | null> =>
  memory.invoke("get", [key], () => memory.values.get(key) ?? null);

const projectionList = (
  memory: InMemoryFaultInjectableFake,
  cursor?: string,
): Promise<{ keys: ReadonlyArray<string> }> =>
  memory.invoke("list", [cursor], () => ({ keys: [...memory.values.keys()] }));

const projectionPut = (
  memory: InMemoryFaultInjectableFake,
  key: string,
  value: string,
): Promise<void> =>
  memory.invoke("put", [key, value], () => {
    memory.values.set(key, JSON.parse(value));
  });

export const sessionProjectionStorageFake = (
  memory = new InMemoryFaultInjectableFake(),
): SessionProjectionStorage => ({
  delete: (key) =>
    memory.invoke("delete", [key], () => {
      memory.values.delete(key);
    }),
  get: (key) => projectionGet(memory, key),
  list: (cursor) => projectionList(memory, cursor),
  put: (key, value) => projectionPut(memory, key, value),
});

export const repoProjectionStorageFake = (
  memory = new InMemoryFaultInjectableFake(),
): RepoProjectionStorage => ({
  delete: (key) =>
    memory.invoke("delete", [key], () => {
      memory.values.delete(key);
    }),
  get: (key) => projectionGet(memory, key),
  list: (cursor) => projectionList(memory, cursor),
  put: (key, value) => projectionPut(memory, key, value),
});

export const backupCapabilitiesFake = (
  memory = new InMemoryFaultInjectableFake(),
  backup: DirectoryBackup = {
    id: "backup-1",
    dir: "/workspace/a0b1c2d3e4f5",
    localBucket: true,
  },
): BackupCapabilities => ({
  createBackup: (options: BackupOptions) => memory.invoke("create", [options], () => backup),
  restoreBackup: (value: DirectoryBackup) =>
    memory.invoke<RestoreBackupResult>("restore", [value], () => ({
      success: true,
      id: value.id,
      dir: value.dir,
    })),
  listObjects: (prefix, cursor) =>
    memory.invoke("list", [prefix, cursor], () => memory.pages.shift() ?? { keys: [] }),
  deleteObjects: (keys) => memory.invoke("delete", [keys]),
});

const defaultExecResult = (): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  command: "true",
  duration: 5,
  timestamp: "2026-07-22T00:00:00.000Z",
});

export const sandboxRuntimeCapabilitiesFake = (
  memory = new InMemoryFaultInjectableFake(),
): SandboxRuntimeCapabilities => ({
  exec: (command: string, options?: SandboxExecOptions) =>
    memory.invoke("exec", [command, options], defaultExecResult),
  mkdir: (path, options) =>
    memory.invoke("mkdir", [path, options], () => ({
      success: true,
      path,
      message: "ok",
    })),
  writeFile: (path, content) =>
    memory.invoke("writeFile", [path, content], () => ({
      success: true,
      path,
      bytesWritten: content.length,
    })),
  setEnvVars: (envVars) => memory.invoke("setEnvVars", [envVars]),
});

export type SessionRecordStorageFactory = (initial?: unknown) => {
  readonly memory: InMemoryFaultInjectableFake;
  readonly storage: SessionRecordStorage;
};

export const makeSessionRecordStorageFake: SessionRecordStorageFactory = (initial) => {
  const memory = new InMemoryFaultInjectableFake(initial);
  return { memory, storage: sessionRecordStorageFake(memory) };
};
