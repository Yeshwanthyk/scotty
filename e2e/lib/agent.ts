import { Exit, Schema } from "effect";

// `npm run e2e -- <name> [--agent codex|claude] [--real]`. By default a session runs its agent's
// scripted stand-in (container/scripted/), so e2e needs no ChatGPT or Claude sign-in and doesn't
// depend on a model's wording; --real runs the real agent.
const at = process.argv.indexOf("--agent");
const decoded = Schema.decodeUnknownExit(Schema.Literals(["codex", "claude"]))(
  at < 0 ? "codex" : process.argv[at + 1],
);
if (Exit.isFailure(decoded)) throw new Error("--agent takes codex or claude");
export const agent = decoded.value;
export const real = process.argv.includes("--real");

// The create body's agent fields.
export const sessionAgent = real ? { agent } : { agent, scripted: true as const };

// A prompt in words for a real agent, or as a script for the stand-in.
export const prompt = (words: string, script: string) => (real ? words : script);
