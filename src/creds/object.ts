import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  maxBodyBytes,
  newSecret,
  readDelivery,
  SigningValues,
  verifySignature,
} from "../hooks/signature.js";
import {
  ConnectionConfig,
  configFor,
  NewConnection,
  DeliveryOutcome,
  DeliveryReason,
  keptDeliveries,
  ToolPolicy,
  McpSignIn,
} from "./connections.js";
import { authorizeMcp, refreshMcp, StoredMcpOAuth } from "./mcp-oauth.js";
import { isLoopback } from "../loopback.js";
import { searchText } from "../session/search.js";
import { AgentKind } from "../session/events.js";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { SessionView } from "../session/view.js";
import { exchangeCode, OAuthFailure, pollDevice, startDevice } from "./oauth.js";
import {
  Definition,
  field,
  Action,
  giveUpAfterMs,
  missedAfterMs,
  nextDue,
  prepare,
  refireAfterMs,
  RunStatus,
  RunTrigger,
} from "../automations/automation.js";

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
const RequestSession = Schema.Struct({ id: Schema.NullOr(Schema.String) });
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
  config: Schema.fromJsonString(ConnectionConfig),
  created: Schema.Number,
  signIn: McpSignIn,
});
const OAuthRow = Schema.Struct({
  generation: Schema.String,
  data: Schema.NullOr(Schema.fromJsonString(StoredMcpOAuth)),
});
const HookRow = Schema.Struct({
  config: Schema.fromJsonString(ConnectionConfig.members[0]),
  secret: Schema.String,
});
const decodeEventPayload = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const DeliveryRow = Schema.Struct({
  id: Schema.String,
  connection: Schema.String,
  at: Schema.Number,
  outcome: DeliveryOutcome,
  reason: Schema.NullOr(DeliveryReason),
  session: Schema.NullOr(Schema.String),
});
const AutomationRow = Schema.Struct({
  name: Schema.String,
  definition: Schema.fromJsonString(Definition),
  enabled: Schema.Number,
  next_due: Schema.NullOr(Schema.Number),
  created: Schema.Number,
});
const RunRow = Schema.Struct({
  id: Schema.String,
  automation: Schema.String,
  trigger: RunTrigger,
  at: Schema.Number,
  status: RunStatus,
  reason: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Schema.String),
  key: Schema.NullOr(Schema.String),
});
const FireRow = Schema.Struct({
  automation: Schema.String,
  repo: Schema.String,
  agent: AgentKind,
  prompt: Schema.String,
  key: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  action: Action,
  session: Schema.NullOr(Schema.String),
  scripted: Schema.Number,
});
const RunAnswer = Schema.Struct({
  status: Schema.Literals(["started", "steered", "ended", "skipped", "failed"]),
  reason: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
});
const SettledRun = Schema.Struct({ ...RunAnswer.fields, key: Schema.NullOr(Schema.String) });
const DueRow = Schema.Struct({ due: Schema.NullOr(Schema.Number) });
const IdRow = Schema.Struct({ id: Schema.String });
// How many runs are kept, and how many a list returns.
const keptRuns = 500;
const listedRuns = 100;
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
      yield* sql`CREATE TABLE IF NOT EXISTS session_index (id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE IF NOT EXISTS session_keys (key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE)`;
      yield* sql`CREATE TABLE IF NOT EXISTS request_sessions (req TEXT PRIMARY KEY, id TEXT)`;
      // What a search matches (`searchText`). Sessions made before it have no row: they are
      // listed but never found.
      yield* sql`CREATE TABLE IF NOT EXISTS session_search (id TEXT PRIMARY KEY, text TEXT NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS connections (name TEXT PRIMARY KEY, config TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS mcp_oauth (name TEXT PRIMARY KEY, generation TEXT NOT NULL, nonce TEXT, expires INTEGER NOT NULL, data TEXT)`;
      yield* sql`CREATE TABLE IF NOT EXISTS deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, connection TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT, session TEXT)`;
      yield* sql`CREATE TABLE IF NOT EXISTS automations (name TEXT PRIMARY KEY, definition TEXT NOT NULL, enabled INTEGER NOT NULL, next_due INTEGER, created INTEGER NOT NULL)`;
      // A run's source (the schedule time, delivery or manual request) names it once, so a retried
      // firing finds the same run. What it fires is fixed when it is received.
      yield* sql`CREATE TABLE IF NOT EXISTS runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, automation TEXT NOT NULL, source TEXT NOT NULL, trigger TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, session TEXT, delivery TEXT, repo TEXT NOT NULL, agent TEXT NOT NULL, prompt TEXT, key TEXT, branch TEXT, action TEXT NOT NULL, scripted INTEGER NOT NULL, tried INTEGER NOT NULL DEFAULT 0, UNIQUE (automation, source))`;
      yield* sql`CREATE INDEX IF NOT EXISTS runs_by_automation ON runs (automation, seq)`;

      const refreshing = new Map<
        string,
        Effect.Effect<string | null, SqlError | Schema.SchemaError>
      >();
      const oauth = (name: string) =>
        Effect.gen(function* () {
          const row = (yield* sql`SELECT generation, data FROM mcp_oauth WHERE name = ${name}`)[0];
          return row === undefined ? null : yield* Schema.decodeUnknownEffect(OAuthRow)(row);
        });
      const mcpToken = (name: string, row: typeof OAuthRow.Type, rejectedToken?: string) =>
        Effect.gen(function* () {
          const running = refreshing.get(row.generation);
          if (running !== undefined) return yield* running;
          const stored = row.data;
          if (stored === null || stored.phase !== "signed-in") return null;
          if (
            stored.tokens.access_token !== rejectedToken &&
            stored.expiresAt > Date.now() + 60_000
          )
            return stored.tokens.access_token;
          const refresh = yield* Effect.cached(
            Effect.gen(function* () {
              const next = yield* refreshMcp(stored).pipe(
                Effect.catchTag("McpRefreshFailure", (error) =>
                  Effect.gen(function* () {
                    if (error.kind === "rejected")
                      yield* sql`UPDATE mcp_oauth SET data = NULL, nonce = NULL WHERE name = ${name} AND generation = ${row.generation} AND json_extract(data, '$.tokens.access_token') = ${stored.tokens.access_token}`;
                    return null;
                  }),
                ),
              );
              if (next === null) return null;
              const saved =
                yield* sql`UPDATE mcp_oauth SET data = ${JSON.stringify(next)} WHERE name = ${name} AND generation = ${row.generation} AND json_extract(data, '$.tokens.access_token') = ${stored.tokens.access_token} RETURNING name`;
              return saved.length === 0 ? null : next.tokens.access_token;
            }).pipe(
              Effect.uninterruptible,
              Effect.ensuring(Effect.sync(() => refreshing.delete(row.generation))),
            ),
          );
          refreshing.set(row.generation, refresh);
          return yield* refresh;
        });

      const gitHub = Effect.gen(function* () {
        const row = (yield* sql`SELECT token, login, name, email FROM github WHERE id = 1`)[0];
        return row === undefined ? null : yield* Schema.decodeUnknownEffect(GitHubRow)(row);
      });

      const claude = Effect.gen(function* () {
        const row = (yield* sql`SELECT token, expires_at FROM claude WHERE id = 1`)[0];
        return row === undefined ? null : yield* Schema.decodeUnknownEffect(ClaudeRow)(row);
      });

      const automations = Effect.gen(function* () {
        const rows =
          yield* sql`SELECT name, definition, enabled, next_due, created FROM automations ORDER BY name`;
        return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(AutomationRow)(row));
      });

      const runRow = (row: unknown) => Schema.decodeUnknownEffect(RunRow)(row);

      // The one alarm is the soonest of the enabled schedules and the runs waiting for an answer.
      const rearm = Effect.gen(function* () {
        const { due } = yield* Schema.decodeUnknownEffect(DueRow)(
          (yield* sql`SELECT MIN(due) AS due FROM (SELECT next_due AS due FROM automations WHERE enabled = 1 AND next_due IS NOT NULL UNION ALL SELECT MAX(tried, at) + ${refireAfterMs} AS due FROM runs WHERE status = 'received')`)[0],
        );
        if (due === null) yield* state.storage.deleteAlarm();
        else yield* state.storage.setAlarm(due);
      });

      // Records a firing as a run: received with what it will send, or skipped with why.
      const receive = (input: {
        automation: string;
        definition: Definition;
        trigger: typeof RunTrigger.Type;
        source: string;
        payload: unknown;
        skip?: string;
        delivery?: string;
      }) =>
        Effect.gen(function* () {
          const prepared =
            input.skip === undefined
              ? prepare(input.definition, input.payload)
              : { status: "skipped" as const, reason: input.skip };
          const received = prepared.status === "received" ? prepared : undefined;
          const id =
            input.trigger === "event"
              ? `${input.source}:${input.automation}`
              : crypto.randomUUID().replaceAll("-", "");
          const inserted =
            yield* sql`INSERT OR IGNORE INTO runs (id, automation, source, trigger, at, status, reason, delivery, repo, agent, prompt, key, branch, action, scripted) VALUES (${id}, ${input.automation}, ${input.source}, ${input.trigger}, ${Date.now()}, ${prepared.status}, ${prepared.status === "skipped" ? prepared.reason : null}, ${input.delivery ?? null}, ${input.definition.repo}, ${input.definition.agent}, ${received?.prompt ?? null}, ${received?.key ?? null}, ${received?.branch ?? null}, ${input.definition.action ?? "start"}, ${input.definition.scripted === true ? 1 : 0}) RETURNING id`;
          yield* sql`DELETE FROM runs WHERE seq <= (SELECT MAX(seq) FROM runs) - ${keptRuns}`;
          const run = yield* runRow(
            (yield* sql`SELECT id, automation, trigger, at, status, reason, session, delivery, key FROM runs WHERE automation = ${input.automation} AND source = ${input.source}`)[0],
          );
          return { ...run, fresh: inserted.length > 0 };
        });

      const keyed = (key: string | null) =>
        Effect.gen(function* () {
          const row = (yield* sql`SELECT id FROM session_keys WHERE key = ${key}`)[0];
          return row === undefined ? null : (yield* Schema.decodeUnknownEffect(SessionRow)(row)).id;
        });

      // Request targets outlive both routing keys and the bounded run history.
      const resolveSession = (req: string, key: string | null) =>
        Effect.gen(function* () {
          const row = (yield* sql`SELECT id FROM request_sessions WHERE req = ${req}`)[0];
          if (row !== undefined) return (yield* Schema.decodeUnknownEffect(RequestSession)(row)).id;
          const id = yield* keyed(key);
          if (id !== null)
            yield* sql`INSERT INTO request_sessions (req, id) VALUES (${req}, ${id})`;
          return id;
        });

      // Every live socket here watches the session list.
      const broadcast = (
        frame: { kind: "session"; session: SessionView } | { kind: "removed"; id: string },
      ) =>
        Effect.gen(function* () {
          const text = JSON.stringify(frame);
          for (const socket of yield* state.getWebSockets())
            yield* socket.send(text).pipe(Effect.ignoreCause);
        });

      return {
        // `/api/sessions/live`: the client reads the list once, then applies these frames.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers["upgrade"]?.toLowerCase() !== "websocket")
            return HttpServerResponse.text("Expected a WebSocket", { status: 426 });
          const [response] = yield* Cloudflare.upgrade();
          return response;
        }),
        webSocketMessage: (socket: Cloudflare.WebSocket) =>
          socket.close(1008, "Live sockets take no messages").pipe(Effect.ignoreCause),
        webSocketClose: (socket: Cloudflare.WebSocket) =>
          socket.close(1000, "").pipe(Effect.ignoreCause),
        // A Session DO calls this when its list-visible view changes; a deleted session is quiet.
        sessionChanged: (session: SessionView) =>
          Effect.gen(function* () {
            const rows = yield* sql`SELECT id FROM session_index WHERE id = ${session.identity.id}`;
            if (rows.length > 0) yield* broadcast({ kind: "session", session });
          }),
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
          automation?: string;
          run?: string;
        }) =>
          Effect.gen(function* () {
            let id = yield* resolveSession(input.req, input.key ?? null);
            if (id === null) {
              id = yield* Schema.decodeUnknownEffect(SessionId)(input.id);
              if (input.key !== undefined)
                yield* sql`INSERT INTO session_keys (key, id) VALUES (${input.key}, ${id})`;
              yield* sql`INSERT INTO request_sessions (req, id) VALUES (${input.req}, ${id})`;
            }
            yield* sql`INSERT OR IGNORE INTO session_index (id) VALUES (${id})`;
            const text = searchText({ ...input, branch: `scotty/${id}` });
            yield* sql`INSERT OR IGNORE INTO session_search (id, text) VALUES (${id}, ${text})`;
            if (input.run !== undefined)
              yield* sql`UPDATE runs SET session = ${id} WHERE id = ${input.run} AND status = 'received'`;
            return id;
          }).pipe(sql.withTransaction),
        // A retry keeps its target even after the key is released; it may not be made yet.
        resolveSession: (req: string, key: string | null) =>
          resolveSession(req, key).pipe(sql.withTransaction),
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
            yield* broadcast({ kind: "removed", id });
          }),
        connections: () =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT name, created, config, CASE WHEN secret <> '' OR (SELECT json_extract(data, '$.phase') FROM mcp_oauth WHERE mcp_oauth.name = connections.name) = 'signed-in' THEN 'signed-in' WHEN EXISTS (SELECT 1 FROM mcp_oauth WHERE mcp_oauth.name = connections.name AND nonce IS NULL) THEN 'needs-sign-in' ELSE 'signed-out' END AS signIn FROM connections ORDER BY name`;
            return yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(ConnectionRow)(row).pipe(
                Effect.map(({ name, created, config, signIn }) =>
                  config.kind === "mcp"
                    ? { name, created, ...config, signIn }
                    : { name, created, ...config },
                ),
              ),
            );
          }),
        // Only generated secrets are returned. Pasted credentials stay here.
        addConnection: (input: typeof NewConnection.Type) =>
          Effect.gen(function* () {
            const checked = yield* Schema.decodeUnknownEffect(NewConnection)(input).pipe(
              Effect.mapError(() => new CredentialStoreError({ message: "Invalid connection" })),
            );
            const config = configFor(checked);
            const prefix =
              config.kind === "inbound" && config.signature.key.encoding === "base64"
                ? config.signature.key.prefix
                : "whsec_";
            const secret = checked.secret ?? (config.kind === "inbound" ? newSecret(prefix) : "");
            const created = Date.now();
            const inserted =
              yield* sql`INSERT OR IGNORE INTO connections (name, config, secret, created) VALUES (${checked.name}, ${JSON.stringify(config)}, ${secret}, ${created}) RETURNING name`;
            if (inserted.length === 0) return { status: "exists" as const };
            const metadata = { status: "created" as const, name: checked.name, created };
            return config.kind === "inbound"
              ? { ...metadata, ...config, secret: checked.secret === undefined ? secret : null }
              : config.kind === "mcp"
                ? {
                    ...metadata,
                    ...config,
                    signIn: secret === "" ? ("signed-out" as const) : ("signed-in" as const),
                  }
                : { ...metadata, ...config };
          }).pipe(
            Effect.mapError(
              () => new CredentialStoreError({ message: "Could not store connection" }),
            ),
          ),
        // Internal RPC for the streaming proxy only; no HTTP API exposes this method.
        reachCredential: (name: string) =>
          Effect.gen(function* () {
            const row =
              (yield* sql`SELECT connections.secret, connections.config, mcp_oauth.generation AS oauth_generation, mcp_oauth.data AS oauth_data FROM connections LEFT JOIN mcp_oauth ON mcp_oauth.name = connections.name WHERE connections.name = ${name} AND json_extract(config, '$.kind') IN ('token', 'mcp')`)[0];
            if (row === undefined) return null;
            const checked = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                secret: Schema.String,
                oauth_generation: Schema.NullOr(Schema.String),
                oauth_data: Schema.NullOr(Schema.fromJsonString(StoredMcpOAuth)),
                config: Schema.fromJsonString(
                  ConnectionConfig.pipe(
                    Schema.refine((config) => config.kind === "token" || config.kind === "mcp"),
                  ),
                ),
              }),
            )(row);
            const token =
              checked.config.kind === "token" || checked.secret !== ""
                ? checked.secret
                : checked.oauth_generation === null
                  ? null
                  : yield* mcpToken(name, {
                      generation: checked.oauth_generation,
                      data: checked.oauth_data,
                    });
            return {
              config: checked.config,
              secret: token ?? "",
              generation: checked.oauth_generation,
            };
          }).pipe(
            Effect.mapError(
              () => new CredentialStoreError({ message: "Could not read connection" }),
            ),
          ),
        connectMcp: (name: string, redirectUrl: string) =>
          Effect.gen(function* () {
            const row =
              (yield* sql`SELECT config FROM connections WHERE name = ${name} AND json_extract(config, '$.kind') = 'mcp'`)[0];
            if (row === undefined) return { status: "not-found" as const };
            const { config } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ config: Schema.fromJsonString(ConnectionConfig.members[2]) }),
            )(row);
            const previous = yield* oauth(name);
            const nonce = crypto.randomUUID();
            const generation = crypto.randomUUID();
            yield* sql`INSERT OR REPLACE INTO mcp_oauth (name, generation, nonce, expires, data) VALUES (${name}, ${generation}, ${nonce}, ${Date.now() + 600_000}, NULL)`;
            const result = yield* authorizeMcp(config.url, {
              kind: "connect",
              redirectUrl,
              nonce,
              previous: previous?.data ?? null,
            }).pipe(Effect.catchTag("McpOAuthFailure", () => Effect.succeed(null)));
            if (result === null || result.kind !== "redirect") {
              yield* sql`UPDATE mcp_oauth SET nonce = NULL WHERE name = ${name} AND generation = ${generation}`;
              return { status: "failed" as const };
            }
            const saved =
              yield* sql`UPDATE mcp_oauth SET data = ${JSON.stringify(result.stored)} WHERE name = ${name} AND generation = ${generation} RETURNING name`;
            return saved.length === 0
              ? { status: "failed" as const }
              : { status: "redirect" as const, authorizationUrl: result.authorizationUrl };
          }).pipe(
            Effect.mapError(
              () => new CredentialStoreError({ message: "Could not start MCP sign-in" }),
            ),
          ),
        finishMcp: (
          name: string,
          nonce: string,
          answer: { kind: "code"; code: string; iss?: string } | { kind: "denied" },
        ) =>
          Effect.gen(function* () {
            // Claim before any outside call. Unknown, expired and reused callbacks never redeem a code.
            const row =
              (yield* sql`UPDATE mcp_oauth SET nonce = NULL WHERE name = ${name} AND nonce = ${nonce} AND expires > ${Date.now()} RETURNING generation, data`)[0];
            if (row === undefined) return { status: "invalid-state" as const };
            const pending = yield* Schema.decodeUnknownEffect(OAuthRow)(row);
            yield* sql`UPDATE mcp_oauth SET data = NULL WHERE name = ${name} AND generation = ${pending.generation}`;
            if (
              answer.kind === "denied" ||
              pending.data === null ||
              pending.data.phase !== "pending"
            )
              return { status: "failed" as const };
            const connection =
              (yield* sql`SELECT json_extract(config, '$.url') AS url FROM connections WHERE name = ${name}`)[0];
            const { url } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ url: Schema.String }),
            )(connection);
            const result = yield* authorizeMcp(url, {
              kind: "callback",
              pending: pending.data,
              code: answer.code,
              iss: answer.iss,
            }).pipe(Effect.catchTag("McpOAuthFailure", () => Effect.succeed(null)));
            if (result === null || result.kind !== "authorized")
              return { status: "failed" as const };
            const saved =
              yield* sql`UPDATE mcp_oauth SET data = ${JSON.stringify(result.stored)} WHERE name = ${name} AND generation = ${pending.generation} RETURNING name`;
            if (saved.length === 0) return { status: "failed" as const };
            yield* sql`UPDATE connections SET secret = '' WHERE name = ${name} AND EXISTS (SELECT 1 FROM mcp_oauth WHERE name = ${name} AND generation = ${pending.generation})`;
            return { status: "signed-in" as const };
          }).pipe(
            Effect.mapError(
              () => new CredentialStoreError({ message: "Could not finish MCP sign-in" }),
            ),
          ),
        mcpUnauthorized: (name: string, token: string, generation: string) =>
          Effect.gen(function* () {
            const row = yield* oauth(name);
            return row === null || row.generation !== generation
              ? null
              : yield* mcpToken(name, row, token);
          }).pipe(
            Effect.mapError(
              () => new CredentialStoreError({ message: "Could not refresh MCP sign-in" }),
            ),
          ),
        setToolPolicy: (name: string, policy: typeof ToolPolicy.Type) =>
          Effect.gen(function* () {
            const rows =
              yield* sql`UPDATE connections SET config = json_set(config, '$.policy', json(${JSON.stringify(policy)})) WHERE name = ${name} AND json_extract(config, '$.kind') = 'mcp' RETURNING name`;
            return rows.length > 0;
          }),
        removeConnection: (name: string) =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM mcp_oauth WHERE name = ${name}`;
            const rows = yield* sql`DELETE FROM connections WHERE name = ${name} RETURNING name`;
            return rows.length > 0;
          }),
        // Extraction, verification and routing use this one stored connection snapshot.
        verifyDelivery: (input: {
          connection: string;
          headers: Readonly<Record<string, string>>;
          body: Uint8Array<ArrayBuffer>;
        }) =>
          Effect.gen(function* () {
            const row =
              (yield* sql`SELECT secret, config FROM connections WHERE name = ${input.connection} AND json_extract(config, '$.kind') = 'inbound'`)[0];
            if (row === undefined) return { verdict: "unknown_connection", id: "" } as const;
            const { secret, config } = yield* Schema.decodeUnknownEffect(HookRow)(row);
            if (input.body.byteLength > maxBodyBytes) {
              const id =
                config.signature.delivery.kind === "header"
                  ? input.headers[config.signature.delivery.name.toLowerCase()]
                  : undefined;
              return {
                verdict: "too_large",
                id: Option.getOrElse(
                  Schema.decodeUnknownOption(SigningValues.fields.id)(id),
                  () => "",
                ),
              } as const;
            }
            const decoded = readDelivery(config.signature, input.headers, input.body);
            if (decoded.verdict !== "ok") return decoded;
            const id = decoded.values.id;
            const verdict = yield* Effect.promise(() =>
              verifySignature(config.signature, {
                body: input.body,
                values: decoded.values,
                secret,
                now: Date.now(),
              }),
            );
            if (verdict !== "ok") return { verdict, id };
            if (config.signature.selfEvent !== null) {
              const identity = yield* gitHub;
              if (
                identity !== null &&
                field(decoded.payload, config.signature.selfEvent.path) === identity.login
              )
                return { verdict: "own_github_identity", id } as const;
            }
            let payload: unknown = decoded.payload;
            if (config.signature.event?.kind === "header") {
              const checked = decodeEventPayload(payload);
              if (Option.isNone(checked)) return { verdict: "bad_body", id } as const;
              payload = { ...checked.value, event: decoded.values.event };
            }
            const listening = (yield* automations).filter(
              (row) =>
                row.definition.when.kind === "event" &&
                row.definition.when.connection === input.connection,
            );
            const runs =
              listening.length === 0
                ? null
                : yield* Effect.forEach(listening, (row) =>
                    receive({
                      automation: row.name,
                      definition: row.definition,
                      trigger: "event",
                      source: `delivery:${input.connection}:${id}`,
                      payload,
                      delivery: id,
                      ...(row.enabled === 1 ? {} : { skip: "off" }),
                    }),
                  );
            if (runs !== null) yield* rearm;
            return {
              verdict: "ok",
              id,
              payload,
              runs,
              unhandled: config.signature.unhandled,
            } as const;
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
        automations: () =>
          Effect.gen(function* () {
            const found = yield* automations;
            return yield* Effect.forEach(found, (row) =>
              Effect.gen(function* () {
                const last =
                  (yield* sql`SELECT id, automation, trigger, at, status, reason, session, delivery, key FROM runs WHERE automation = ${row.name} ORDER BY seq DESC LIMIT 1`)[0];
                return {
                  name: row.name,
                  ...row.definition,
                  enabled: row.enabled === 1,
                  nextDue: row.next_due,
                  created: row.created,
                  lastRun: last === undefined ? null : yield* runRow(last),
                };
              }),
            );
          }),
        // Adding or replacing leaves the automation off, so whoever wrote it (an agent, say)
        // doesn't also decide that it runs.
        putAutomation: (name: string, definition: Definition, replace: boolean) =>
          Effect.gen(function* () {
            const text = yield* Schema.encodeEffect(Schema.fromJsonString(Definition))(definition);
            const rows = replace
              ? yield* sql`UPDATE automations SET definition = ${text}, enabled = 0, next_due = NULL WHERE name = ${name} RETURNING name`
              : yield* sql`INSERT OR IGNORE INTO automations (name, definition, enabled, next_due, created) VALUES (${name}, ${text}, 0, NULL, ${Date.now()}) RETURNING name`;
            yield* rearm;
            return rows.length > 0;
          }),
        // A schedule counts from now: nothing it missed while off runs.
        enableAutomation: (name: string, enabled: boolean) =>
          Effect.gen(function* () {
            const row = (yield* automations).find((item) => item.name === name);
            if (row === undefined) return false;
            const due = enabled ? nextDue(row.definition.when, Date.now()) : null;
            yield* sql`UPDATE automations SET enabled = ${enabled ? 1 : 0}, next_due = ${due} WHERE name = ${name}`;
            yield* rearm;
            return true;
          }),
        removeAutomation: (name: string) =>
          Effect.gen(function* () {
            const rows = yield* sql`DELETE FROM automations WHERE name = ${name} RETURNING name`;
            yield* rearm;
            return rows.length > 0;
          }),
        // Run now, on or off, with the time as its payload.
        runAutomation: (name: string) =>
          Effect.gen(function* () {
            const row = (yield* automations).find((item) => item.name === name);
            if (row === undefined) return null;
            const run = yield* receive({
              automation: name,
              definition: row.definition,
              trigger: "manual",
              source: `manual:${crypto.randomUUID()}`,
              payload: { at: new Date().toISOString() },
            });
            yield* rearm;
            return run;
          }),
        // What a received run sends, or its stored answer if another attempt settled it.
        // Marks it tried, so the alarm fires it again only if this attempt never answers.
        takeRun: (id: string) =>
          Effect.gen(function* () {
            const taken = yield* sql.withTransaction(
              Effect.gen(function* () {
                const row =
                  (yield* sql`UPDATE runs SET tried = ${Date.now()} WHERE id = ${id} AND status = 'received' RETURNING automation, repo, agent, prompt, key, branch, action, session, scripted`)[0];
                if (row !== undefined) {
                  const run = yield* Schema.decodeUnknownEffect(FireRow)(row);
                  const req = `run:${id}`;
                  const session = run.session ?? (yield* resolveSession(req, run.key));
                  if (run.action !== "start")
                    yield* sql`INSERT OR IGNORE INTO request_sessions (req, id) VALUES (${req}, ${session})`;
                  const target =
                    run.action === "start"
                      ? { action: run.action, session }
                      : session === null
                        ? undefined
                        : { action: run.action, session };
                  if (target === undefined) {
                    yield* sql`UPDATE runs SET status = 'skipped', reason = 'no_session' WHERE id = ${id}`;
                    return {
                      kind: "settled" as const,
                      status: "skipped" as const,
                      reason: "no_session",
                      session: null,
                    };
                  }
                  yield* sql`UPDATE runs SET session = ${session} WHERE id = ${id}`;
                  return {
                    kind: "received" as const,
                    ...run,
                    ...target,
                  };
                }
                const answer =
                  (yield* sql`SELECT status, reason, session FROM runs WHERE id = ${id} AND status != 'received'`)[0];
                return answer === undefined
                  ? null
                  : {
                      kind: "settled" as const,
                      ...(yield* Schema.decodeUnknownEffect(RunAnswer)(answer)),
                    };
              }),
            );
            yield* rearm;
            return taken;
          }),
        // The first answer for a run is its answer.
        settleRun: (
          id: string,
          outcome: {
            status: (typeof RunAnswer.Type)["status"];
            reason?: string;
            session?: string;
          },
        ) =>
          Effect.gen(function* () {
            const settled = yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE runs SET status = ${outcome.status}, reason = ${outcome.reason ?? null}, session = ${outcome.session ?? null} WHERE id = ${id} AND status = 'received'`;
                const row =
                  (yield* sql`SELECT status, reason, session, key FROM runs WHERE id = ${id}`)[0];
                if (row === undefined) return null;
                const answer = yield* Schema.decodeUnknownEffect(SettledRun)(row);
                if (answer.status === "ended") {
                  yield* sql`DELETE FROM session_keys WHERE key = ${answer.key} AND id = ${answer.session}`;
                }
                return { status: answer.status, reason: answer.reason, session: answer.session };
              }),
            );
            yield* rearm;
            return settled;
          }),
        runs: (automation?: string) =>
          Effect.gen(function* () {
            const rows =
              automation === undefined
                ? yield* sql`SELECT id, automation, trigger, at, status, reason, session, delivery, key FROM runs ORDER BY seq DESC LIMIT ${listedRuns}`
                : yield* sql`SELECT id, automation, trigger, at, status, reason, session, delivery, key FROM runs WHERE automation = ${automation} ORDER BY seq DESC LIMIT ${listedRuns}`;
            return yield* Effect.forEach(rows, runRow);
          }),
        // Due schedules become runs and move on; then each received run without an answer is
        // handed to the Worker, which starts or steers its session. Everything this object
        // records is written before it hands anything over.
        alarm: () =>
          Effect.gen(function* () {
            const now = Date.now();
            const fire: string[] = [];
            for (const row of yield* automations) {
              if (row.enabled !== 1 || row.next_due === null || row.next_due > now) continue;
              const run = yield* receive({
                automation: row.name,
                definition: row.definition,
                trigger: "schedule",
                source: `schedule:${row.next_due}`,
                payload: { at: new Date(row.next_due).toISOString() },
                ...(now - row.next_due > missedAfterMs ? { skip: "missed" } : {}),
              });
              if (run.fresh && run.status === "received") fire.push(run.id);
              const following = nextDue(row.definition.when, row.next_due);
              const due =
                following !== null && following > now
                  ? following
                  : nextDue(row.definition.when, now);
              yield* sql`UPDATE automations SET next_due = ${due} WHERE name = ${row.name}`;
            }
            yield* sql`UPDATE runs SET status = 'failed', reason = 'no answer within an hour' WHERE status = 'received' AND at <= ${now - giveUpAfterMs}`;
            const waiting =
              yield* sql`SELECT id FROM runs WHERE status = 'received' AND MAX(tried, at) + ${refireAfterMs} <= ${now}`;
            for (const row of waiting)
              fire.push((yield* Schema.decodeUnknownEffect(IdRow)(row)).id);
            yield* rearm;
            const loopback: unknown = Reflect.get(state.raw.exports, "default");
            if (!isLoopback(loopback)) return yield* Effect.die("no ctx.exports.default");
            yield* Effect.forEach(
              fire,
              (run) =>
                Effect.tryPromise(() =>
                  loopback({ props: { run } }).fetch("https://run.internal/"),
                ).pipe(Effect.ignore),
              { concurrency: "unbounded", discard: true },
            );
          }).pipe(Effect.orDie),
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
