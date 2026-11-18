import type { Effect } from "effect";
import { processEnv } from "../runtime.js";
import type { Config, Runner } from "../runner.js";
import { codexHome } from "./codex/config.js";
import { CodexRunner } from "./codex/runner.js";
import { ClaudeRunner } from "./claude/runner.js";

interface AgentFiles {
  readonly home: string;
  readonly instructions: string;
  readonly skills: string;
  readonly styles: string | undefined;
  readonly state: (session: string) => { readonly dir: string; readonly name: string };
}

export interface Agent {
  readonly kind: Config["kind"];
  readonly files: AgentFiles;
  runner(cwd: string): Effect.Effect<Runner>;
}

const home = () => processEnv("HOME") || "/home/scotty";

export const makeAgent: (config: Config) => Agent = (config) => {
  switch (config.kind) {
    case "codex":
      return {
        kind: config.kind,
        files: {
          home: codexHome(),
          instructions: "AGENTS.md",
          skills: `${home()}/.agents/skills`,
          styles: undefined,
          state: (session) => ({ dir: "sessions", name: `rollout-*${session}*.jsonl` }),
        },
        runner: (cwd) => CodexRunner.make(config, cwd),
      };
    case "claude":
      return {
        kind: config.kind,
        files: {
          home: `${home()}/.claude`,
          instructions: "CLAUDE.md",
          skills: `${home()}/.claude/skills`,
          styles: `${home()}/.claude/output-styles`,
          state: (session) => ({ dir: "projects/-workspace-repo", name: `${session}.jsonl` }),
        },
        runner: (cwd) => ClaudeRunner.make(config, cwd),
      };
  }
};
