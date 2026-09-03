export type AdminFailure =
  | { readonly kind: "http"; readonly status: number; readonly message: string }
  | { readonly kind: "malformed-response"; readonly message: string }
  | { readonly kind: "network"; readonly message: string };

export type AdminResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: AdminFailure };

export interface CurrentPrincipal {
  readonly role: "owner" | "standard";
}

export interface StatsCounts {
  readonly workspacesCreated: number;
  readonly warmNow: number;
  readonly sleepingNow: number;
}

export interface StatsProject extends StatsCounts {
  readonly repository: string;
  readonly lastCreated: string;
}

export interface StatsSnapshot {
  readonly trackingSince: string | null;
  readonly overall: StatsCounts & { readonly projects: number };
  readonly projects: ReadonlyArray<StatsProject>;
}

export interface ProviderStatus {
  readonly name: "cloudflare" | "runner";
  readonly status: "configured" | "available" | "unavailable";
}

export type RunnerAction = "enable" | "drain" | "disable" | "disconnect";

export interface RunnerStatus {
  readonly name: string;
  readonly desired: "accepting" | "draining" | "disabled";
  readonly connection: "connected" | "disconnected";
  readonly lastSeenAt: string | null;
  readonly assignedSessions: number;
}

export interface DeviceClient {
  readonly id: string;
  readonly label: string;
  readonly role: "owner" | "standard";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly current: boolean;
}

export interface QrMatrix {
  readonly size: number;
  readonly rows: ReadonlyArray<string>;
}

export interface PairingGrant {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly qr: QrMatrix;
}

export interface OwnerTransfer {
  readonly id: string;
  readonly sourceOwnerClientId: string;
  readonly targetClientId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly url?: string;
  readonly qr?: QrMatrix;
}

export interface DeviceSnapshot {
  readonly clients: ReadonlyArray<DeviceClient>;
  readonly transfer: OwnerTransfer | null;
}

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

type Decoder<A> = (value: unknown) => A | undefined;

export interface AdminRequestOptions {
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
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

const isJsonObject = (value: unknown): value is JsonObject =>
  isJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === "object";

const hasOnlyKeys = (value: JsonObject, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const isTimestamp = (value: JsonValue | undefined): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isNonNegativeInteger = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const errorMessage = (value: unknown, fallback: string): string =>
  isJsonObject(value) && isJsonObject(value.error) && typeof value.error.message === "string"
    ? value.error.message
    : fallback;

const request = async <A>(
  path: string,
  decoder: Decoder<A>,
  fallback: string,
  options: AdminRequestOptions = {},
  init?: RequestInit,
): Promise<AdminResult<A>> => {
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
        failure: {
          kind: "malformed-response",
          message: "Scotty returned an unexpected response.",
        },
      }
    : { ok: true, value };
};

const decodePrincipal: Decoder<CurrentPrincipal> = (value) => {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ["kind", "scopes", "client"])) return undefined;
  if (value.kind !== "client" || !isJsonObject(value.client)) return undefined;
  return value.client.role === "owner" || value.client.role === "standard"
    ? { role: value.client.role }
    : undefined;
};

const decodeCounts = (value: JsonValue | undefined): StatsCounts | undefined => {
  if (
    !isJsonObject(value) ||
    !isNonNegativeInteger(value.workspacesCreated) ||
    !isNonNegativeInteger(value.warmNow) ||
    !isNonNegativeInteger(value.sleepingNow)
  )
    return undefined;
  return {
    workspacesCreated: value.workspacesCreated,
    warmNow: value.warmNow,
    sleepingNow: value.sleepingNow,
  };
};

export const decodeStatsSnapshot: Decoder<StatsSnapshot> = (value) => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["trackingSince", "overall", "projects"]) ||
    !(value.trackingSince === null || isTimestamp(value.trackingSince)) ||
    !isJsonObject(value.overall) ||
    !isNonNegativeInteger(value.overall.projects) ||
    !Array.isArray(value.projects)
  )
    return undefined;
  const overallCounts = decodeCounts(value.overall);
  if (overallCounts === undefined) return undefined;
  const projects: StatsProject[] = [];
  for (const item of value.projects) {
    if (
      !isJsonObject(item) ||
      typeof item.repository !== "string" ||
      !isTimestamp(item.lastCreated)
    )
      return undefined;
    const counts = decodeCounts(item);
    if (counts === undefined) return undefined;
    projects.push({ repository: item.repository, lastCreated: item.lastCreated, ...counts });
  }
  return {
    trackingSince: value.trackingSince,
    overall: { ...overallCounts, projects: value.overall.projects },
    projects,
  };
};

export const decodeProviders: Decoder<ReadonlyArray<ProviderStatus>> = (value) => {
  if (!Array.isArray(value)) return undefined;
  const providers: ProviderStatus[] = [];
  for (const item of value) {
    if (
      !isJsonObject(item) ||
      !hasOnlyKeys(item, ["name", "status"]) ||
      (item.name !== "cloudflare" && item.name !== "runner") ||
      (item.status !== "configured" && item.status !== "available" && item.status !== "unavailable")
    )
      return undefined;
    providers.push({ name: item.name, status: item.status });
  }
  return providers;
};

const decodeRunner: Decoder<RunnerStatus> = (value) => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["name", "desired", "connection", "lastSeenAt", "assignedSessions"]) ||
    typeof value.name !== "string" ||
    (value.desired !== "accepting" &&
      value.desired !== "draining" &&
      value.desired !== "disabled") ||
    (value.connection !== "connected" && value.connection !== "disconnected") ||
    !(value.lastSeenAt === null || isTimestamp(value.lastSeenAt)) ||
    !isNonNegativeInteger(value.assignedSessions)
  )
    return undefined;
  return {
    name: value.name,
    desired: value.desired,
    connection: value.connection,
    lastSeenAt: value.lastSeenAt,
    assignedSessions: value.assignedSessions,
  };
};

export const decodeRunners: Decoder<ReadonlyArray<RunnerStatus>> = (value) => {
  if (!Array.isArray(value)) return undefined;
  const runners: RunnerStatus[] = [];
  for (const item of value) {
    const runner = decodeRunner(item);
    if (runner === undefined) return undefined;
    runners.push(runner);
  }
  return runners;
};

const decodeDevice: Decoder<DeviceClient> = (value) => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, [
      "id",
      "label",
      "scopes",
      "role",
      "createdAt",
      "expiresAt",
      "lastSeenAt",
      "userAgent",
      "current",
    ]) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    (value.role !== "owner" && value.role !== "standard") ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.expiresAt) ||
    !isTimestamp(value.lastSeenAt) ||
    !(value.current === undefined || typeof value.current === "boolean")
  )
    return undefined;
  return {
    id: value.id,
    label: value.label,
    role: value.role,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    lastSeenAt: value.lastSeenAt,
    current: value.current === true,
  };
};

const decodeDevices: Decoder<ReadonlyArray<DeviceClient>> = (value) => {
  if (!Array.isArray(value)) return undefined;
  const clients: DeviceClient[] = [];
  for (const item of value) {
    const client = decodeDevice(item);
    if (client === undefined) return undefined;
    clients.push(client);
  }
  return clients;
};

const decodeQr: Decoder<QrMatrix> = (value) => {
  if (!isJsonObject(value) || !isNonNegativeInteger(value.size) || !Array.isArray(value.rows))
    return undefined;
  const rows = value.rows.filter((row): row is string => typeof row === "string");
  if (
    value.size === 0 ||
    rows.length !== value.rows.length ||
    rows.length !== value.size ||
    rows.some((row) => row.length !== value.size || /[^01]/u.test(row))
  )
    return undefined;
  return { size: value.size, rows };
};

const decodePairing: Decoder<PairingGrant> = (value) => {
  if (
    !isJsonObject(value) ||
    typeof value.id !== "string" ||
    typeof value.url !== "string" ||
    !isTimestamp(value.expiresAt)
  )
    return undefined;
  const qr = decodeQr(value.qr);
  return qr === undefined
    ? undefined
    : { id: value.id, url: value.url, expiresAt: value.expiresAt, qr };
};

const decodeTransfer = (value: unknown, issued: boolean): OwnerTransfer | null | undefined => {
  if (value === null) return null;
  if (
    !isJsonObject(value) ||
    typeof value.id !== "string" ||
    typeof value.sourceOwnerClientId !== "string" ||
    typeof value.targetClientId !== "string" ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.expiresAt)
  )
    return undefined;
  if (!issued)
    return {
      id: value.id,
      sourceOwnerClientId: value.sourceOwnerClientId,
      targetClientId: value.targetClientId,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
    };
  if (typeof value.url !== "string") return undefined;
  const qr = decodeQr(value.qr);
  return qr === undefined
    ? undefined
    : {
        id: value.id,
        sourceOwnerClientId: value.sourceOwnerClientId,
        targetClientId: value.targetClientId,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        url: value.url,
        qr,
      };
};

const decodeOk: Decoder<true> = (value) =>
  isJsonObject(value) && hasOnlyKeys(value, ["ok"]) && value.ok === true ? true : undefined;

export const readCurrentPrincipal = (options?: AdminRequestOptions) =>
  request("/api/auth/me", decodePrincipal, "Your browser access could not be checked.", options);

export const readStats = (options?: AdminRequestOptions) =>
  request("/api/stats", decodeStatsSnapshot, "Workspace stats could not be loaded.", options);

export const readProviders = (options?: AdminRequestOptions) =>
  request("/api/providers", decodeProviders, "Provider status could not be loaded.", options);

export const readRunners = (options?: AdminRequestOptions) =>
  request("/api/runners", decodeRunners, "Runner status could not be loaded.", options);

export const readDevices = async (
  options: AdminRequestOptions = {},
): Promise<AdminResult<DeviceSnapshot>> => {
  const [clients, transfer] = await Promise.all([
    request("/api/auth/clients", decodeDevices, "Registered devices could not be loaded.", options),
    request(
      "/api/auth/owner-transfers/current",
      (value) => decodeTransfer(value, false),
      "Ownership transfer status could not be loaded.",
      options,
    ),
  ]);
  if (!clients.ok) return clients;
  if (!transfer.ok) return transfer;
  return { ok: true, value: { clients: clients.value, transfer: transfer.value } };
};

export const runRunnerAction = (
  name: string,
  action: RunnerAction,
  options?: AdminRequestOptions,
) =>
  request(
    `/api/runners/${encodeURIComponent(name)}/${action}`,
    decodeRunner,
    `Runner could not ${action}.`,
    options,
    { method: "POST" },
  );

export const issuePairing = (label: string, options?: AdminRequestOptions) =>
  request("/api/auth/pairings", decodePairing, "Pairing link could not be created.", options, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(label.length === 0 ? {} : { label }),
  });

export const revokeDevice = (id: string, options?: AdminRequestOptions) =>
  request(
    `/api/auth/clients/${encodeURIComponent(id)}`,
    decodeOk,
    "Device access could not be revoked.",
    options,
    { method: "DELETE" },
  );

export const startOwnerTransfer = (targetClientId: string, options?: AdminRequestOptions) =>
  request(
    "/api/auth/owner-transfers",
    (value) => decodeTransfer(value, true) ?? undefined,
    "Primary-device transfer could not be created.",
    options,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ targetClientId }),
    },
  );

export const cancelOwnerTransfer = (id: string, options?: AdminRequestOptions) =>
  request(
    `/api/auth/owner-transfers/${encodeURIComponent(id)}`,
    decodeOk,
    "Primary-device transfer could not be cancelled.",
    options,
    { method: "DELETE" },
  );
