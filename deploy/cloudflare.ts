import * as Accounts from "@distilled.cloud/cloudflare/accounts";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as Zones from "@distilled.cloud/cloudflare/zones";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

export const cloudflareLayer = (token: Redacted.Redacted<string>) =>
  Layer.merge(fromApiToken({ apiToken: token }), FetchHttpClient.layer);
export type CloudflareLayer = ReturnType<typeof cloudflareLayer>;

export const accounts = Accounts.listAccounts.items({}).pipe(
  Stream.map((account) => ({ id: account.id, name: account.name })),
  Stream.runCollect,
);

export const zones = (accountId: string) =>
  Zones.listZones.items({ account: { id: accountId } }).pipe(
    Stream.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status })),
    Stream.runCollect,
  );

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
