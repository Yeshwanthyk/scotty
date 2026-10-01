// Deploys a release to a stage, and removes a stage, with direct Cloudflare API calls. Every
// resource is found by its name, `scotty-<stage>…`, so nothing is kept between runs.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Dns from "@distilled.cloud/cloudflare/dns";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Config } from "../cli/config.ts";
import { defaultCodexSettings } from "../src/session/agents/codex-settings.js";
import { copyImage } from "./image.ts";

export const compatibilityDate = "2026-09-01";

// release.json: which Scotty this is and the supervisor image it runs.
export const Release = Schema.Struct({
  version: Schema.String,
  image: Schema.String,
  supervisor: Schema.String,
});
export type Release = typeof Release.Type;

export class DeployError extends Schema.TaggedError<DeployError>()("DeployError", {
  message: Schema.String,
}) {}

const read = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path),
    catch: () => new DeployError({ message: `Could not read ${path}` }),
  });

const walk = async (dir: string): Promise<string[]> =>
  (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      ),
    )
  ).flat();

const list = (dir: string) =>
  Effect.tryPromise({
    try: () => walk(dir),
    catch: () => new DeployError({ message: `Could not read ${dir}` }),
  });

const types: Record<string, string> = {
  js: "application/javascript",
  css: "text/css",
  html: "text/html",
  png: "image/png",
  svg: "image/svg+xml",
  json: "application/json",
  woff2: "font/woff2",
  ico: "image/x-icon",
  txt: "text/plain",
  webmanifest: "application/manifest+json",
};

// Cloudflare waits on a new Worker before its domain attaches, and on a Worker's objects before
// its bucket can go.
const retry = { schedule: Schedule.spaced("3 seconds"), times: 40 } as const;

const names = (config: Config) => ({
  script: `scotty-${config.stage}`,
  bucket: `scotty-${config.stage}-artifacts`,
  app: `scotty-${config.stage}-sessions`,
  access: `scotty-${config.stage}`,
  hooks: `scotty-${config.stage}-hooks`,
  wildcard: `*.${config.domain}`,
  route: `*.${config.domain}/*`,
});

// Uploads the files Cloudflare doesn't have yet; a file's hash is wrangler's, so unchanged files
// are skipped.
const uploadAssets = (accountId: string, scriptName: string, dir: string) =>
  Effect.gen(function* () {
    const byHash = new Map<string, { path: string; type: string }>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const path of yield* list(dir)) {
      const name = relative(dir, path);
      const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      const content = yield* read(path);
      const hash = createHash("sha256").update(content).update(ext).digest("hex").slice(0, 32);
      manifest[`/${name}`] = { hash, size: content.byteLength };
      byHash.set(hash, { path, type: types[ext] ?? "application/octet-stream" });
    }
    const session = yield* Workers.createScriptAssetUpload({ accountId, scriptName, manifest });
    const token = session.jwt ?? "";
    let jwt = token;
    yield* Effect.forEach(
      session.buckets ?? [],
      (bucket) =>
        Effect.gen(function* () {
          const body: Record<string, File> = {};
          for (const hash of bucket) {
            const file = byHash.get(hash);
            if (file === undefined) continue;
            const base64 = (yield* read(file.path)).toString("base64");
            body[hash] = new File([base64], hash, { type: file.type });
          }
          const result = yield* Workers.createAssetUpload({
            accountId,
            base64: true,
            body,
            jwtToken: token,
          });
          if (result.jwt) jwt = result.jwt;
        }),
      { concurrency: 3 },
    );
    return jwt;
  });

// `image` replaces the release's image with one built FROM it.
export const deployStage = (
  config: Config,
  dir: string,
  progress: (text: string) => void,
  image?: string,
) =>
  Effect.gen(function* () {
    const { accountId, zoneId, domain, host, email, stage } = config;
    const codex = config.codex ?? defaultCodexSettings;
    const name = names(config);
    const say = (text: string) => Effect.sync(() => progress(text));
    // The preview route matches the Worker's own host too; the Worker tells them apart by name.
    if (!host.endsWith(`.${domain}`) || /^\d{1,5}-[a-z0-9-]{6,32}\./.test(host))
      return yield* new DeployError({
        message: `${host} must be a name under ${domain} that is not <port>-<id>.${domain}`,
      });
    const release = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Release))(
      (yield* read(join(dir, "release.json"))).toString("utf8"),
    ).pipe(
      Effect.mapError(() => new DeployError({ message: "release.json is not a Scotty release" })),
    );

    yield* say("Copying the container image");
    const copied = yield* copyImage({
      source: image ?? release.image,
      account: accountId,
      repository: "scotty",
      supervisor: release.supervisor,
    }).pipe(
      Effect.catchTag("StaleImage", (stale) =>
        Effect.fail(
          new DeployError({ message: `${stale.message} Build it FROM ${release.image}` }),
        ),
      ),
    );

    yield* say("Setting up the bucket");
    yield* R2.getBucket({ accountId, bucketName: name.bucket }).pipe(
      Effect.catchTag("NoSuchBucket", () => R2.createBucket({ accountId, name: name.bucket })),
    );

    yield* say("Uploading the web app");
    const jwt = yield* uploadAssets(accountId, name.script, join(dir, "assets"));

    const namespaces = (script: string) =>
      DurableObjects.listNamespaces.items({ accountId }).pipe(
        Stream.filter((namespace) => namespace.script === script),
        Stream.runCollect,
      );
    const migrated = [...(yield* namespaces(name.script))].some(
      (namespace) => namespace.class === "SessionObject",
    );
    const workerDir = join(dir, "worker");
    const modules = (yield* list(workerDir)).filter((path) => path.endsWith(".js"));
    const files = yield* Effect.forEach(modules, (path) =>
      read(path).pipe(
        Effect.map(
          (content) =>
            new File([content], relative(workerDir, path), {
              type: "application/javascript+module",
            }),
        ),
      ),
    );
    const text = (key: string, value: string) => ({
      type: "plain_text" as const,
      name: key,
      text: value,
    });
    yield* say("Uploading the Worker");
    const script = yield* Workers.putScript({
      accountId,
      scriptName: name.script,
      metadata: {
        mainModule: "entry.js",
        compatibilityDate,
        compatibilityFlags: ["enable_request_signal"],
        assets: {
          jwt,
          config: { notFoundHandling: "single-page-application", runWorkerFirst: true },
        },
        bindings: [
          { type: "durable_object_namespace", name: "CredsObject", className: "CredsObject" },
          { type: "durable_object_namespace", name: "SessionObject", className: "SessionObject" },
          { type: "r2_bucket", name: "SessionArtifacts", bucketName: name.bucket },
          { type: "assets", name: "ASSETS" },
          // Alchemy's runtime reads these to find its bindings.
          text("ALCHEMY_PHASE", "runtime"),
          text("ALCHEMY_WORKER_NAME", name.script),
          text("ALCHEMY_STACK_NAME", "scotty"),
          text("ALCHEMY_STAGE", stage),
          text("ALCHEMY_CLOUDFLARE_ACCOUNT_ID", accountId),
          text("SCOTTY_HOST", host),
          text("SCOTTY_HATCH_BASE", domain),
          text("SCOTTY_IMAGE", copied),
          text("SCOTTY_CODEX_MODEL", codex.model),
          text("SCOTTY_CODEX_EFFORT", codex.effort),
        ],
        containers: [{ className: "SessionObject" }],
        migrations: migrated
          ? undefined
          : { newTag: "v1", newSqliteClasses: ["CredsObject", "SessionObject"] },
        observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
      },
      files,
    });
    const workerId = script.tag;
    if (!workerId) return yield* new DeployError({ message: "Cloudflare returned no Worker id" });

    const namespaceId = [...(yield* namespaces(name.script))].find(
      (namespace) => namespace.class === "SessionObject",
    )?.id;
    if (!namespaceId)
      return yield* new DeployError({ message: "Cloudflare made no SessionObject namespace" });
    const configuration = {
      image: copied,
      instanceType: "standard-1",
      environmentVariables: [{ name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId }],
    };
    const app = (yield* Containers.listContainerApplications({ accountId })).find(
      (candidate) => candidate.name === name.app,
    );
    if (app === undefined) {
      yield* say("Setting up the container app");
      yield* Containers.createContainerApplication({
        accountId,
        name: name.app,
        maxInstances: 20,
        instances: 0,
        schedulingPolicy: "default",
        constraints: {},
        configuration,
        durableObjects: { namespaceId },
      });
    } else if (app.configuration.image !== copied) {
      yield* say("Rolling out the container image");
      yield* Containers.updateContainerApplication({
        accountId,
        applicationId: app.id,
        configuration,
      });
      yield* Containers.createContainerApplicationRollout({
        accountId,
        applicationId: app.id,
        description: "Immediate update",
        strategy: "rolling",
        kind: "full_auto",
        stepPercentage: 100,
        targetConfiguration: configuration,
      });
    }

    yield* say("Attaching the address");
    yield* Workers.putDomain({ accountId, hostname: host, service: name.script, zoneId }).pipe(
      Effect.retry(retry),
    );

    yield* say("Setting up the Access app");
    const destinations = [
      { type: "worker", workerId },
      { type: "preview_worker", workerId },
    ];
    const policies = [{ decision: "allow", include: [{ email: { email } }] }];
    yield* ensureAccessApp(accountId, name.access, destinations, policies);
    // Senders of signed webhooks have no Access login; the Worker verifies their signatures. This
    // app, with a path more specific than the Worker's, lets `/hooks/*` alone through.
    yield* ensureAccessApp(
      accountId,
      name.hooks,
      [{ type: "public", uri: `${host}/hooks/*` }],
      [{ name: "signed webhooks", decision: "bypass", include: [{ everyone: {} }] }],
    );

    yield* say("Setting up the preview address");
    if ((yield* wildcardRecords(zoneId, name.wildcard)).length === 0)
      yield* Dns.createRecord({
        zoneId,
        name: name.wildcard,
        type: "AAAA",
        content: "100::",
        proxied: true,
        ttl: 1,
      });
    const route = [...(yield* Workers.listRoutes.items({ zoneId }).pipe(Stream.runCollect))].find(
      (candidate) => candidate.pattern === name.route,
    );
    if (route === undefined)
      yield* Workers.createRoute({ zoneId, pattern: name.route, script: name.script });
    else if (route.script !== name.script)
      yield* Workers.updateRoute({
        zoneId,
        routeId: route.id,
        pattern: name.route,
        script: name.script,
      });
  });

type AccessApp = Parameters<typeof ZeroTrust.createAccessApplicationForAccount>[0];

const ensureAccessApp = (
  accountId: string,
  name: string,
  destinations: NonNullable<AccessApp["destinations"]>,
  policies: NonNullable<AccessApp["policies"]>,
) =>
  Effect.gen(function* () {
    const found = (yield* accessApps(accountId, name))[0]?.id;
    const app = { accountId, type: "self_hosted", name, destinations, policies };
    if (found) yield* ZeroTrust.updateAccessApplicationForAccount({ ...app, appId: found });
    else yield* ZeroTrust.createAccessApplicationForAccount(app);
  });

const accessApps = (accountId: string, name: string) =>
  ZeroTrust.listAccessApplicationsForAccount.items({ accountId }).pipe(
    Stream.filter((app) => app.name === name),
    Stream.runCollect,
    Effect.map((apps) => [...apps]),
  );

// Only the record the deploy made; another AAAA record on the name is the owner's.
const wildcardRecords = (zoneId: string, wildcard: string) =>
  Dns.listRecords.items({ zoneId, name: { exact: wildcard }, type: "AAAA" }).pipe(
    Stream.filter((record) => record.content === "100::"),
    Stream.runCollect,
    Effect.map((records) => [...records]),
  );

export const removeStage = (config: Config, progress: (text: string) => void) =>
  Effect.gen(function* () {
    const { accountId, zoneId } = config;
    const name = names(config);
    const say = (text: string) => Effect.sync(() => progress(text));

    yield* say("Removing the Access app");
    for (const app of [
      ...(yield* accessApps(accountId, name.access)),
      ...(yield* accessApps(accountId, name.hooks)),
    ])
      if (app.id) yield* ZeroTrust.deleteAccessApplicationForAccount({ accountId, appId: app.id });

    yield* say("Removing the container app");
    for (const app of yield* Containers.listContainerApplications({ accountId }))
      if (app.name === name.app)
        yield* Containers.deleteContainerApplication({ accountId, applicationId: app.id }).pipe(
          Effect.catchTag("ContainerApplicationNotFound", () => Effect.void),
        );

    yield* say("Removing the address");
    const domains = yield* Workers.listDomains
      .items({ accountId, service: name.script })
      .pipe(Stream.runCollect);
    for (const domain of domains)
      if (domain.id) yield* Workers.deleteDomain({ accountId, domainId: domain.id });
    for (const route of yield* Workers.listRoutes.items({ zoneId }).pipe(Stream.runCollect))
      if (route.pattern === name.route && route.script === name.script)
        yield* Workers.deleteRoute({ zoneId, routeId: route.id });

    yield* say("Removing the Worker");
    yield* Workers.deleteScript({ accountId, scriptName: name.script, force: true }).pipe(
      Effect.catchTag("WorkerNotFound", () => Effect.void),
    );

    yield* say("Removing the bucket");
    const bucketName = name.bucket;
    const empty = Effect.gen(function* () {
      const objects = yield* R2.listObjects
        .items({ accountId, bucketName, perPage: 1000 })
        .pipe(Stream.runCollect);
      const keys = [...objects].flatMap((object) => (object.key ? [object.key] : []));
      for (let i = 0; i < keys.length; i += 1000)
        yield* R2.deleteObjects({ accountId, bucketName, body: keys.slice(i, i + 1000) });
      yield* R2.deleteBucket({ accountId, bucketName });
    });
    yield* empty.pipe(
      Effect.retry({ while: (error) => error._tag === "BucketNotEmpty", ...retry }),
      Effect.catchTag("NoSuchBucket", () => Effect.void),
    );

    yield* say("Removing the preview address");
    for (const record of yield* wildcardRecords(zoneId, name.wildcard))
      if (record.id) yield* Dns.deleteRecord({ zoneId, dnsRecordId: record.id });
  });

// What of a stage is still in the account, by name.
export const leftovers = (config: Config) =>
  Effect.gen(function* () {
    const { accountId, zoneId } = config;
    const name = names(config);
    const mine = (candidate: string | null | undefined) =>
      candidate === name.script || (candidate ?? "").startsWith(`${name.script}-`);
    const scripts = yield* Workers.listScripts.items({ accountId }).pipe(
      Stream.map((script) => script.id),
      Stream.runCollect,
    );
    const apps = yield* Containers.listContainerApplications({ accountId });
    const buckets = yield* R2.listBuckets({ accountId });
    const access = yield* accessApps(accountId, name.access);
    const hooks = yield* accessApps(accountId, name.hooks);
    const records = yield* wildcardRecords(zoneId, name.wildcard);
    return [
      ...[
        ...scripts,
        ...apps.map((app) => app.name),
        ...(buckets.buckets ?? []).map((b) => b.name),
      ].filter(mine),
      ...access.map(() => `Access app ${name.access}`),
      ...hooks.map(() => `Access app ${name.hooks}`),
      ...records.map(() => `DNS record ${name.wildcard}`),
    ];
  });
