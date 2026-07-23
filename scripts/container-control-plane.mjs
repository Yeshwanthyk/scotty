import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import { AuthProviders } from "alchemy/Auth";
import { CloudflareApiLive } from "alchemy/Cloudflare";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const HealthInstances = Schema.Struct({
  active: Schema.Number,
  assigned: Schema.Number,
  healthy: Schema.Number,
  stopped: Schema.Number,
  failed: Schema.Number,
  scheduling: Schema.Number,
  starting: Schema.Number,
});

const RolloutHealthInstances = Schema.Struct({
  healthy: Schema.Number,
  failed: Schema.Number,
  scheduling: Schema.Number,
  starting: Schema.Number,
});

const Application = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.Number,
  updated_at: Schema.String,
  active_rollout_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  configuration: Schema.Json,
  health: Schema.Struct({ instances: HealthInstances }),
});

const Rollout = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  last_updated_at: Schema.String,
  status: Schema.String,
  current_version: Schema.Number,
  target_version: Schema.Number,
  health: Schema.Struct({ instances: RolloutHealthInstances }),
  progress: Schema.Struct({
    total_steps: Schema.Number,
    current_step: Schema.Number,
    updated_instances: Schema.Number,
    total_instances: Schema.Number,
  }),
});

const ApplicationEnvelope = Schema.Struct({
  success: Schema.Literal(true),
  result: Application,
});

const RolloutsEnvelope = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Rollout),
});

const Snapshot = Schema.Struct({
  application: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    version: Schema.Number,
    updatedAt: Schema.String,
    activeRolloutId: Schema.Union([Schema.String, Schema.Null]),
    configurationDigest: Schema.String,
    health: HealthInstances,
  }),
  rollouts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      createdAt: Schema.String,
      lastUpdatedAt: Schema.String,
      currentVersion: Schema.Number,
      targetVersion: Schema.Number,
      health: RolloutHealthInstances,
      progress: Schema.Struct({
        totalSteps: Schema.Number,
        currentStep: Schema.Number,
        updatedInstances: Schema.Number,
        totalInstances: Schema.Number,
      }),
    }),
  ),
});

const decodeApplicationEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ApplicationEnvelope),
);
const decodeRolloutsEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(RolloutsEnvelope));
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot));

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};

const configurationDigest = (configuration) =>
  createHash("sha256").update(canonicalJson(configuration)).digest("hex");

const fetchDecoded = Effect.fnUntraced(function* (url, decode) {
  const credentialsEffect = yield* Credentials;
  const credentials = yield* credentialsEffect;
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(url, {
        headers: {
          ...formatHeaders(credentials),
          accept: "application/json",
        },
      }),
    catch: () => new Error("Cloudflare Container control-plane request failed."),
  });
  if (!response.ok) {
    return yield* Effect.fail(
      new Error(`Cloudflare Container control-plane request failed with HTTP ${response.status}.`),
    );
  }
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => new Error("Cloudflare Container control-plane response could not be read."),
  });
  return yield* decode(body).pipe(
    Effect.mapError(() => new Error("Cloudflare Container control-plane response was invalid.")),
  );
});

const readControlPlaneEffect = Effect.fnUntraced(function* ({ accountId, applicationId }) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/containers/applications/${encodeURIComponent(applicationId)}`;
  const [applicationEnvelope, rolloutsEnvelope] = yield* Effect.all(
    [
      fetchDecoded(baseUrl, decodeApplicationEnvelope),
      fetchDecoded(`${baseUrl}/rollouts?limit=100`, decodeRolloutsEnvelope),
    ],
    { concurrency: 2 },
  );
  const application = applicationEnvelope.result;
  return {
    application: {
      id: application.id,
      name: application.name,
      version: application.version,
      updatedAt: application.updated_at,
      activeRolloutId: application.active_rollout_id ?? null,
      configurationDigest: configurationDigest(application.configuration),
      health: application.health.instances,
    },
    rollouts: rolloutsEnvelope.result.map((rollout) => ({
      id: rollout.id,
      status: rollout.status,
      createdAt: rollout.created_at,
      lastUpdatedAt: rollout.last_updated_at,
      currentVersion: rollout.current_version,
      targetVersion: rollout.target_version,
      health: rollout.health.instances,
      progress: {
        totalSteps: rollout.progress.total_steps,
        currentStep: rollout.progress.current_step,
        updatedInstances: rollout.progress.updated_instances,
        totalInstances: rollout.progress.total_instances,
      },
    })),
  };
});

const live = CloudflareApiLive().pipe(
  Layer.provideMerge(Layer.succeed(AuthProviders, {})),
  Layer.provide(PlatformServices),
);

export const readContainerControlPlane = (input) =>
  Effect.runPromise(readControlPlaneEffect(input).pipe(Effect.provide(live)));

export const parseContainerControlPlaneSnapshot = (output) =>
  Effect.runPromise(decodeSnapshot(output));

async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const applicationId = process.argv[2];
  if (!accountId || !applicationId) {
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: local CLI argument validation rejects an unusable operator invocation
    throw new Error("Container control-plane read requires account and application IDs.");
  }
  const snapshot = await readContainerControlPlane({ accountId, applicationId });
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Container control-plane read failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
