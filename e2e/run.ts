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
    "signatures",
    "reach",
    "mcp-oauth",
    "automations",
    "init",
    "lifecycle",
    "live",
  ]),
)(process.argv[2]);
if (Exit.isFailure(testName))
  throw new Error(
    "Usage: npm run e2e -- core|stop-resume|github|hatch|hatch-env|files|settings|terminal|lifecycle|live|hooks|signatures|reach|mcp-oauth|automations [--agent codex|claude] [--real], or init --stage <name>",
  );
await import(`./${testName.value}.js`);
