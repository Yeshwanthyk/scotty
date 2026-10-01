import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SigningHeaders } from "../hooks/handler.js";
import { newSecret, verifyGitHub, verifyWebhook } from "../hooks/signature.js";
import {
  ConnectionConfig,
  NewConnection,
  DeliveryOutcome,
  DeliveryReason,
  keptDeliveries,
} from "./connections.js";
import { isLoopback } from "../loopback.js";
import { searchText } from "../session/search.js";
import { AgentKind } from "../session/events.js";
import { exchangeCode, OAuthFailure, pollDevice, startDevice } from "./oauth.js";
import {
  Definition,
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
});
const HookRow = Schema.Struct({
  secret: Schema.String,
  kind: Schema.Literals(["webhook", "github"]),
});
const GitHubPayload = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      sender: Schema.optionalKey(
        Schema.StructWithRest(Schema.Struct({ login: Schema.String }), [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
      ),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);
export type DeliveryVerification =
  | { verdict: "ok"; kind: "webhook" }
  | { verdict: "ok"; kind: "github"; payload: typeof GitHubPayload.Type & { event: string } }
  | {
      verdict:
        | "unknown_connection"
        | "missing_headers"
        | "bad_signature"
        | "stale_timestamp"
        | "bad_body"
        | "own_github_identity";
    };
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
  scripted: Schema.Number,
});
const RunAnswer = Schema.Struct({
  status: Schema.Literals(["started", "steered", "failed"]),
  reason: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
});
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
      yield* sql`CREATE TABLE IF NOT EXISTS session_index (req TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE)`;
      yield* sql`CREATE TABLE IF NOT EXISTS session_keys (key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE)`;
      // What a search matches (`searchText`). Sessions made before it have no row: they are
      // listed but never found.
      yield* sql`CREATE TABLE IF NOT EXISTS session_search (id TEXT PRIMARY KEY, text TEXT NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS connections (name TEXT PRIMARY KEY, config TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, connection TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT, session TEXT)`;
      yield* sql`CREATE TABLE IF NOT EXISTS automations (name TEXT PRIMARY KEY, definition TEXT NOT NULL, enabled INTEGER NOT NULL, next_due INTEGER, created INTEGER NOT NULL)`;
      // A run's source (the schedule time, delivery or manual request) names it once, so a retried
      // firing finds the same run. What it fires is fixed when it is received.
      yield* sql`CREATE TABLE IF NOT EXISTS runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, automation TEXT NOT NULL, source TEXT NOT NULL, trigger TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, session TEXT, delivery TEXT, repo TEXT NOT NULL, agent TEXT NOT NULL, prompt TEXT, key TEXT, scripted INTEGER NOT NULL, tried INTEGER NOT NULL DEFAULT 0, UNIQUE (automation, source))`;
      yield* sql`CREATE INDEX IF NOT EXISTS runs_by_automation ON runs (automation, seq)`;

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
            yield* sql`INSERT OR IGNORE INTO runs (id, automation, source, trigger, at, status, reason, delivery, repo, agent, prompt, key, scripted) VALUES (${id}, ${input.automation}, ${input.source}, ${input.trigger}, ${Date.now()}, ${prepared.status}, ${prepared.status === "skipped" ? prepared.reason : null}, ${input.delivery ?? null}, ${input.definition.repo}, ${input.definition.agent}, ${received?.prompt ?? null}, ${received?.key ?? null}, ${input.definition.scripted === true ? 1 : 0}) RETURNING id`;
          yield* sql`DELETE FROM runs WHERE seq <= (SELECT MAX(seq) FROM runs) - ${keptRuns}`;
          const run = yield* runRow(
            (yield* sql`SELECT id, automation, trigger, at, status, reason, session, delivery, key FROM runs WHERE automation = ${input.automation} AND source = ${input.source}`)[0],
          );
          return { ...run, fresh: inserted.length > 0 };
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
          automation?: string;
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
            const rows = yield* sql`SELECT name, created, config FROM connections ORDER BY name`;
            return yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(ConnectionRow)(row).pipe(
                Effect.map(({ name, created, config }) => ({ name, created, ...config })),
              ),
            );
          }),
        // Only a generated webhook secret is returned. Pasted credentials stay here.
        addConnection: (input: typeof NewConnection.Type) =>
          Effect.gen(function* () {
            const checked = yield* Schema.decodeUnknownEffect(NewConnection)(input).pipe(
              Effect.mapError(() => new CredentialStoreError({ message: "Invalid connection" })),
            );
            const secret =
              checked.kind === "webhook" || checked.kind === "github"
                ? newSecret()
                : checked.secret;
            const created = Date.now();
            const config = yield* Schema.decodeUnknownEffect(ConnectionConfig)(checked);
            const inserted =
              yield* sql`INSERT OR IGNORE INTO connections (name, config, secret, created) VALUES (${checked.name}, ${JSON.stringify(config)}, ${secret}, ${created}) RETURNING name`;
            if (inserted.length === 0) return { status: "exists" as const };
            const metadata = { status: "created" as const, name: checked.name, created };
            return config.kind === "webhook" || config.kind === "github"
              ? { ...metadata, ...config, secret }
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
              (yield* sql`SELECT secret, config FROM connections WHERE name = ${name} AND json_extract(config, '$.kind') IN ('token', 'mcp')`)[0];
            if (row === undefined) return null;
            return yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                secret: Schema.String,
                config: Schema.fromJsonString(
                  ConnectionConfig.pipe(
                    Schema.refine((config) => config.kind === "token" || config.kind === "mcp"),
                  ),
                ),
              }),
            )(row);
          }).pipe(
            Effect.mapError(
              () => new CredentialStoreError({ message: "Could not read connection" }),
            ),
          ),
        removeConnection: (name: string) =>
          Effect.gen(function* () {
            const rows = yield* sql`DELETE FROM connections WHERE name = ${name} RETURNING name`;
            return rows.length > 0;
          }),
        // The secret stays in this object: the Worker hands over what the sender signed.
        verifyDelivery: (input: {
          connection: string;
          headers: SigningHeaders;
          body: Uint8Array<ArrayBuffer>;
        }): Effect.Effect<DeliveryVerification, SqlError | Schema.SchemaError> =>
          Effect.gen(function* () {
            const row =
              (yield* sql`SELECT secret, json_extract(config, '$.kind') AS kind FROM connections WHERE name = ${input.connection} AND json_extract(config, '$.kind') IN ('webhook', 'github')`)[0];
            if (row === undefined) return { verdict: "unknown_connection" as const };
            const { secret, kind } = yield* Schema.decodeUnknownEffect(HookRow)(row);
            const checked = input.headers;
            if (checked.kind !== kind) return { verdict: "missing_headers" as const };
            const body = new TextDecoder().decode(input.body);
            if (checked.kind === "webhook") {
              const verdict = yield* Effect.promise(() =>
                verifyWebhook({
                  secret,
                  id: checked.id,
                  timestamp: checked.timestamp,
                  signature: checked.signature,
                  body,
                  now: Date.now(),
                }),
              );
              return verdict === "ok" ? { kind: checked.kind, verdict } : { verdict };
            }
            const verdict = yield* Effect.promise(() =>
              verifyGitHub({
                secret,
                signature: checked.signature,
                body: input.body,
              }),
            );
            if (verdict !== "ok") return { verdict };
            const payload = Schema.decodeUnknownOption(GitHubPayload)(body);
            if (Option.isNone(payload)) return { verdict: "bad_body" as const };
            const identity = yield* gitHub;
            if (identity !== null && payload.value.sender?.login === identity.login)
              return { verdict: "own_github_identity" as const };
            return {
              kind: checked.kind,
              verdict: "ok" as const,
              payload: { ...payload.value, event: checked.event },
            };
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
        // A verified delivery becomes one run per automation listening on its connection, or
        // null when none listens. A repeated delivery finds the runs it made the first time.
        receiveEvent: (connection: string, delivery: string, payload: unknown) =>
          Effect.gen(function* () {
            const listening = (yield* automations).filter(
              (row) =>
                row.definition.when.kind === "event" &&
                row.definition.when.connection === connection,
            );
            if (listening.length === 0) return null;
            const runs = yield* Effect.forEach(listening, (row) =>
              receive({
                automation: row.name,
                definition: row.definition,
                trigger: "event",
                source: `delivery:${connection}:${delivery}`,
                payload,
                delivery,
                ...(row.enabled === 1 ? {} : { skip: "off" }),
              }),
            );
            yield* rearm;
            return runs;
          }),
        // What a received run sends, or its stored answer if another attempt settled it.
        // Marks it tried, so the alarm fires it again only if this attempt never answers.
        takeRun: (id: string) =>
          Effect.gen(function* () {
            const row =
              (yield* sql`UPDATE runs SET tried = ${Date.now()} WHERE id = ${id} AND status = 'received' RETURNING automation, repo, agent, prompt, key, scripted`)[0];
            yield* rearm;
            if (row !== undefined)
              return {
                kind: "received" as const,
                ...(yield* Schema.decodeUnknownEffect(FireRow)(row)),
              };
            const answer =
              (yield* sql`SELECT status, reason, session FROM runs WHERE id = ${id} AND status IN ('started', 'steered', 'failed')`)[0];
            return answer === undefined
              ? null
              : {
                  kind: "settled" as const,
                  ...(yield* Schema.decodeUnknownEffect(RunAnswer)(answer)),
                };
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
            yield* sql`UPDATE runs SET status = ${outcome.status}, reason = ${outcome.reason ?? null}, session = ${outcome.session ?? null} WHERE id = ${id} AND status = 'received'`;
            yield* rearm;
            const answer =
              (yield* sql`SELECT status, reason, session FROM runs WHERE id = ${id}`)[0];
            return answer === undefined
              ? null
              : yield* Schema.decodeUnknownEffect(RunAnswer)(answer);
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
