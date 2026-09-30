import * as Accounts from "@distilled.cloud/cloudflare/accounts";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as Zones from "@distilled.cloud/cloudflare/zones";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

// Every Cloudflare call is made with the owner's API token, held only in memory.
export const cloudflareLayer = (token: Redacted.Redacted<string>) =>
  Layer.merge(fromApiToken({ apiToken: Redacted.value(token) }), FetchHttpClient.layer);
export type CloudflareLayer = ReturnType<typeof cloudflareLayer>;

// The accounts and domains the token can see, so init offers them instead of asking for ids.
export const accounts = Accounts.listAccounts.items({}).pipe(
  Stream.map((account) => ({ id: account.id, name: account.name })),
  Stream.runCollect,
);

export const zones = (accountId: string) =>
  Zones.listZones.items({ account: { id: accountId } }).pipe(
    Stream.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status })),
    Stream.runCollect,
  );

// A token template with what a deploy needs, for the owner to create and paste.
export const tokenPage = () => {
  const permissions = [
    ["account_settings", "read"],
    ["workers_scripts", "edit"],
    ["workers_r2", "edit"],
    ["containers", "edit"],
    ["access", "edit"],
    ["workers_routes", "edit"],
    ["dns", "edit"],
    ["zone", "read"],
  ].map(([key, type]) => ({ key, type }));
  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
  url.searchParams.set("permissionGroupKeys", JSON.stringify(permissions));
  url.searchParams.set("accountId", "*");
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", "Scotty");
  return url.toString();
};
