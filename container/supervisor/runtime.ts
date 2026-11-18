declare const process: {
  env: Record<string, string | undefined>;
  on(signal: "SIGTERM", listener: () => void): void;
  exit(code: number): never;
};
export const processEnv: (name: string) => string = (name) => process.env[name] ?? "";
export const takeEnv: (name: string) => string = (name) => {
  const value = processEnv(name);
  delete process.env[name];
  return value;
};
export const onTerminate: (listener: () => void) => void = (listener) =>
  process.on("SIGTERM", listener);
export const exit = (code: number): never => process.exit(code);
export const runDir = "/run/scotty";
