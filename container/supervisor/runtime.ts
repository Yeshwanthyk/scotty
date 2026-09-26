// The supervisor is compiled for Bun. The root TypeScript project does not
// depend on Bun's ambient type package.
declare const process: { env: Record<string, string | undefined> };
export const processEnv = (name: string): string => process.env[name] ?? "";
