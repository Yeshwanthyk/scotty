import { assert, describe, it } from "vitest";
import {
  AGENT_TAB_ID,
  launchAgentRuntimeCommand,
  pauseAgentCommand,
  resetAgentRuntimeCommand,
  resumeAgentCommand,
  SHEPPARD_SOCKET,
  SHEPPARD_STATE,
  SHEPPARD_STATE_DIRECTORY,
} from "../src/agent-runtime";

describe("agent runtime commands", () => {
  it("keeps persisted Sheppard state outside world-writable tmp", () => {
    assert.strictEqual(SHEPPARD_SOCKET, "/tmp/scotty-sheppard.sock");
    assert.strictEqual(SHEPPARD_STATE_DIRECTORY, "/root/.local/state/scotty");
    assert.strictEqual(SHEPPARD_STATE, "/root/.local/state/scotty/sheppard.json");
    assert.match(resetAgentRuntimeCommand(), /install -d -m 700/);
  });

  it("launches and controls the authoritative managed tab", () => {
    assert.strictEqual(AGENT_TAB_ID, "tab-1");
    assert.match(
      launchAgentRuntimeCommand("/workspace/a", "codex --prompt 'hi'"),
      /sheppard spawn/,
    );
    assert.match(pauseAgentCommand(), /sheppard pause --tab 'tab-1'$/);
    assert.match(resumeAgentCommand(), /sheppard resume --tab 'tab-1'$/);
  });
});
