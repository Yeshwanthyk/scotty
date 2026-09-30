import { Schema } from "effect";

// A search text, trimmed, is at most this many characters.
export const maxSearch = 200;
export const SearchQuery = Schema.String.check(Schema.isMaxLength(maxSearch));

// What a search matches, any case: what the owner remembers a session by.
export const searchText = (fields: {
  title: string;
  repo: string;
  branch: string;
  prompt: string;
  key?: string;
  connection?: string;
}) =>
  [
    fields.title,
    fields.repo,
    fields.branch,
    fields.prompt,
    fields.key ?? "",
    fields.connection ?? "",
  ]
    .join("\n")
    .toLowerCase();
