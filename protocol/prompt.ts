import { Schema } from "effect";

// Compressed by the composer before sending. Bound the whole prompt so its event and socket
// command fit the Worker RPC/socket and Durable Object SQLite row limits.
export const PromptImage = Schema.Struct({
  mediaType: Schema.Literals(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  data: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(220_000),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
});
export const PromptImages = Schema.Array(PromptImage).check(
  Schema.isMaxLength(4),
  Schema.makeFilter(
    (images) => images.reduce((sum, image) => sum + image.data.length, 0) <= 700_000,
    { expected: "at most 700 KB of encoded images" },
  ),
);
export type PromptImage = typeof PromptImage.Type;
export const imageUrl = (image: PromptImage) => `data:${image.mediaType};base64,${image.data}`;
export const sameImages = (left: readonly PromptImage[] = [], right: readonly PromptImage[] = []) =>
  left.length === right.length &&
  left.every(
    (image, index) =>
      image.mediaType === right[index]?.mediaType && image.data === right[index]?.data,
  );
