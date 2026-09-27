import { Exit, Schema } from "effect";

const testName = Schema.decodeUnknownExit(Schema.Literals(["core", "stop-resume"]))(
  process.argv[2],
);
if (Exit.isFailure(testName)) throw new Error("Usage: npm run e2e -- core|stop-resume");
await import(testName.value === "core" ? "./core.js" : "./stop-resume.js");
