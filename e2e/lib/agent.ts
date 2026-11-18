import { Exit, Schema } from "effect";

const at = process.argv.indexOf("--agent");
const decoded = Schema.decodeUnknownExit(Schema.Literals(["codex", "claude"]))(
  at < 0 ? "codex" : process.argv[at + 1],
);
if (Exit.isFailure(decoded)) throw new Error("--agent takes codex or claude");
export const agent = decoded.value;
export const real = process.argv.includes("--real");

export const sessionAgent = real ? { agent } : { agent, scripted: true as const };

export const prompt = (words: string, script: string) => (real ? words : script);
