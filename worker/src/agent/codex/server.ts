import { Schema } from "effect";
import { runSidecarServer } from "../sidecar/server";
import { CodexLaunch } from "./process";
import { startCodexRuntime } from "./runtime";

export const codexServer = {
  agent: "codex",
  decodeLaunch: Schema.decodeUnknownEffect(CodexLaunch, { onExcessProperty: "error" }),
  start: (input) => startCodexRuntime(input),
} satisfies Parameters<typeof runSidecarServer<typeof CodexLaunch.Type, unknown>>[0];

export const runServer = (argv: ReadonlyArray<string>) => runSidecarServer(codexServer, argv);
