import { Option, Schema } from "effect";

// Display metadata is optional for old transcripts and tools owned by the runtime.
// Project only this field, never the rest of a native tool's arguments.
const decodeDisplayText = Schema.decodeUnknownOption(
  Schema.Struct({
    displayText: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(180),
      // oxlint-disable-next-line eslint/no-control-regex -- labels must be plain single-line text
      Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*(?![\s\S])/u),
    ),
  }),
);

export const toolDisplayText = (input: unknown): string | undefined => {
  const decoded = decodeDisplayText(input);
  if (Option.isNone(decoded)) return undefined;
  const text = decoded.value.displayText
    .trim()
    .replaceAll(/scotty-managed:\/\/[^\s"'<>]+/gu, "[managed-handle]")
    .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]");
  return text.length === 0 || text.length > 180 ? undefined : text;
};
