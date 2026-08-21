const SCOTTY_OWNED_ENVIRONMENT_NAMES = new Set([
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "SCOTTY_SESSION_ID",
  "GIT_CONFIG_GLOBAL",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "GH_PROMPT_DISABLED",
  "GH_NO_UPDATE_NOTIFIER",
  "GIT_TERMINAL_PROMPT",
  "NODE_OPTIONS",
  "GOTOOLCHAIN",
  "GOPROXY",
  "GOSUMDB",
  "TERM",
  "LANG",
  "LC_ALL",
  "HOME",
  "HOSTNAME",
  "PATH",
  "PWD",
  "SHELL",
  "SHLVL",
  "TMPDIR",
  "USER",
  "SCOTTY_PI_SESSION_PORT",
  "SCOTTY_PI_SESSION_TOKEN_FILE",
  "SCOTTY_WORKSPACE",
]);

export const environmentNameIsReserved = (name: string): boolean =>
  name.startsWith("SCOTTY_") || SCOTTY_OWNED_ENVIRONMENT_NAMES.has(name);

export const REQUIRED_GLOBAL_SECRET_NAMES = [
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
] as const;

export type RequiredGlobalSecretName = (typeof REQUIRED_GLOBAL_SECRET_NAMES)[number];

export const requiredGlobalSecretNameIs = (name: string): name is RequiredGlobalSecretName =>
  (REQUIRED_GLOBAL_SECRET_NAMES as ReadonlyArray<string>).includes(name);

export const environmentNameIsMaterializable = (name: string): boolean =>
  requiredGlobalSecretNameIs(name) || !environmentNameIsReserved(name);
