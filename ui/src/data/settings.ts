import type { CloudSettings, CloudSettingsSnapshot } from "../../../protocol/cloud-settings";
import {
  decodeCloudSettingsSnapshot as decodeSnapshotResult,
  CloudSettingsSchema,
} from "../../../protocol/cloud-settings";
import { Option, Result, Schema } from "effect";
import type { RepositoryRegistryEntry } from "../../../protocol/repository";
import {
  CloudResourceKindSchema,
  CloudResourceNameSchema,
  CloudResourceFileSchema,
  type CloudResourceKind,
  type CloudResourceFile,
} from "../../../protocol/cloud-resources";

export interface CredentialStatus {
  readonly name: string;
  readonly kind: "pi-auth" | "github-cli";
  readonly scope: "global" | "repository";
  readonly repositories?: ReadonlyArray<string>;
  readonly configured: boolean;
  readonly versionRef: string;
  readonly expires?: number;
}

export type SettingsFailure =
  | { readonly kind: "http"; readonly status: number; readonly message: string }
  | { readonly kind: "malformed-response"; readonly message: string }
  | { readonly kind: "network"; readonly message: string };

export type SettingsResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: SettingsFailure };

export interface SettingsRequestOptions {
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}

interface UnknownObject {
  readonly [key: string]: unknown;
}

const errorMessage = (value: unknown, fallback: string): string => {
  if (!isRecord(value)) return fallback;
  const error = value.error;
  if (!isRecord(error)) return fallback;
  return typeof error.message === "string" ? error.message : fallback;
};

const isRecord = (value: unknown): value is UnknownObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: UnknownObject, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
};

const stringValue = (value: unknown): value is string => typeof value === "string";

const decodeSettingsOption = Schema.decodeUnknownOption(CloudSettingsSchema, {
  onExcessProperty: "error",
});
export const decodeCloudSettings = (value: unknown): CloudSettings | undefined =>
  Option.getOrUndefined(decodeSettingsOption(value));

export const decodeCloudSettingsSnapshot = (value: unknown): CloudSettingsSnapshot | undefined => {
  const decoded = decodeSnapshotResult(value);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const decodeRepository = (value: unknown): RepositoryRegistryEntry | undefined => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["repo", "defaultBranch", "addedAt", "lastUsedAt"]) ||
    !stringValue(value.repo) ||
    !stringValue(value.defaultBranch) ||
    !stringValue(value.addedAt) ||
    !stringValue(value.lastUsedAt) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.addedAt) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.lastUsedAt)
  )
    return undefined;
  return value as RepositoryRegistryEntry;
};

const decodeRepositories = (value: unknown): ReadonlyArray<RepositoryRegistryEntry> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map(decodeRepository);
  return entries.some((entry) => entry === undefined)
    ? undefined
    : (entries as RepositoryRegistryEntry[]);
};

const decodeCredentials = (value: unknown): ReadonlyArray<CredentialStatus> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const statuses: CredentialStatus[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !exactKeys(item, [
        "name",
        "kind",
        "scope",
        "configured",
        "versionRef",
        ...(item.repositories === undefined ? [] : ["repositories"]),
        ...(item.expires === undefined ? [] : ["expires"]),
      ]) ||
      !stringValue(item.name) ||
      !["pi-auth", "github-cli"].includes(String(item.kind)) ||
      !["global", "repository"].includes(String(item.scope)) ||
      typeof item.configured !== "boolean" ||
      !stringValue(item.versionRef)
    )
      return undefined;
    if (
      item.repositories !== undefined &&
      (!Array.isArray(item.repositories) || item.repositories.some((repo) => !stringValue(repo)))
    )
      return undefined;
    if (
      item.expires !== undefined &&
      (typeof item.expires !== "number" || !Number.isFinite(item.expires))
    )
      return undefined;
    statuses.push({
      name: item.name,
      kind: item.kind as CredentialStatus["kind"],
      scope: item.scope as CredentialStatus["scope"],
      configured: item.configured,
      versionRef: item.versionRef,
      ...(item.repositories === undefined ? {} : { repositories: item.repositories }),
      ...(item.expires === undefined ? {} : { expires: item.expires }),
    });
  }
  return statuses;
};

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const ResourceSummarySchema = Schema.Struct({
  kind: CloudResourceKindSchema,
  name: CloudResourceNameSchema,
  shape: Schema.Literals(["file", "directory"]),
  digest: Digest,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      size: Schema.Int,
      modeClass: Schema.Literals(["regular", "executable"]),
      digest: Digest,
    }),
  ),
});
const ResourceSnapshotSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  activeDigest: Schema.NullOr(Digest),
  items: Schema.Array(ResourceSummarySchema),
});
const ResourceDetailSchema = Schema.Struct({
  kind: CloudResourceKindSchema,
  name: CloudResourceNameSchema,
  shape: Schema.Literals(["file", "directory"]),
  files: Schema.Array(CloudResourceFileSchema),
});
export type ResourceSummary = typeof ResourceSummarySchema.Type;
export type ResourceSnapshot = typeof ResourceSnapshotSchema.Type;
export type ResourceDetail = typeof ResourceDetailSchema.Type;
const resourceSnapshotDecoder = Schema.decodeUnknownOption(ResourceSnapshotSchema, {
  onExcessProperty: "error",
});
const resourceDetailDecoder = Schema.decodeUnknownOption(ResourceDetailSchema, {
  onExcessProperty: "error",
});
const decodeResourceSnapshot = (value: unknown): ResourceSnapshot | undefined =>
  Option.getOrUndefined(resourceSnapshotDecoder(value));
const decodeResourceDetail = (value: unknown): ResourceDetail | undefined =>
  Option.getOrUndefined(resourceDetailDecoder(value));

const request = async <A>(
  path: string,
  decoder: (value: unknown) => A | undefined,
  fallback: string,
  options: SettingsRequestOptions = {},
  init?: RequestInit,
): Promise<SettingsResult<A>> => {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", ...init?.headers },
      signal: options.signal,
    });
  } catch {
    return { ok: false, failure: { kind: "network", message: fallback } };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    return {
      ok: false,
      failure: { kind: "http", status: response.status, message: errorMessage(body, fallback) },
    };
  const value = decoder(body);
  return value === undefined
    ? {
        ok: false,
        failure: { kind: "malformed-response", message: "Scotty returned an unexpected response." },
      }
    : { ok: true, value };
};

export const readCloudSettings = (options?: SettingsRequestOptions) =>
  request(
    "/api/settings",
    decodeCloudSettingsSnapshot,
    "Cloud settings could not be loaded.",
    options,
  );

export const updateCloudSettings = (
  update: { readonly expectedRevision: number; readonly settings: CloudSettings },
  options: SettingsRequestOptions = {},
) =>
  (() => {
    const idempotencyKey = crypto.randomUUID();
    return request(
      "/api/settings",
      decodeCloudSettingsSnapshot,
      "Cloud settings could not be saved.",
      options,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ ...update, idempotencyKey }),
      },
    );
  })();

export const readRepositories = (options?: SettingsRequestOptions) =>
  request("/api/repos", decodeRepositories, "Repositories could not be loaded.", options);

export const readCredentials = (options?: SettingsRequestOptions) =>
  request("/api/credentials", decodeCredentials, "Connections could not be loaded.", options);

export const addRepository = (repo: string, options?: SettingsRequestOptions) =>
  request("/api/repos", decodeRepository, "Repository could not be added.", options, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo }),
  });

export const removeRepository = (repo: string, options?: SettingsRequestOptions) =>
  request(
    `/api/repos/${repo.split("/").map(encodeURIComponent).join("/")}`,
    (value) =>
      isRecord(value) && stringValue(value.repo) && typeof value.removed === "boolean"
        ? value
        : undefined,
    "Repository could not be removed.",
    options,
    { method: "DELETE" },
  );

const resourcePath = (kind: CloudResourceKind, name: string): string =>
  `/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;

export const readResources = (options?: SettingsRequestOptions) =>
  request("/api/resources", decodeResourceSnapshot, "Resources could not be loaded.", options);

export const readResource = (
  kind: CloudResourceKind,
  name: string,
  options?: SettingsRequestOptions,
) =>
  request(resourcePath(kind, name), decodeResourceDetail, "Resource could not be loaded.", options);

export const saveResource = (
  kind: CloudResourceKind,
  name: string,
  update: {
    readonly expectedRevision: number;
    readonly shape: "file" | "directory";
    readonly files: ReadonlyArray<CloudResourceFile>;
  },
  options?: SettingsRequestOptions,
) =>
  request(
    resourcePath(kind, name),
    decodeResourceSnapshot,
    "Resource could not be saved.",
    options,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...update, idempotencyKey: crypto.randomUUID() }),
    },
  );

export const removeResource = (
  kind: CloudResourceKind,
  name: string,
  expectedRevision: number,
  options?: SettingsRequestOptions,
) =>
  request(
    resourcePath(kind, name),
    decodeResourceSnapshot,
    "Resource could not be removed.",
    options,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision, idempotencyKey: crypto.randomUUID() }),
    },
  );
