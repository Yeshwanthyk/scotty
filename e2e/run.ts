import { Exit, Schema } from "effect";

const testName = Schema.decodeUnknownExit(
  Schema.Literals([
    "core",
    "startup",
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
    "scotty-mcp",
    "automations",
    "blueprints",
    "init",
    "lifecycle",
    "live",
    "sizes",
    "drafts",
    "defaults",
    "images",
    "repositories",
    "daytona",
    "tunnel",
  ]),
)(process.argv[2]);
if (Exit.isFailure(testName))
  throw new Error(
    "Usage: npm run e2e -- core|startup|stop-resume|github|hatch|hatch-env|files|settings|terminal|lifecycle|live|sizes|drafts|defaults|images|repositories|daytona|tunnel|hooks|signatures|reach|mcp-oauth|scotty-mcp|automations|blueprints [--agent codex|claude] [--real], or init --stage <name>",
  );
await import(`./${testName.value}.js`);
