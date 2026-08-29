import { Option, Result, Schema } from "effect";
import type { PiCredential } from "../../protocol/pi-auth";
import {
  CredentialGrantSchema,
  CredentialNameSchema,
  CredentialVersionRefSchema,
  formatManagedHandle,
  isManagedHandle,
  parseManagedHandle,
  type CredentialGrant,
  type ManagedHandle,
  type CredentialKind,
  type ManagedHandleSlotName,
} from "../../protocol/credentials";
import { RepositoryIdentitySchema, isRepositoryIdentity } from "../../protocol/repository";
import {
  CredentialRegistryRotationPatchSchema,
  CredentialSessionIdSchema,
  CredentialTimestampSchema,
  type CredentialRegistryRotationPatch,
} from "./credential-contracts";

export const MANAGED_PI_ACCOUNT_ID = "scotty-managed";
export const MANAGED_PI_PLAN_TYPE = "managed";

export type ManagedPiProvider = "openai" | "openai-codex";

export interface SessionRuntimeCredentials {
  readonly grants: ReadonlyArray<CredentialGrant>;
  readonly piProviders: ReadonlyArray<ManagedPiProvider>;
}

const managedHandleTextSchema = Schema.String.check(
  Schema.makeFilter(isManagedHandle, { expected: "a valid managed credential handle" }),
);

export const SessionCredentialAccessSchema = Schema.Struct({
  version: Schema.Literal(1),
  handle: managedHandleTextSchema,
  repository: Schema.optionalKey(RepositoryIdentitySchema),
});
export type SessionCredentialAccess = typeof SessionCredentialAccessSchema.Type;

export const SessionCredentialRefreshSchema = Schema.Struct({
  version: Schema.Literal(1),
  handle: managedHandleTextSchema,
  nonce: Schema.NonEmptyString,
});
export type SessionCredentialRefresh = typeof SessionCredentialRefreshSchema.Type;

export const SessionCredentialRotationSchema = Schema.Struct({
  version: Schema.Literal(1),
  handle: managedHandleTextSchema,
  nonce: Schema.NonEmptyString,
  patch: CredentialRegistryRotationPatchSchema,
});
export type SessionCredentialRotation = typeof SessionCredentialRotationSchema.Type;
export const CredentialRefreshLeaseSchema = Schema.Struct({
  sessionId: CredentialSessionIdSchema,
  name: CredentialNameSchema,
  versionRef: CredentialVersionRefSchema,
  nonce: Schema.NonEmptyString,
  startedAt: CredentialTimestampSchema,
});
export type ManagedCredentialRefreshLease = typeof CredentialRefreshLeaseSchema.Type;

export const decodeCredentialRefreshLeaseOption = Schema.decodeUnknownOption(
  CredentialRefreshLeaseSchema,
  { onExcessProperty: "error" },
);

export const decodeSessionCredentialAccessResult = Schema.decodeUnknownResult(
  SessionCredentialAccessSchema,
  { onExcessProperty: "error" },
);
export const decodeSessionCredentialRefreshResult = Schema.decodeUnknownResult(
  SessionCredentialRefreshSchema,
  { onExcessProperty: "error" },
);
export const decodeSessionCredentialRotationResult = Schema.decodeUnknownResult(
  SessionCredentialRotationSchema,
  { onExcessProperty: "error" },
);

export const grantHandle = (
  grants: ReadonlyArray<CredentialGrant>,
  kind: CredentialGrant["kind"],
  provider: string,
  slot: ManagedHandleSlotName,
): string | undefined => {
  const grant = grants.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.handleSlots.some(
        (candidateSlot) => candidateSlot.provider === provider && candidateSlot.slot === slot,
      ),
  );
  return grant === undefined
    ? undefined
    : formatManagedHandle({ name: grant.name, provider, slot });
};

export const sessionRuntimeCredentials = (
  grants: ReadonlyArray<CredentialGrant>,
): SessionRuntimeCredentials => ({
  grants,
  piProviders: [
    ...(piApiKeyHandle(grants) === undefined ? [] : (["openai"] as const)),
    ...(piAccessHandle(grants) === undefined || piRefreshHandle(grants) === undefined
      ? []
      : (["openai-codex"] as const)),
  ],
});

export const githubManagedHandle = (grants: ReadonlyArray<CredentialGrant>): string | undefined =>
  grantHandle(grants, "github-cli", "github", "git-https");

const piManagedHandle = (
  grants: ReadonlyArray<CredentialGrant>,
  provider: ManagedPiProvider,
  slot: ManagedHandleSlotName,
): string | undefined => grantHandle(grants, "pi-auth", provider, slot);

export const piApiKeyHandle = (grants: ReadonlyArray<CredentialGrant>): string | undefined =>
  piManagedHandle(grants, "openai", "api-key");

export const piAccessHandle = (grants: ReadonlyArray<CredentialGrant>): string | undefined =>
  piManagedHandle(grants, "openai-codex", "access");

export const piRefreshHandle = (grants: ReadonlyArray<CredentialGrant>): string | undefined =>
  piManagedHandle(grants, "openai-codex", "refresh");

export const piAuthJson = (credentials: SessionRuntimeCredentials): string => {
  const projected: Partial<Record<ManagedPiProvider, PiCredential>> = {};
  if (credentials.piProviders.includes("openai")) {
    const key = piApiKeyHandle(credentials.grants);
    if (key !== undefined) projected.openai = { type: "api_key", key };
  }
  if (credentials.piProviders.includes("openai-codex")) {
    const access = piAccessHandle(credentials.grants);
    const refresh = piRefreshHandle(credentials.grants);
    if (access !== undefined && refresh !== undefined)
      projected["openai-codex"] = {
        type: "oauth",
        access: managedPiAccessToken(access),
        refresh,
        expires: 0,
        accountId: MANAGED_PI_ACCOUNT_ID,
      };
  }
  return JSON.stringify(projected);
};

export const managedPiAccessToken = (accessHandle: string): string => {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: MANAGED_PI_ACCOUNT_ID,
        chatgpt_plan_type: MANAGED_PI_PLAN_TYPE,
        scotty_managed_handle: accessHandle,
      },
    }),
  );
  return `${header}.${payload}.scotty-managed`;
};

const ManagedPiTokenPayloadSchema = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({
    chatgpt_account_id: Schema.Literal(MANAGED_PI_ACCOUNT_ID),
    chatgpt_plan_type: Schema.Literal(MANAGED_PI_PLAN_TYPE),
    scotty_managed_handle: managedHandleTextSchema,
  }),
});
const decodeManagedPiTokenPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManagedPiTokenPayloadSchema),
  { onExcessProperty: "ignore" },
);

export const parseManagedPiAccessToken = (value: unknown): Option.Option<ManagedHandle> => {
  if (typeof value !== "string") return Option.none();
  const segments = value.split(".");
  if (segments.length !== 3 || segments[2] !== "scotty-managed") return Option.none();
  const encodedPayload = Result.try(() => {
    const encoded = segments[1] ?? "";
    const padded = `${encoded.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (encoded.length % 4)) % 4)}`;
    return atob(padded);
  });
  if (Result.isFailure(encodedPayload)) return Option.none();
  const payload = decodeManagedPiTokenPayload(encodedPayload.success);
  if (Option.isNone(payload)) return Option.none();
  const handle = parseManagedHandle(
    payload.value["https://api.openai.com/auth"].scotty_managed_handle,
  );
  return Option.isSome(handle) &&
    handle.value.provider === "openai-codex" &&
    handle.value.slot === "access"
    ? handle
    : Option.none();
};

export const managedPiIdToken = (accessHandle: string): string => {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      scotty_managed_handle: accessHandle,
      scotty_managed: true,
    }),
  );
  return `${header}.${payload}.scotty-managed`;
};

export const githubRepositoryFromUrl = (url: URL): string | undefined => {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const decoded = segments.map((segment) => Result.try(() => decodeURIComponent(segment)));
  if (decoded.some(Result.isFailure)) return undefined;
  const values = decoded.map((segment) => (Result.isSuccess(segment) ? segment.success : ""));
  const repository =
    url.hostname === "api.github.com"
      ? values[0] === "repos" && values[1] !== undefined && values[2] !== undefined
        ? `${values[1]}/${values[2]}`
        : undefined
      : url.hostname === "github.com" && values[0] !== undefined && values[1] !== undefined
        ? `${values[0]}/${values[1].endsWith(".git") ? values[1].slice(0, -4) : values[1]}`
        : undefined;
  return repository !== undefined && isRepositoryIdentity(repository) ? repository : undefined;
};

export const credentialKindForHandle = (handle: ManagedHandle): CredentialKind =>
  handle.provider === "github" && handle.slot === "git-https" ? "github-cli" : "pi-auth";

export const credentialGrantHasHandle = (grant: CredentialGrant, handle: ManagedHandle): boolean =>
  grant.name === handle.name &&
  grant.handleSlots.some((slot) => slot.provider === handle.provider && slot.slot === handle.slot);

const base64Url = (value: string): string =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

export type { CredentialRegistryRotationPatch };
export { CredentialGrantSchema };
