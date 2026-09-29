import type { Effect } from "effect";
import { processEnv } from "../runtime.js";
import type { Config, Runner } from "../runner.js";
import { codexHome } from "./codex/config.js";
import { CodexRunner } from "./codex/runner.js";
import { ClaudeRunner } from "./claude/runner.js";

// Where an agent keeps what Scotty installs and saves. Nothing outside agents/ names these.
export interface AgentFiles {
  // The agent's config folder. Its saved state is relative to it.
  readonly home: string;
  // Scotty's and the owner's instructions, as a file name in home.
  readonly instructions: string;
  // The folder the agent loads skills from.
  readonly skills: string;
  // The session's state file: `find <dir> -name <name>` run in home.
  readonly state: (session: string) => { readonly dir: string; readonly name: string };
}

export interface Agent {
  readonly kind: Config["kind"];
  readonly files: AgentFiles;
  runner(cwd: string): Effect.Effect<Runner>;
}

const home = () => processEnv("HOME") || "/home/scotty";

// The only switch on the agent's kind.
export const makeAgent = (config: Config): Agent => {
  switch (config.kind) {
    case "codex":
      return {
        kind: config.kind,
        files: {
          home: codexHome(),
          instructions: "AGENTS.md",
          skills: `${home()}/.agents/skills`,
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
          // Claude names a project folder after its cwd: /workspace/repo.
          state: (session) => ({ dir: "projects/-workspace-repo", name: `${session}.jsonl` }),
        },
        runner: (cwd) => ClaudeRunner.make(config, cwd),
      };
  }
};
