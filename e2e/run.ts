import { Exit, Schema } from "effect";

const testName = Schema.decodeUnknownExit(Schema.Literals(["core", "stop-resume", "github"]))(
  process.argv[2],
);
if (Exit.isFailure(testName)) throw new Error("Usage: npm run e2e -- core|stop-resume|github");
await import(`./${testName.value}.js`);
