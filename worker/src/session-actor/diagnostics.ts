import { Equal, Result, Schema } from "effect";
import { SessionAuthoritySchema, type SessionAuthority } from "./authority";
import {
  decodeLifecycleJournalEvent,
  LifecycleJournalEventSchema,
  type LifecycleJournalEvent,
} from "./journal";

export const SessionActorDiagnosticsSchema = Schema.Struct({
  authority: SessionAuthoritySchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  journalSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  journalTail: LifecycleJournalEventSchema,
  journal: Schema.Array(LifecycleJournalEventSchema),
  journalTruncated: Schema.Boolean,
});
export type SessionActorDiagnostics = typeof SessionActorDiagnosticsSchema.Type;

export const makeSessionActorDiagnostics = (
  authority: SessionAuthority,
  journalSequence: number,
  journalTail: LifecycleJournalEvent,
  rawJournal: ReadonlyArray<unknown>,
): Result.Result<SessionActorDiagnostics, "invalid_journal"> => {
  const journal: LifecycleJournalEvent[] = [];
  for (const raw of rawJournal) {
    const decoded = decodeLifecycleJournalEvent(raw);
    if (Result.isFailure(decoded)) return Result.fail("invalid_journal");
    journal.push(decoded.success);
  }
  journal.sort((left, right) => left.sequence - right.sequence);
  const first = journal[0];
  const last = journal[journal.length - 1];
  if (
    first === undefined ||
    last === undefined ||
    journal.some((event, index) => {
      const previous = journal[index - 1];
      return previous !== undefined && event.sequence !== previous.sequence + 1;
    }) ||
    last.sequence !== journalSequence ||
    journalTail.sequence !== journalSequence ||
    !Equal.equals(last, journalTail)
  )
    return Result.fail("invalid_journal");
  return Result.succeed({
    authority,
    revision: authority.revision,
    journalSequence,
    journalTail,
    journal,
    journalTruncated: first.sequence !== 1,
  });
};
