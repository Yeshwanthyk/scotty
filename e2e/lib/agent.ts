import { Exit, Schema } from "effect";
import { defaultPlace, PlaceKind } from "../../src/places/place.js";

const at = process.argv.indexOf("--agent");
const decoded = Schema.decodeUnknownExit(Schema.Literals(["codex", "claude"]))(
  at < 0 ? "codex" : process.argv[at + 1],
);
if (Exit.isFailure(decoded)) throw new Error("--agent takes codex or claude");
export const agent = decoded.value;
export const real = process.argv.includes("--real");
const placeAt = process.argv.indexOf("--place");
const placed = Schema.decodeUnknownExit(PlaceKind)(
  placeAt < 0 ? defaultPlace : process.argv[placeAt + 1],
);
if (Exit.isFailure(placed)) throw new Error(`--place takes ${PlaceKind.literals.join(" or ")}`);
export const place = placed.value;

export const sessionAgent = real ? { agent } : { agent, scripted: true as const };

export const prompt = (words: string, script: string) => (real ? words : script);
