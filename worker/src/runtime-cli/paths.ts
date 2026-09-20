import { sessionRoot } from "../sandbox/workspace";

export const runtimeCliBin = (sessionId: string): string =>
  `${sessionRoot(sessionId)}/.scotty/runtime-cli/bin`;
export const runtimeCliExecutable = (sessionId: string): string =>
  `${runtimeCliBin(sessionId)}/scotty`;
export const runtimeCliPath = (sessionId: string, tools: ReadonlyArray<string> = []): string =>
  [runtimeCliBin(sessionId), ...tools, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
