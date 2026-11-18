declare const process: { env: Record<string, string | undefined> };
export const processEnv: (name: string) => string = (name) => process.env[name] ?? "";
