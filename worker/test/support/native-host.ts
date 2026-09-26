import type { Bindings } from "../../src/shared/bindings";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test stand-ins for host objects whose full native shape is unavailable outside Workers. */
export const nativeSandboxNamespace = (value: unknown): Bindings["SANDBOX"] => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Cloudflare owns the full Durable Object namespace contract; tests supply only exercised methods.
  return value as Bindings["SANDBOX"];
};

export const nativeBindings = (value: unknown): Bindings => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Cloudflare supplies remaining Worker bindings in production.
  return value as Bindings;
};

export const nativeR2Bucket = (value: unknown): R2Bucket => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- R2 bucket methods outside the tested adapter are native host methods.
  return value as R2Bucket;
};

export const nativeKvNamespace = (value: unknown): KVNamespace => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- KVNamespace is supplied by the Cloudflare host; this fixture implements the exercised methods.
  return value as KVNamespace;
};

export const nativeCredentialNamespace = (value: unknown): Bindings["CREDENTIALS"] => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Durable Object RPC namespace methods are host generated.
  return value as Bindings["CREDENTIALS"];
};

export const nativeR2Object = (value: unknown): R2Object => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- R2 owns the full object implementation; this fixture provides adapter-visible fields.
  return value as R2Object;
};

export const nativeR2ObjectBody = (value: unknown): R2ObjectBody => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- R2 owns the full body implementation; this fixture provides adapter-visible fields.
  return value as R2ObjectBody;
};

export const nativeR2JsonValue = <A>(value: unknown): A => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Native R2ObjectBody.json is a caller-selected generic API without a runtime schema.
  return value as A;
};

export const nativeDurableObjectState = <A = unknown>(value: unknown): DurableObjectState<A> => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Durable Object state is created by the Cloudflare host.
  return value as DurableObjectState<A>;
};

export const nativeDurableObjectStorage = (value: unknown): DurableObjectStorage => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Durable Object storage is created by the Cloudflare host.
  return value as DurableObjectStorage;
};

export const nativeDurableObjectTransaction = (value: unknown): DurableObjectTransaction => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Durable Object transactions are created by the Cloudflare host.
  return value as DurableObjectTransaction;
};

export const nativeStorageValue = <A>(value: unknown): A => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Native Durable Object storage get returns the caller-selected type without a runtime schema.
  return value as A;
};

export const nativeExecutionContext = (value: unknown): ExecutionContext => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- ExecutionContext is created by the Cloudflare host.
  return value as ExecutionContext;
};

export const nativeSdkValue = <A>(value: unknown): A => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- in-memory fakes implement caller-selected generic SDK methods without a runtime schema.
  return value as A;
};

export const nativeWebSocketAttachment = <A>(value: unknown): A | null => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- native WebSocket deserializeAttachment returns a caller-selected type without a runtime schema.
  return value as A | null;
};

export const nativePiExtensionApi = (value: unknown): ExtensionAPI => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Pi owns the full ExtensionAPI; package tests supply only the registration methods they exercise.
  return value as ExtensionAPI;
};

export const nativeFetcher = (value: unknown): Fetcher => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Fetcher is a Cloudflare service binding with native methods outside this fixture.
  return value as Fetcher;
};
