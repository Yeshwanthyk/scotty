export type ChangedFileStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "untracked";

export interface ChangedFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ChangedFileStatus;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary: boolean;
  readonly patchable: boolean;
}

export interface ChangedFilePatch extends ChangedFile {
  readonly patch: string | null;
  readonly truncated: boolean;
}

export interface EvidenceSummary {
  readonly jobId: string;
  readonly status: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly frameCount: number;
  readonly recordVideo: boolean;
  readonly steps: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly frameId?: string;
  }>;
}

export interface HatchSummary {
  readonly configured: boolean;
  readonly hatchId?: string;
  readonly serviceName?: string;
  readonly status?: string;
  readonly available: boolean;
}

export type WorkbenchFailure = { readonly message: string };

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}
const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
};
const isObject = (value: unknown): value is JsonObject =>
  isJsonValue(value) && value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const readJson = async (path: string, signal?: AbortSignal): Promise<unknown> => {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const message =
      isObject(body) && isObject(body.error) && isString(body.error.message)
        ? body.error.message
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json();
};

const changedStatuses = new Set<ChangedFileStatus>([
  "added",
  "copied",
  "deleted",
  "modified",
  "renamed",
  "type_changed",
  "unmerged",
  "untracked",
]);

const decodeChangedFile = (value: unknown): ChangedFile | undefined => {
  if (
    !isObject(value) ||
    !isString(value.path) ||
    !isString(value.status) ||
    !changedStatuses.has(value.status as ChangedFileStatus) ||
    !isBoolean(value.staged) ||
    !isBoolean(value.unstaged) ||
    !isBoolean(value.binary) ||
    !isBoolean(value.patchable) ||
    (value.oldPath !== undefined && !isString(value.oldPath)) ||
    (value.additions !== undefined && !isNumber(value.additions)) ||
    (value.deletions !== undefined && !isNumber(value.deletions))
  )
    return undefined;
  return {
    path: value.path,
    status: value.status as ChangedFileStatus,
    staged: value.staged,
    unstaged: value.unstaged,
    binary: value.binary,
    patchable: value.patchable,
    ...(isString(value.oldPath) ? { oldPath: value.oldPath } : {}),
    ...(isNumber(value.additions) ? { additions: value.additions } : {}),
    ...(isNumber(value.deletions) ? { deletions: value.deletions } : {}),
  };
};

export const readChangedFiles = async (
  sessionId: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ChangedFile>> => {
  const value = await readJson(`/api/sessions/${encodeURIComponent(sessionId)}/changes`, signal);
  if (!isObject(value) || !Array.isArray(value.files)) throw new Error("Unreadable changes list");
  const files = value.files.map(decodeChangedFile);
  if (files.some((file) => file === undefined)) throw new Error("Unreadable changed file");
  return files.filter((file): file is ChangedFile => file !== undefined);
};

export const readChangedFilePatch = async (
  sessionId: string,
  file: ChangedFile,
  signal?: AbortSignal,
): Promise<ChangedFilePatch> => {
  const value = await readJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/changes/patch?path=${encodeURIComponent(file.path)}`,
    signal,
  );
  const decoded = decodeChangedFile(value);
  if (
    decoded === undefined ||
    !isObject(value) ||
    (value.patch !== null && !isString(value.patch)) ||
    !isBoolean(value.truncated)
  )
    throw new Error("Unreadable file patch");
  return { ...decoded, patch: value.patch, truncated: value.truncated };
};

const decodeEvidence = (value: unknown): EvidenceSummary | undefined => {
  if (
    !isObject(value) ||
    !isString(value.jobId) ||
    !isString(value.status) ||
    !isNumber(value.totalSteps) ||
    !isNumber(value.completedSteps) ||
    !isNumber(value.frameCount) ||
    !isBoolean(value.recordVideo) ||
    !Array.isArray(value.steps)
  )
    return undefined;
  const steps = value.steps.flatMap((step) => {
    if (!isObject(step) || !isString(step.name) || !isString(step.status)) return [];
    const frameId =
      isObject(step.frame) && isString(step.frame.frameId) ? step.frame.frameId : undefined;
    return [
      { name: step.name, status: step.status, ...(frameId === undefined ? {} : { frameId }) },
    ];
  });
  if (steps.length !== value.steps.length) return undefined;
  return {
    jobId: value.jobId,
    status: value.status,
    totalSteps: value.totalSteps,
    completedSteps: value.completedSteps,
    frameCount: value.frameCount,
    recordVideo: value.recordVideo,
    steps,
  };
};

export const readEvidence = async (
  sessionId: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<EvidenceSummary>> => {
  const value = await readJson(`/api/sessions/${encodeURIComponent(sessionId)}/evidence`, signal);
  if (!Array.isArray(value)) throw new Error("Unreadable evidence list");
  const jobs = value.map(decodeEvidence);
  if (jobs.some((job) => job === undefined)) throw new Error("Unreadable evidence result");
  return jobs.filter((job): job is EvidenceSummary => job !== undefined);
};

export const readHatch = async (sessionId: string, signal?: AbortSignal): Promise<HatchSummary> => {
  const value = await readJson(`/api/sessions/${encodeURIComponent(sessionId)}/hatch`, signal);
  if (isObject(value) && value.status === "not_configured")
    return { configured: false, available: false };
  if (
    !isObject(value) ||
    value.status !== "configured" ||
    !isString(value.hatchId) ||
    !isObject(value.service) ||
    !isString(value.service.name) ||
    !isString(value.observedStatus) ||
    !isString(value.desiredStatus) ||
    !isString(value.exposure)
  )
    throw new Error("Unreadable Hatch status");
  return {
    configured: true,
    hatchId: value.hatchId,
    serviceName: value.service.name,
    status: value.observedStatus,
    available:
      value.observedStatus === "running" &&
      value.desiredStatus === "open" &&
      value.exposure === "active",
  };
};
