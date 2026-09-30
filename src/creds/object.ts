import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import { newSecret, verifyWebhook } from "../hooks/signature.js";
import { ConnectionName, DeliveryOutcome, DeliveryReason, keptDeliveries } from "./connections.js";
import { searchText } from "../session/search.js";
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
const SessionId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{6,32}$/));
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
const ClaudeRow = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.Number,
});
const SkillRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Number,
  sha256: Schema.String,
  size: Schema.Number,
  updated: Schema.Number,
});
const ConnectionRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("webhook"),
  created: Schema.Number,
});
const SecretRow = Schema.Struct({ secret: Schema.String });
const DeliveryRow = Schema.Struct({
  id: Schema.String,
  connection: Schema.String,
  at: Schema.Number,
  outcome: DeliveryOutcome,
  reason: Schema.NullOr(DeliveryReason),
  session: Schema.NullOr(Schema.String),
});
// The newest deliveries a list returns.
const listedDeliveries = 200;
// Sessions can run for hours; refuse a token that could expire mid-session.
const tokenMargin = 24 * 60 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;
// `claude setup-token` makes a token that lasts a year and doesn't say when it expires.
const claudeLifetime = 365 * day;
const claudeWarning = 14 * day;
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
      yield* sql`CREATE TABLE IF NOT EXISTS claude (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires_at INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, enabled INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, updated INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS session_index (req TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE)`;
      yield* sql`CREATE TABLE IF NOT EXISTS session_keys (key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE)`;
      // What a search matches (`searchText`). Sessions made before it have no row: they are
      // listed but never found.
      yield* sql`CREATE TABLE IF NOT EXISTS session_search (id TEXT PRIMARY KEY, text TEXT NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS connections (name TEXT PRIMARY KEY, kind TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, connection TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT, session TEXT)`;

      const gitHub = Effect.gen(function* () {
        const row = (yield* sql`SELECT token, login, name, email FROM github WHERE id = 1`)[0];
        return row === undefined ? null : yield* Schema.decodeUnknownEffect(GitHubRow)(row);
      });

      const claude = Effect.gen(function* () {
        const row = (yield* sql`SELECT token, expires_at FROM claude WHERE id = 1`)[0];
        return row === undefined ? null : yield* Schema.decodeUnknownEffect(ClaudeRow)(row);
      });

      // The session the first of these rows names; the rows were just written, so there is one.
      const sessionOf = (rows: ReadonlyArray<unknown>) =>
        Schema.decodeUnknownEffect(SessionRow)(rows[0]).pipe(Effect.map((row) => row.id));

      return {
        // The first caller for a key, or for a request id when there is no key, names the
        // session; later callers get that one. From here the session is listed and searchable.
        reserve: (input: {
          req: string;
          key?: string;
          id: string;
          title: string;
          repo: string;
          prompt: string;
          connection?: string;
        }) =>
          Effect.gen(function* () {
            const fresh = yield* Schema.decodeUnknownEffect(SessionId)(input.id);
            const req =
              input.key === undefined
                ? yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1)))(
                    input.req,
                  )
                : `key:${input.key}`;
            if (input.key !== undefined)
              yield* sql`INSERT OR IGNORE INTO session_keys (key, id) VALUES (${input.key}, ${fresh})`;
            const reserved =
              input.key === undefined
                ? fresh
                : yield* sessionOf(
                    yield* sql`SELECT id FROM session_keys WHERE key = ${input.key}`,
                  );
            yield* sql`INSERT OR IGNORE INTO session_index (req, id) VALUES (${req}, ${reserved})`;
            const id = yield* sessionOf(
              yield* sql`SELECT id FROM session_index WHERE req = ${req}`,
            );
            const text = searchText({ ...input, branch: `scotty/${id}` });
            yield* sql`INSERT OR IGNORE INTO session_search (id, text) VALUES (${id}, ${text})`;
            return id;
          }),
        // The session a key names, if any; it may not be made yet.
        keyed: (key: string) =>
          Effect.gen(function* () {
            const row = (yield* sql`SELECT id FROM session_keys WHERE key = ${key}`)[0];
            return row === undefined
              ? null
              : (yield* Schema.decodeUnknownEffect(SessionRow)(row)).id;
          }),
        // Sessions whose search text holds the query, any case.
        search: (query: string) =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT id FROM session_search WHERE instr(text, ${query.toLowerCase()}) > 0`;
            return yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(SessionRow)(row),
            );
          }),
        hasSession: (id: string) =>
          Effect.gen(function* () {
            const session = yield* Schema.decodeUnknownEffect(SessionId)(id);
            const rows = yield* sql`SELECT id FROM session_index WHERE id = ${session}`;
            return rows.length > 0;
          }),
        forget: (id: string) =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM session_keys WHERE id = ${id}`;
            yield* sql`DELETE FROM session_search WHERE id = ${id}`;
            yield* sql`DELETE FROM session_index WHERE id = ${id}`;
          }),
        connections: () =>
          Effect.gen(function* () {
            const rows = yield* sql`SELECT name, kind, created FROM connections ORDER BY name`;
            return yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(ConnectionRow)(row),
            );
          }),
        // The secret is returned here and never again; `connections` shows only metadata.
        addConnection: (name: string) =>
          Effect.gen(function* () {
            const checked = yield* Schema.decodeUnknownEffect(ConnectionName)(name);
            const secret = newSecret();
            const created = Date.now();
            const inserted =
              yield* sql`INSERT OR IGNORE INTO connections (name, kind, secret, created) VALUES (${checked}, 'webhook', ${secret}, ${created}) RETURNING name`;
            return inserted.length === 0
              ? { status: "exists" as const }
              : {
                  status: "created" as const,
                  name: checked,
                  kind: "webhook" as const,
                  secret,
                  created,
                };
          }),
        removeConnection: (name: string) =>
          sql`DELETE FROM connections WHERE name = ${name} RETURNING name`.pipe(
            Effect.map((rows) => rows.length > 0),
          ),
        // The secret stays in this object: the Worker hands over what the sender signed.
        verifyDelivery: (input: {
          connection: string;
          id: string;
          timestamp: string;
          signature: string;
          body: string;
        }) =>
          Effect.gen(function* () {
            const row =
              (yield* sql`SELECT secret FROM connections WHERE name = ${input.connection}`)[0];
            if (row === undefined) return "unknown" as const;
            const { secret } = yield* Schema.decodeUnknownEffect(SecretRow)(row);
            return yield* Effect.promise(() =>
              verifyWebhook({ secret, ...input, now: Date.now() }),
            );
          }),
        // Deliveries are a log; the oldest go as new ones arrive.
        recordDelivery: (delivery: {
          id: string;
          connection: string;
          outcome: typeof DeliveryOutcome.Type;
          reason?: typeof DeliveryReason.Type;
          session?: string;
        }) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO deliveries (id, connection, at, outcome, reason, session) VALUES (${delivery.id}, ${delivery.connection}, ${Date.now()}, ${delivery.outcome}, ${delivery.reason ?? null}, ${delivery.session ?? null})`;
            yield* sql`DELETE FROM deliveries WHERE seq <= (SELECT MAX(seq) FROM deliveries) - ${keptDeliveries}`;
          }),
        deliveries: (connection?: string) =>
          Effect.gen(function* () {
            const rows =
              connection === undefined
                ? yield* sql`SELECT id, connection, at, outcome, reason, session FROM deliveries ORDER BY seq DESC LIMIT ${listedDeliveries}`
                : yield* sql`SELECT id, connection, at, outcome, reason, session FROM deliveries WHERE connection = ${connection} ORDER BY seq DESC LIMIT ${listedDeliveries}`;
            return yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(DeliveryRow)(row),
            );
          }),
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
            return skills.map((skill) => ({
              ...skill,
              enabled: skill.enabled === 1,
            }));
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
            return {
              status: "signed-in" as const,
              expiresAt: tokens.expiresAt,
            };
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
              return {
                status: "refused" as const,
                httpStatus: response.status,
              };
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
        setClaude: (token: string) =>
          Effect.gen(function* () {
            const expiresAt = Date.now() + claudeLifetime;
            yield* sql`INSERT OR REPLACE INTO claude (id, token, expires_at) VALUES (1, ${token}, ${expiresAt})`;
            return { status: "signed-in" as const, expiresAt };
          }),
        claudeStatus: () =>
          claude.pipe(
            Effect.map((row) =>
              row === null
                ? { status: "signed-out" as const, expiresAt: null }
                : {
                    status:
                      row.expires_at <= Date.now() + claudeWarning
                        ? ("expiring" as const)
                        : ("signed-in" as const),
                    expiresAt: row.expires_at,
                  },
            ),
          ),
        // Goes only to a Claude session's agent process (AGENTS.md, credential exceptions).
        claudeToken: () =>
          Effect.gen(function* () {
            const row = yield* claude;
            if (row === null || row.expires_at <= Date.now() + tokenMargin)
              return yield* new CredentialStoreError({
                message: "Claude sign-in required",
              });
            return { token: row.token };
          }),
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
              return yield* new CredentialStoreError({
                message: "ChatGPT sign-in required",
              });
            const tokens = yield* Schema.decodeUnknownEffect(CredentialRow)(row);
            if (tokens.expires_at <= Date.now() + tokenMargin)
              return yield* new CredentialStoreError({
                message: "ChatGPT sign-in expiring",
              });
            return { token: tokens.access_token, accountId: tokens.account_id };
          }),
      };
    }).pipe(Effect.provide(SqliteClient.layer({ storage: state.raw.storage })), Effect.orDie);
  }),
) {}
