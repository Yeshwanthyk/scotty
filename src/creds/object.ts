import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Exit, Schema } from "effect";
import { exchangeCode, OAuthFailure, pollDevice, startDevice } from "./oauth.js";
import { swapChatGpt } from "./swap.js";

const CredentialRow = Schema.Struct({
  access_token: Schema.String,
  account_id: Schema.String,
  expires_at: Schema.Number,
});
const DeviceRow = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.Number,
  expires_at: Schema.Number,
});
const GrantRow = Schema.Struct({ sentinel: Schema.String });
const SessionRow = Schema.Struct({ id: Schema.String });
class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()(
  "CredentialStoreError",
  { message: Schema.String },
) {}

export default class CredsObject extends Cloudflare.DurableObject<CredsObject>()(
  "CredsObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, id_token TEXT NOT NULL, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK (id = 1), device_auth_id TEXT NOT NULL, user_code TEXT NOT NULL, interval INTEGER NOT NULL, expires_at INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS grants (session TEXT PRIMARY KEY, sentinel TEXT NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS sessions (req TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE)`;

      return {
        reserve: (req: string, id: string) =>
          Effect.gen(function* () {
            const key = yield* Schema.decodeUnknownEffect(
              Schema.String.check(Schema.isMinLength(1)),
            )(req);
            const session = yield* Schema.decodeUnknownEffect(
              Schema.String.check(Schema.isPattern(/^[a-z0-9-]{6,32}$/)),
            )(id);
            yield* sql`INSERT OR IGNORE INTO sessions (req, id) VALUES (${key}, ${session})`;
            const rows = yield* sql`SELECT id FROM sessions WHERE req = ${key}`;
            const row = rows[0];
            if (row === undefined)
              return yield* new CredentialStoreError({ message: "Reservation missing" });
            return (yield* Schema.decodeUnknownEffect(SessionRow)(row)).id;
          }),
        hasSession: (id: string) =>
          Effect.gen(function* () {
            const session = yield* Schema.decodeUnknownEffect(
              Schema.String.check(Schema.isPattern(/^[a-z0-9-]{6,32}$/)),
            )(id);
            const rows = yield* sql`SELECT id FROM sessions WHERE id = ${session}`;
            return rows.length > 0;
          }),
        sessions: () =>
          Effect.gen(function* () {
            const rows = yield* sql`SELECT id FROM sessions`;
            return yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(SessionRow)(row),
            );
          }),
        startChatGpt: () =>
          Effect.gen(function* () {
            const device = yield* startDevice;
            yield* sql`INSERT OR REPLACE INTO device (id, device_auth_id, user_code, interval, expires_at) VALUES (1, ${device.deviceAuthId}, ${device.userCode}, ${device.interval}, ${device.expiresAt})`;
            return {
              verificationUrl: device.verificationUrl,
              userCode: device.userCode,
              interval: device.interval,
              expiresAt: device.expiresAt,
            };
          }).pipe(
            Effect.catchTag("OAuthFailure", (error) =>
              Effect.succeed({
                status: "failed" as const,
                stage: error.stage,
                httpStatus: error.status ?? null,
                code: error.code ?? null,
              }),
            ),
          ),
        pollChatGpt: () =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT device_auth_id, user_code, interval, expires_at FROM device WHERE id = 1`;
            const row = rows[0];
            if (row === undefined)
              return {
                status: "failed" as const,
                stage: "poll" as const,
                httpStatus: null,
                code: "device_missing",
              };
            const device = yield* Schema.decodeUnknownEffect(DeviceRow)(row);
            if (Date.now() >= device.expires_at) {
              yield* sql`DELETE FROM device WHERE id = 1 AND device_auth_id = ${device.device_auth_id}`;
              return { status: "expired" as const };
            }
            const result = yield* pollDevice(device.device_auth_id, device.user_code);
            if (result.kind === "pending")
              return { status: "pending" as const, interval: device.interval };
            const claimed =
              yield* sql`DELETE FROM device WHERE id = 1 AND device_auth_id = ${device.device_auth_id} RETURNING device_auth_id`;
            if (claimed.length !== 1)
              return {
                status: "failed" as const,
                stage: "exchange" as const,
                httpStatus: null,
                code: "already_consumed",
              };
            const tokens = yield* exchangeCode(result.authorization);
            yield* sql`INSERT INTO credentials (provider, access_token, refresh_token, id_token, account_id, expires_at) VALUES ('chatgpt', ${tokens.access_token}, ${tokens.refresh_token}, ${tokens.id_token}, ${tokens.accountId}, ${tokens.expiresAt}) ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, id_token = excluded.id_token, account_id = excluded.account_id, expires_at = excluded.expires_at`;
            return { status: "signed-in" as const, expiresAt: tokens.expiresAt };
          }).pipe(
            Effect.catchTag("OAuthFailure", (error: OAuthFailure) =>
              Effect.succeed({
                status: "failed" as const,
                stage: error.stage,
                httpStatus: error.status ?? null,
                code: error.code ?? null,
              }),
            ),
          ),
        grant: (session: string) =>
          Effect.gen(function* () {
            const id = yield* Schema.decodeUnknownEffect(
              Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/)),
            )(session);
            const rows = yield* sql`SELECT sentinel FROM grants WHERE session = ${id}`;
            const existing = rows[0];
            if (existing !== undefined) {
              return (yield* Schema.decodeUnknownEffect(GrantRow)(existing)).sentinel;
            }
            const sentinel = crypto.randomUUID() + crypto.randomUUID();
            yield* sql`INSERT OR IGNORE INTO grants (session, sentinel) VALUES (${id}, ${sentinel})`;
            const stored = yield* sql`SELECT sentinel FROM grants WHERE session = ${id}`;
            const grant = stored[0];
            if (grant === undefined)
              return yield* new CredentialStoreError({ message: "Grant missing" });
            return (yield* Schema.decodeUnknownEffect(GrantRow)(grant)).sentinel;
          }),
        proxy: (session: string, request: Request) =>
          Effect.gen(function* () {
            const id = yield* Schema.decodeUnknownEffect(
              Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/)),
            )(session);
            const grants = yield* sql`SELECT sentinel FROM grants WHERE session = ${id}`;
            const credentials =
              yield* sql`SELECT access_token, account_id, expires_at FROM credentials WHERE provider = 'chatgpt'`;
            const grant = grants[0];
            const credential = credentials[0];
            if (grant === undefined || credential === undefined) {
              return new Response(null, { status: 403 });
            }
            const sentinel = (yield* Schema.decodeUnknownEffect(GrantRow)(grant)).sentinel;
            const tokens = yield* Schema.decodeUnknownEffect(CredentialRow)(credential);
            if (tokens.expires_at <= Date.now())
              return new Response("ChatGPT sign-in expired", { status: 401 });
            const response = yield* Effect.exit(
              swapChatGpt(request, sentinel, tokens.access_token, tokens.account_id),
            );
            return Exit.isSuccess(response) ? response.value : new Response(null, { status: 403 });
          }),
      };
    }).pipe(Effect.provide(SqliteClient.layer({ storage: state.raw.storage })), Effect.orDie);
  }),
) {}
