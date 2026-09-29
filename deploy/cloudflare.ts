import * as Accounts from "@distilled.cloud/cloudflare/accounts";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { copyLayer } from "./image.ts";

// The accounts and domains the deploy sign-in can see, so init offers them instead of asking for ids.
export const accounts = Accounts.listAccounts.items({}).pipe(
  Stream.map((account) => ({ id: account.id, name: account.name })),
  Stream.runCollect,
  Effect.provide(copyLayer),
);

export const zones = (accountId: string) =>
  Zones.listZones.items({ account: { id: accountId } }).pipe(
    Stream.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status })),
    Stream.runCollect,
    Effect.provide(copyLayer),
  );

// What of a stage is still in the account: its Worker, container app and bucket.
export const leftovers = (accountId: string, stage: string) =>
  Effect.gen(function* () {
    const mine = (name: string | null | undefined) =>
      name === `scotty-${stage}` || (name ?? "").startsWith(`scotty-${stage}-`);
    const scripts = yield* Workers.listScripts.items({ accountId }).pipe(
      Stream.map((script) => script.id),
      Stream.runCollect,
    );
    const apps = yield* Containers.listContainerApplications({ accountId });
    const buckets = yield* R2.listBuckets({ accountId });
    return [
      ...scripts,
      ...apps.map((app) => app.name),
      ...(buckets.buckets ?? []).map((bucket) => bucket.name),
    ].filter(mine);
  }).pipe(Effect.provide(copyLayer));
