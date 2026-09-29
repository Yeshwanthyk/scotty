import { Exit, Schema } from "effect";

// `npm run e2e -- <name> --agent codex|claude`; Codex by default.
const at = process.argv.indexOf("--agent");
const decoded = Schema.decodeUnknownExit(Schema.Literals(["codex", "claude"]))(
  at < 0 ? "codex" : process.argv[at + 1],
);
if (Exit.isFailure(decoded)) throw new Error("--agent takes codex or claude");
export const agent = decoded.value;
