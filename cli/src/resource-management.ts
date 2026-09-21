import { Effect, Schema } from "effect";
import {
  CloudResourceDeleteSchema,
  CloudResourceNameSchema,
  type CloudResourceKind,
  type CloudResourcePut,
} from "../../protocol/cloud-resources";
import { invalidResponse, usage } from "./pure";
import { SandboxBundleItemManifestSchema, SandboxDigestSchema } from "./sandbox-bundle";
import { prepareSandboxResource } from "./sandbox-bundle-builder";
import { type ApiRequestTarget, requestJson } from "./transport";

const ResourceListSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  activeDigest: Schema.NullOr(SandboxDigestSchema),
  items: Schema.Array(SandboxBundleItemManifestSchema),
});
const ResourceMutationSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  activeDigest: Schema.NullOr(SandboxDigestSchema),
  items: Schema.Array(SandboxBundleItemManifestSchema),
});

const decodeResourceList = Schema.decodeUnknownEffect(ResourceListSchema, {
  onExcessProperty: "ignore",
});
const decodeResourceMutation = Schema.decodeUnknownEffect(ResourceMutationSchema, {
  onExcessProperty: "ignore",
});
const decodeResourceName = Schema.decodeUnknownEffect(CloudResourceNameSchema);

const resourcePath = (kind: CloudResourceKind, name: string): string =>
  `/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;

export const validateResourceName = (name: string) =>
  decodeResourceName(name).pipe(Effect.mapError(() => usage("Resource name is invalid")));

export const listResources = Effect.fnUntraced(function* (target: ApiRequestTarget) {
  const value = yield* requestJson(target, "/api/resources");
  return yield* decodeResourceList(value).pipe(
    Effect.mapError(() => invalidResponse("Server returned an invalid resource list")),
  );
});

export const putResource = Effect.fnUntraced(function* (
  target: ApiRequestTarget,
  kind: CloudResourceKind,
  localPath: string,
) {
  const current = yield* listResources(target);
  const prepared = yield* prepareSandboxResource(kind, localPath);
  const idempotencyKey = crypto.randomUUID();
  const body = {
    expectedRevision: current.revision,
    idempotencyKey,
    shape: prepared.shape,
    files: prepared.files,
  } satisfies CloudResourcePut;
  const value = yield* requestJson(target, resourcePath(kind, prepared.name), {
    method: "PUT",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const result = yield* decodeResourceMutation(value).pipe(
    Effect.mapError(() => invalidResponse("Server returned an invalid resource update")),
  );
  return { ...result, kind, name: prepared.name };
});

export const removeResource = Effect.fnUntraced(function* (
  target: ApiRequestTarget,
  kind: CloudResourceKind,
  name: string,
) {
  const current = yield* listResources(target);
  const idempotencyKey = crypto.randomUUID();
  const body = {
    expectedRevision: current.revision,
    idempotencyKey,
  } satisfies typeof CloudResourceDeleteSchema.Type;
  const value = yield* requestJson(target, resourcePath(kind, name), {
    method: "DELETE",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const result = yield* decodeResourceMutation(value).pipe(
    Effect.mapError(() => invalidResponse("Server returned an invalid resource update")),
  );
  return { ...result, kind, name };
});
