import { Exit, Schema } from "effect";

const testName = Schema.decodeUnknownExit(Schema.Literal("core"))(process.argv[2]);
if (Exit.isFailure(testName)) throw new Error("Usage: npm run e2e -- core");
await import("./core.js");
