import { Schema } from "effect";

export const maxSearch = 200;
export const SearchQuery = Schema.String.check(Schema.isMaxLength(maxSearch));

export const searchText = (fields: {
  title: string;
  repo: string;
  branch: string;
  prompt: string;
  key?: string;
  connection?: string;
  automation?: string;
}) =>
  [
    fields.title,
    fields.repo,
    fields.branch,
    fields.prompt,
    fields.key ?? "",
    fields.connection ?? "",
    fields.automation ?? "",
  ]
    .join("\n")
    .toLowerCase();
