// The supervisor is compiled for Bun. The root TypeScript project does not
// depend on Bun's ambient type package.
declare const process: {
  env: Record<string, string | undefined>;
  on(signal: "SIGTERM", listener: () => void): void;
  exit(code: number): never;
};
export const processEnv = (name: string): string => process.env[name] ?? "";
// Reads a variable and removes it, so no process the supervisor starts inherits it.
export const takeEnv = (name: string): string => {
  const value = processEnv(name);
  delete process.env[name];
  return value;
};
export const onTerminate = (listener: () => void): void => process.on("SIGTERM", listener);
export const exit = (code: number): never => process.exit(code);
// A tmpfs where a place keeps a machine's disk, so the token-bearing files written on every start
// never rest on a paused disk.
export const runDir = "/run/scotty";
