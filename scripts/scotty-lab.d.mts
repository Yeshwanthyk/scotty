import type { ChildProcess } from "node:child_process";
import type { SessionActorDiagnostics } from "../worker/src/session-actor/diagnostics";

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

export interface EvidenceUnavailable {
  readonly status: "not-available";
  readonly reason: string;
}

export interface EvidenceAvailable {
  readonly status: "available";
  readonly snapshots: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface EvidenceManifest {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly workerName: string;
  readonly ownedSessionIds: ReadonlyArray<string>;
  readonly scenarioResults: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly cleanupResult: Readonly<Record<string, unknown>>;
  readonly sessionOwnershipUpdatedAt?: string;
  readonly observations: {
    readonly actorAuthorityRevision: EvidenceUnavailable | EvidenceAvailable;
    readonly operationJournal: EvidenceUnavailable | EvidenceAvailable;
    readonly providerSnapshot: EvidenceUnavailable;
  };
}

export interface EvidencePaths {
  readonly directory: string;
  readonly manifest: string;
  readonly commands: string;
}

export const EVIDENCE_DIRECTORY: string;
export const PROTECTED_SESSION_ID: string;
export function evidencePathsForRunId(runId: string, evidenceDirectory?: string): EvidencePaths;
export function ensureEvidenceRun(manifest: LabManifest, evidenceDirectory?: string): EvidencePaths;
export function readEvidenceManifest(runId: string, evidenceDirectory?: string): EvidenceManifest;
export function recordOwnedSession(
  manifest: LabManifest,
  sessionId: string,
  recordedAt: string,
  evidenceDirectory?: string,
): EvidenceManifest;
export function isOwnedSession(
  manifest: LabManifest,
  sessionId: string,
  evidenceDirectory?: string,
): boolean;
export function recordScenarioResult(
  manifest: LabManifest,
  result: Readonly<Record<string, unknown>>,
  evidenceDirectory?: string,
): EvidenceManifest;
export function recordCleanupResult(
  manifest: LabManifest,
  result: Readonly<Record<string, unknown>>,
  evidenceDirectory?: string,
): EvidenceManifest;
export function recordActorDiagnostics(
  manifest: LabManifest,
  observation: {
    readonly scenario: string;
    readonly sessionId: string;
    readonly observedAt: string;
    readonly diagnostics: SessionActorDiagnostics;
  },
  evidenceDirectory?: string,
): EvidenceManifest;
export function appendEvidenceCommand(
  manifest: LabManifest,
  record: Readonly<Record<string, unknown>>,
  evidenceDirectory?: string,
): void;
export function assertLifecycleSessionId(sessionId: string): string;

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
export function activeRunManifest(): LabManifest;
export function prepareCredentialSetup(
  manifest: LabManifest,
  repo: string,
  inputs?: CredentialSetupInputs,
): { readonly credentialBin: string };
export function spawnCli(
  manifest: LabManifest,
  argv: ReadonlyArray<string>,
  explicitEnvironment?: Readonly<Record<string, string>>,
  stdio?: "inherit" | "pipe",
): ChildProcess;
export function sanitizeEvidenceText(manifest: LabManifest, value: string): string;
export function sleepSession(
  manifest: LabManifest,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ readonly status: number; readonly body: string }>;
export function readActorDiagnostics(
  manifest: LabManifest,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ readonly status: number; readonly body: string }>;
export function stopManifest(runId: string, manifestPath?: string): LabManifest;
