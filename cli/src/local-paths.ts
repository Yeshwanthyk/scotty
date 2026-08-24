import { isAbsolute, join } from "node:path";

export interface LocalPathEnvironment {
  readonly [name: string]: string | undefined;
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_STATE_HOME?: string;
  readonly XDG_CACHE_HOME?: string;
}

const configuredRoot = (value: string | undefined, fallback: string): string =>
  value === undefined || value.trim().length === 0 || !isAbsolute(value) ? fallback : value;

export const scottyConfigRoot = (home: string, env: LocalPathEnvironment): string =>
  join(configuredRoot(env.XDG_CONFIG_HOME, join(home, ".config")), "scotty");

export const scottyStateRoot = (home: string, env: LocalPathEnvironment): string =>
  join(configuredRoot(env.XDG_STATE_HOME, join(home, ".local", "state")), "scotty");

export const scottyCacheRoot = (home: string, env: LocalPathEnvironment): string =>
  join(configuredRoot(env.XDG_CACHE_HOME, join(home, ".cache")), "scotty");

export const scottyConfigPath = (home: string, env: LocalPathEnvironment): string =>
  join(scottyConfigRoot(home, env), "config.json");

export const installationStatePath = (home: string, env: LocalPathEnvironment): string =>
  join(scottyStateRoot(home, env), "installation.json");

export const rootCredentialPath = (home: string, env: LocalPathEnvironment): string =>
  join(credentialDirectoryPath(home, env), "root");

export const credentialDirectoryPath = (home: string, env: LocalPathEnvironment): string =>
  join(scottyStateRoot(home, env), "credentials");

export const clientCredentialPath = (home: string, env: LocalPathEnvironment): string =>
  join(credentialDirectoryPath(home, env), "client");

export type LocalCredentialName = "root" | "client";

export const localCredentialPath = (
  home: string,
  env: LocalPathEnvironment,
  name: LocalCredentialName,
): string => join(credentialDirectoryPath(home, env), name);

export const operationStatePath = (home: string, env: LocalPathEnvironment, name: string): string =>
  join(scottyStateRoot(home, env), "operations", name);

export const stateLockPath = (home: string, env: LocalPathEnvironment, name: string): string =>
  join(scottyStateRoot(home, env), "locks", name);
