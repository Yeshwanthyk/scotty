export const PI_SENTINEL_PREFIX: "scotty-pi-";
export const GITHUB_SENTINEL_PREFIX: "scotty-github-";
export const ENVIRONMENT_SENTINEL_PREFIX: "scotty-env-";
export const PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER: "x-scotty-internal-passive-no-heartbeat";
export const CREDENTIAL_SENTINEL_PREFIXES: readonly ["scotty-pi-", "scotty-github-", "scotty-env-"];
export const redactCredentialSentinels: (value: string) => string;
export const canonicalJson: (value: unknown) => string;
export const commandIntentDigest: (intent: unknown) => Promise<string>;
