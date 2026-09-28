import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import { exchangeCode, OAuthFailure, pollDevice, startDevice } from "./oauth.js";

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
const SessionRow = Schema.Struct({ id: Schema.String });
const GitHubRow = Schema.Struct({
  token: Schema.String,
  login: Schema.String,
  name: Schema.String,
  email: Schema.String,
});
const GitHubUser = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});
const SkillRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Number,
  sha256: Schema.String,
  size: Schema.Number,
  updated: Schema.Number,
});
// Sessions can run for hours; refuse a token that could expire mid-session.
const tokenMargin = 24 * 60 * 60 * 1000;
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
      yield* sql`CREATE TABLE IF NOT EXISTS github (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, login TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, enabled INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, updated INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS session_index (req TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE)`;

      const gitHub = Effect.gen(function* () {
        const row = (yield* sql`SELECT token, login, name, email FROM github WHERE id = 1`)[0];
        return row === undefined ? null : yield* Schema.decodeUnknownEffect(GitHubRow)(row);
      });

      return {
        reserve: (req: string, id: string) =>
          Effect.gen(function* () {
            const key = yield* Schema.decodeUnknownEffect(
              Schema.String.check(Schema.isMinLength(1)),
            )(req);
            const session = yield* Schema.decodeUnknownEffect(
              Schema.String.check(Schema.isPattern(/^[a-z0-9-]{6,32}$/)),
            )(id);
            yield* sql`INSERT OR IGNORE INTO session_index (req, id) VALUES (${key}, ${session})`;
            const rows = yield* sql`SELECT id FROM session_index WHERE req = ${key}`;
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
            const rows = yield* sql`SELECT id FROM session_index WHERE id = ${session}`;
            return rows.length > 0;
          }),
        forget: (id: string) => sql`DELETE FROM session_index WHERE id = ${id}`.pipe(Effect.asVoid),
        sessions: () =>
          Effect.gen(function* () {
            const rows = yield* sql`SELECT id FROM session_index`;
            return yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(SessionRow)(row),
            );
          }),
        // The zip itself is in R2 at skills/<name>.zip before its row is written.
        skills: () =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT name, description, enabled, sha256, size, updated FROM skills ORDER BY name`;
            const skills = yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(SkillRow)(row),
            );
            return skills.map((skill) => ({ ...skill, enabled: skill.enabled === 1 }));
          }),
        // Replacing a skill keeps whether it is on.
        putSkill: (skill: { name: string; description: string; sha256: string; size: number }) =>
          sql`INSERT INTO skills (name, description, enabled, sha256, size, updated) VALUES (${skill.name}, ${skill.description}, 1, ${skill.sha256}, ${skill.size}, ${Date.now()}) ON CONFLICT(name) DO UPDATE SET description = excluded.description, sha256 = excluded.sha256, size = excluded.size, updated = excluded.updated`.pipe(
            Effect.asVoid,
          ),
        setSkill: (name: string, enabled: boolean) =>
          sql`UPDATE skills SET enabled = ${enabled ? 1 : 0}, updated = ${Date.now()} WHERE name = ${name} RETURNING name`.pipe(
            Effect.map((rows) => rows.length > 0),
          ),
        removeSkill: (name: string) =>
          sql`DELETE FROM skills WHERE name = ${name} RETURNING name`.pipe(
            Effect.map((rows) => rows.length > 0),
          ),
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
        chatGptStatus: () =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT access_token, account_id, expires_at FROM credentials WHERE provider = 'chatgpt'`;
            const row = rows[0];
            if (row === undefined) return { status: "signed-out" as const, expiresAt: null };
            const { expires_at } = yield* Schema.decodeUnknownEffect(CredentialRow)(row);
            const status = expires_at <= Date.now() + tokenMargin ? "expiring" : "signed-in";
            return { status, expiresAt: expires_at };
          }),
        setGitHub: (token: string) =>
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise(() =>
              fetch("https://api.github.com/user", {
                headers: {
                  accept: "application/vnd.github+json",
                  authorization: `Bearer ${token}`,
                  "user-agent": "scotty-rebuild",
                },
              }),
            );
            if (response.status !== 200)
              return { status: "refused" as const, httpStatus: response.status };
            const user = yield* Schema.decodeUnknownEffect(GitHubUser)(
              yield* Effect.tryPromise(() => response.json()),
            );
            const name = user.name ?? user.login;
            const email = user.email ?? `${user.id}+${user.login}@users.noreply.github.com`;
            yield* sql`INSERT OR REPLACE INTO github (id, token, login, name, email) VALUES (1, ${token}, ${user.login}, ${name}, ${email})`;
            return { status: "set" as const, login: user.login };
          }),
        gitHubStatus: () =>
          gitHub.pipe(
            Effect.map((row) =>
              row === null
                ? { status: "missing" as const, login: null }
                : { status: "set" as const, login: row.login },
            ),
          ),
        // Only the Worker asks for the token; it never reaches a session or its container.
        gitHubToken: () => gitHub.pipe(Effect.map((row) => row?.token ?? null)),
        gitIdentity: () =>
          gitHub.pipe(
            Effect.flatMap((row) =>
              row === null
                ? new CredentialStoreError({ message: "GitHub token missing" })
                : Effect.succeed({ name: row.name, email: row.email }),
            ),
          ),
        // The refresh token never leaves this object; a session gets only the access token.
        sessionToken: () =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT access_token, account_id, expires_at FROM credentials WHERE provider = 'chatgpt'`;
            const row = rows[0];
            if (row === undefined)
              return yield* new CredentialStoreError({ message: "ChatGPT sign-in required" });
            const tokens = yield* Schema.decodeUnknownEffect(CredentialRow)(row);
            if (tokens.expires_at <= Date.now() + tokenMargin)
              return yield* new CredentialStoreError({ message: "ChatGPT sign-in expiring" });
            return { token: tokens.access_token, accountId: tokens.account_id };
          }),
      };
    }).pipe(Effect.provide(SqliteClient.layer({ storage: state.raw.storage })), Effect.orDie);
  }),
) {}
