import {
  ScottyHatchManager,
  ScottyHatchParameters,
} from "../../../container/pi-packages/sources/scotty-hatch/index";
import { Schema } from "effect";
import {
  BrowserEvidenceJobParameters,
  runScottyBrowserTest,
} from "../../../container/pi-packages/sources/scotty-browser-test/index";

// Native app-server 0.153.4 accepts these only at thread/start. The source
// schemas are the same ones used by the Pi extensions and execution boundary.
export const codexFirstPartyToolSpecs = [
  {
    type: "function" as const,
    name: "scotty_hatch",
    description:
      "Ensure, inspect, or close the current session's application Hatch. Ensure without service fields reads reviewed repository-root hatch.toml; if absent, do not retry. Use complete inline configuration only as a manual override. Include the exact returned scotty-hatch reference once in the next meaningful update; never publish ports, paths, argv, authority values, or URLs.",
    inputSchema: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
      JSON.stringify(ScottyHatchParameters),
    ),
  },
  {
    type: "function" as const,
    name: "scotty_browser_test",
    description:
      "Run one bounded browser evidence job against an app port in this warm Scotty session. Use relative paths and declarative assertions. For user-visible changes, use the same flow before and after; enable video for the after run. Include the exact returned scotty-evidence reference once in the next meaningful update; never publish the authenticated summary URL.",
    inputSchema: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
      JSON.stringify(BrowserEvidenceJobParameters),
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
        text: [
          `Browser evidence: ${result.status}.`,
          `Completed steps: ${result.completedSteps}. Frames: ${result.frameCount}.`,
          `Video: ${result.video ? "recorded" : "not requested"}.`,
          ...(result.failure === undefined
            ? []
            : [
                `Failure: ${result.failure.code}${result.failure.step === undefined ? "" : ` at step ${result.failure.step + 1}`}.`,
              ]),
          `scotty-evidence:${result.jobId}`,
        ].join("\n"),
        success: result.status === "succeeded",
      };
    },
  };
}
