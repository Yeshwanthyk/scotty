import { Schema } from "effect";
import { runSidecarServer } from "../sidecar/server";
import { ClaudeLaunch, startClaudeRuntime } from "./host";

export const claudeServer = {
  agent: "claude",
  decodeLaunch: Schema.decodeUnknownEffect(ClaudeLaunch, { onExcessProperty: "error" }),
  start: (input) => startClaudeRuntime(input),
} satisfies Parameters<typeof runSidecarServer<typeof ClaudeLaunch.Type, unknown>>[0];

export const runServer = (argv: ReadonlyArray<string>) => runSidecarServer(claudeServer, argv);
