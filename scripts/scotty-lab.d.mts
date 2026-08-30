import type { ChildProcess } from "node:child_process";

export interface LabManifest {
  readonly version: 1;
  readonly runId: string;
  readonly workerName: string;
  readonly status: "starting" | "running" | "cleanup-pending";
  readonly createdAt: string;
  readonly tempRoot: string;
  readonly tokenFile: string;
  readonly cliHome: string;
  readonly persistPath: string;
  readonly envFile: string;
  readonly logFile: string;
  readonly host: string;
  readonly port: number;
  readonly pid?: number;
  readonly processStartTime?: string;
}

export interface PreparedStart {
  readonly dockerConfig: string;
  readonly dockerHost: string;
  readonly secrets: ReadonlyArray<string>;
}

export interface StartedWrangler {
  readonly child: ChildProcess;
  readonly log: ReadonlyArray<string>;
  readonly flushLog: () => void;
}

export interface ProcessResult {
  readonly validation: { readonly status: "owned" | "missing" | "mismatch" };
  readonly stopped: boolean;
  readonly error?: string;
}

export interface CredentialSetupInputs {
  readonly piAuthPath: string;
  readonly githubConfigDir: string;
  readonly githubHome: string;
  readonly githubExecutable: string;
}

export function acquireLifecycleLock(): number;
export function releaseLifecycleLock(descriptor: number): void;
export function createStartReservation(createdAt: string): LabManifest;
export function prepareStart(manifest: LabManifest): Promise<PreparedStart>;
export function launchWrangler(
  manifest: LabManifest,
  prepared: PreparedStart,
): Promise<{ readonly manifest: LabManifest; readonly started: StartedWrangler }>;
export function awaitWrangler(
  manifest: LabManifest,
  started: StartedWrangler,
  signal?: AbortSignal,
): Promise<void>;
export function terminateStartedWrangler(started: StartedWrangler): Promise<void>;
export function completeStart(manifest: LabManifest, started: StartedWrangler): LabManifest;
export function startupFailureDetails(
  error: unknown,
  secrets: ReadonlyArray<string>,
  started: StartedWrangler | undefined,
  cleanupErrors: ReadonlyArray<string>,
): string;
export function terminateManifestProcess(manifest: LabManifest): Promise<ProcessResult>;
export function removeWorkerContainers(manifest: LabManifest): ReadonlyArray<string>;
export function cleanupOwnedFiles(manifest: LabManifest): ReadonlyArray<string>;
export function removeOwnedTempRoot(manifest: LabManifest): void;
export function markCleanupPending(manifest: LabManifest): void;
export function execManifest(runId: string): LabManifest;
export function prepareCredentialSetup(
  manifest: LabManifest,
  repo: string,
  inputs?: CredentialSetupInputs,
): { readonly credentialBin: string };
export function spawnCli(
  manifest: LabManifest,
  argv: ReadonlyArray<string>,
  explicitEnvironment?: Readonly<Record<string, string>>,
): ChildProcess;
export function stopManifest(runId: string, manifestPath?: string): LabManifest;
