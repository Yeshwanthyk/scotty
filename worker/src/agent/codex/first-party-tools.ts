import {
  ScottyHatchManager,
  HatchFailure,
  renderHatchFailure,
  ScottyHatchToolParameters,
} from "../../../container/pi-packages/sources/scotty-hatch/index";
import { Schema } from "effect";
import {
  BrowserEvidenceToolParameters,
  renderBrowserEvidenceResult,
  runScottyBrowserTest,
} from "../../../container/pi-packages/sources/scotty-browser-test/index";

// Native app-server accepts these only at thread/start. The source
// schemas are the same ones used by the Pi extensions and execution boundary.
export const codexFirstPartyToolSpecs = [
  {
    type: "function" as const,
    name: "scotty_hatch",
    description:
      "Ensure, inspect, or close the current session's application Hatch. Ensure without service fields reads reviewed repository-root hatch.toml; if absent, do not retry. Use complete inline configuration only as a manual override. Include the exact returned scotty-hatch reference once in the next meaningful update; never publish ports, paths, argv, authority values, or URLs. Include displayText on every call: a short phrase describing the intended task, not the tool name or a claim of success; omit credentials, URLs, and internal identifiers.",
    inputSchema: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
      JSON.stringify(ScottyHatchToolParameters),
    ),
  },
  {
    type: "function" as const,
    name: "scotty_browser_test",
    description:
      "Run one bounded browser evidence job against an already-running local app at its sandbox-local address after confirming real render readiness. App preview and capture are independent workflows. Use the app's allowed port, relative paths, and declarative assertions. For user-visible changes, capture the same flow before and after, with video enabled for the after run. Capture cleans up only resources it created. It leaves the target app running. A port_conflict is a concrete blocker: report it without restarting or reconfiguring the target app. Include the exact scotty-evidence reference returned by the first-party tool result once in the next meaningful update; never publish the authenticated summary URL. Include displayText on every call: a short phrase describing the intended task, not the tool name or a claim of success; omit credentials, URLs, and internal identifiers.",
    inputSchema: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
      JSON.stringify(BrowserEvidenceToolParameters),
    ),
  },
] as const;

export type CodexFirstPartyToolName = (typeof codexFirstPartyToolSpecs)[number]["name"];
export interface CodexFirstPartyToolResult {
  readonly text: string;
  readonly success: boolean;
}
export interface CodexFirstPartyTools {
  readonly restore: (signal: AbortSignal) => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly execute: (
    tool: CodexFirstPartyToolName,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<CodexFirstPartyToolResult>;
}

export function makeCodexFirstPartyTools(workspaceRoot: string): CodexFirstPartyTools {
  const hatch = new ScottyHatchManager({ workspaceRoot });
  return {
    restore: (signal) => hatch.restore(signal),
    shutdown: () => hatch.shutdown(),
    execute: async (tool, input, signal) => {
      if (tool === "scotty_hatch") {
        const result = await hatch.run(input, signal);
        const state =
          result.hatch.status === "configured" ? result.hatch.observedStatus : "not_configured";
        return {
          text: [
            `Hatch ${result.operation}: ${state}.`,
            `Local process: ${result.process.status}.`,
            ...(result.reference === undefined ? [] : [result.reference]),
          ].join("\n"),
          success: true,
        };
      }
      const result = await runScottyBrowserTest(input, signal);
      return {
        text: renderBrowserEvidenceResult(result),
        success: result.status === "succeeded",
      };
    },
  };
}

export { HatchFailure, renderHatchFailure };
