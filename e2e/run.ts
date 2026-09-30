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
    "hooks",
    "automations",
    "init",
  ]),
)(process.argv[2]);
if (Exit.isFailure(testName))
  throw new Error(
    "Usage: npm run e2e -- core|stop-resume|github|hatch|hatch-env|files|settings|terminal|hooks|automations [--agent codex|claude] [--real], or init --stage <name>",
  );
await import(`./${testName.value}.js`);
