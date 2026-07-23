import { shellQuote } from "./sandbox-runtime";

export const AGENT_TAB_ID = "tab-1";
export const SHEPPARD_SOCKET = "/tmp/scotty-sheppard.sock";
export const SHEPPARD_STATE_DIRECTORY = "/root/.local/state/scotty";
export const SHEPPARD_STATE = `${SHEPPARD_STATE_DIRECTORY}/sheppard.json`;

const sheppardEnvironment = `SHEPPARD_SOCKET=${shellQuote(SHEPPARD_SOCKET)} SHEPPARD_STATE_PATH=${shellQuote(SHEPPARD_STATE)}`;

export function resetAgentRuntimeCommand(): string {
  const files = [
    SHEPPARD_SOCKET,
    `${SHEPPARD_SOCKET}.start.lock`,
    SHEPPARD_STATE,
    `${SHEPPARD_STATE}.previous`,
    `${SHEPPARD_STATE}.lock`,
  ]
    .map(shellQuote)
    .join(" ");
  return `install -d -m 700 ${shellQuote(SHEPPARD_STATE_DIRECTORY)}; if [ -e ${shellQuote(SHEPPARD_SOCKET)} ] || [ -L ${shellQuote(SHEPPARD_SOCKET)} ]; then ${sheppardEnvironment} sheppard kill; fi; rm -f ${files}`;
}

export function launchAgentRuntimeCommand(root: string, command: string): string {
  return `${sheppardEnvironment} sheppard spawn --cwd ${shellQuote(root)} --title agent --cmd ${shellQuote(command)} --json`;
}

export function pauseAgentCommand(): string {
  return `${sheppardEnvironment} sheppard pause --tab ${shellQuote(AGENT_TAB_ID)}`;
}

export function resumeAgentCommand(): string {
  return `${sheppardEnvironment} sheppard resume --tab ${shellQuote(AGENT_TAB_ID)}`;
}
