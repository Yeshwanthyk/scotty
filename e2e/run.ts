import { Exit, Schema } from "effect";

const testName = Schema.decodeUnknownExit(
  Schema.Literals([
    "core",
    "stop-resume",
    "github",
    "hatch",
    "hatch-env",
    "files",
    "settings",
    "terminal",
    "init",
    "lifecycle",
  ]),
)(process.argv[2]);
if (Exit.isFailure(testName))
  throw new Error(
    "Usage: npm run e2e -- core|stop-resume|github|hatch|hatch-env|files|settings|terminal|lifecycle [--agent codex|claude] [--real], or init --stage <name>",
  );
await import(`./${testName.value}.js`);
