import {
  PiConsoleImagesSchema,
  PI_CONSOLE_MAX_IMAGE_BYTES,
  type PiConsoleImage,
} from "../../../protocol/pi-console";
import { Schema } from "effect";
import {
  CanonicalConversationQueueItemSchema,
  CONVERSATION_MAX_QUEUE_ITEMS,
} from "../../../protocol/conversation";

const FollowUpContentSchema = Schema.Struct({
  ...CanonicalConversationQueueItemSchema.fields,
  imageDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
});
export const CodexFollowUpSchema = Schema.Struct({
  ...FollowUpContentSchema.fields,
  images: Schema.optionalKey(PiConsoleImagesSchema),
  attempt: Schema.optionalKey(
    Schema.Struct({
      generation: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
      threadId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    }),
  ),
}).check(
  Schema.makeFilter((entry) =>
    (entry.images?.length ?? 0) > 0
      ? entry.imageDigest !== undefined
      : entry.imageDigest === undefined,
  ),
);
export const CodexFollowUpsSchema = Schema.Struct({
  pending: Schema.Array(CodexFollowUpSchema).check(
    Schema.isMaxLength(CONVERSATION_MAX_QUEUE_ITEMS),
  ),
  receipts: Schema.Array(FollowUpContentSchema).check(
    Schema.isMaxLength(CONVERSATION_MAX_QUEUE_ITEMS),
  ),
});
export type CodexFollowUps = typeof CodexFollowUpsSchema.Type;
export const decodeCodexFollowUps = Schema.decodeUnknownEffect(CodexFollowUpsSchema);
export const emptyCodexFollowUps = (): CodexFollowUps => ({ pending: [], receipts: [] });
const imageBytes = (image: PiConsoleImage): number =>
  (image.data.length / 4) * 3 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);

export const enqueueCodexFollowUp = (
  queue: CodexFollowUps,
  item: typeof CodexFollowUpSchema.Type,
) => {
  const existing = [...queue.pending, ...queue.receipts].find((entry) => entry.id === item.id);
  if (existing !== undefined)
    return existing.text === item.text && existing.imageDigest === item.imageDigest
      ? { status: "replay" as const, queue }
      : { status: "conflict" as const, queue };
  if (queue.pending.length + queue.receipts.length >= CONVERSATION_MAX_QUEUE_ITEMS)
    return { status: "full" as const, queue };
  if (
    [...queue.pending, item].reduce(
      (size, entry) =>
        size + (entry.images ?? []).reduce((total, image) => total + imageBytes(image), 0),
      0,
    ) > PI_CONSOLE_MAX_IMAGE_BYTES
  )
    return { status: "full" as const, queue };
  const next = { ...queue, pending: [...queue.pending, item] };
  return { status: "queued" as const, queue: next };
};
export const confirmCodexFollowUp = (queue: CodexFollowUps, id: string): CodexFollowUps => {
  const item = queue.pending.find((entry) => entry.id === id);
  if (item === undefined) return queue;
  return {
    pending: queue.pending.filter((entry) => entry.id !== id),
    receipts: [
      ...queue.receipts,
      {
        id: item.id,
        text: item.text,
        ...(item.imageDigest === undefined ? {} : { imageDigest: item.imageDigest }),
      },
    ],
  };
};
