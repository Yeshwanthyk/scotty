import { Schema } from "effect";
import {
  CanonicalConversationQueueItemSchema,
  CONVERSATION_MAX_QUEUE_ITEMS,
} from "../../../protocol/conversation";

export const CodexFollowUpSchema = Schema.Struct({
  ...CanonicalConversationQueueItemSchema.fields,
  attempt: Schema.optionalKey(
    Schema.Struct({
      generation: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
      threadId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    }),
  ),
});
export const CodexFollowUpsSchema = Schema.Struct({
  pending: Schema.Array(CodexFollowUpSchema).check(
    Schema.isMaxLength(CONVERSATION_MAX_QUEUE_ITEMS),
  ),
  receipts: Schema.Array(CanonicalConversationQueueItemSchema).check(
    Schema.isMaxLength(CONVERSATION_MAX_QUEUE_ITEMS),
  ),
});
export type CodexFollowUps = typeof CodexFollowUpsSchema.Type;
export const decodeCodexFollowUps = Schema.decodeUnknownEffect(CodexFollowUpsSchema);
export const emptyCodexFollowUps = (): CodexFollowUps => ({ pending: [], receipts: [] });
export const enqueueCodexFollowUp = (
  queue: CodexFollowUps,
  item: typeof CanonicalConversationQueueItemSchema.Type,
) => {
  const existing = [...queue.pending, ...queue.receipts].find((entry) => entry.id === item.id);
  if (existing !== undefined)
    return existing.text === item.text
      ? { status: "replay" as const, queue }
      : { status: "conflict" as const, queue };
  if (queue.pending.length + queue.receipts.length >= CONVERSATION_MAX_QUEUE_ITEMS)
    return { status: "full" as const, queue };
  const next = { ...queue, pending: [...queue.pending, item] };
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 96 * 1024)
    return { status: "full" as const, queue };
  return { status: "queued" as const, queue: next };
};
export const confirmCodexFollowUp = (queue: CodexFollowUps, id: string): CodexFollowUps => {
  const item = queue.pending.find((entry) => entry.id === id);
  if (item === undefined) return queue;
  return {
    pending: queue.pending.filter((entry) => entry.id !== id),
    receipts: [...queue.receipts, { id: item.id, text: item.text }],
  };
};
