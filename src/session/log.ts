import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema, Semaphore } from "effect";
import { command } from "./commands.js";
import { SessionEvent } from "./events.js";
import { deadline, fold, initial, invariants, type State } from "./fold.js";

export type Draft = SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, "seq" | "at" | "src">
    : never
  : never;
const Row = Schema.Struct({ data: Schema.String });

/** SQLite is authoritative; state and history are projections of its event rows. */
export const openLog = (storage: Cloudflare.DurableObjectState["Service"]) =>
  Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* sql`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, src TEXT NOT NULL, kind TEXT NOT NULL, op TEXT NOT NULL, data TEXT NOT NULL)`;
    const rows = yield* sql`SELECT data FROM events ORDER BY seq`;
    const history: SessionEvent[] = [];
    let current: State = initial;
    for (const row of rows) {
      const decoded = yield* Schema.decodeUnknownEffect(Row)(row);
      const event = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SessionEvent))(
        decoded.data,
      );
      history.push(event);
      current = fold(current, event);
    }
    const mutex = yield* Semaphore.make(1);
    const append = (draft: Draft, src: string) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const event = yield* Schema.decodeUnknownEffect(SessionEvent)({
            ...draft,
            seq: current.lastSeq + 1,
            at: Date.now(),
            src,
          });
          yield* sql`INSERT INTO events (seq, at, src, kind, op, data) VALUES (${event.seq}, ${event.at}, ${event.src}, ${event.kind}, ${event.kind}, ${JSON.stringify(event)})`;
          history.push(event);
          current = fold(current, event);
          for (const violation of invariants(current)) {
            const incident = yield* Schema.decodeUnknownEffect(SessionEvent)({
              kind: "invariant.violated",
              code: violation.code,
              detail: violation.detail,
              seq: current.lastSeq + 1,
              at: event.at,
              src: "session",
            });
            yield* sql`INSERT INTO events (seq, at, src, kind, op, data) VALUES (${incident.seq}, ${incident.at}, ${incident.src}, ${incident.kind}, ${incident.kind}, ${JSON.stringify(incident)})`;
            history.push(incident);
            current = fold(current, incident);
          }
          const due = deadline(current);
          if (due === undefined) yield* storage.storage.deleteAlarm();
          else yield* storage.storage.setAlarm(due);
          return command(current, event);
        }),
      );
    return {
      append,
      get state() {
        return current;
      },
      history,
    };
  });
