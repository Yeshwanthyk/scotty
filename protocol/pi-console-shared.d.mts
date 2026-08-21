export const ENVIRONMENT_SENTINEL_PREFIX: "scotty-env-";
export const PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER: "x-scotty-internal-passive-no-heartbeat";
export const CREDENTIAL_SENTINEL_PREFIXES: readonly ["scotty-env-"];
export const redactCredentialSentinels: (value: string) => string;
export const canonicalJson: (value: unknown) => string;
export const commandIntentDigest: (intent: unknown) => Promise<string>;
