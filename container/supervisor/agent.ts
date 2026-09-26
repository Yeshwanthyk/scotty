import { CodexRunner } from "./codex.js";
import type { Agent } from "./runner.js";

export const makeRunner = (agent: Agent, cwd: string) => {
  switch (agent.kind) {
    case "codex":
      return CodexRunner.make(agent, cwd);
  }
};
