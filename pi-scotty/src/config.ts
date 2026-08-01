import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiScottyError } from "./errors.ts";
import { decodeConfigJson, type PiScottyConfig } from "./schemas.ts";

export const defaultStateDirectory = (): string => {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "pi-scotty");
};

export const defaultConfigPath = (): string => {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "pi-scotty", "config.json");
};

export const normalizeOrigin = (input: string): string => {
  if (!URL.canParse(input))
    throw new PiScottyError("input_invalid", "Origin must be a valid absolute URL");
  const url = new URL(input);
  const localHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp)
    throw new PiScottyError("input_invalid", "Origin must use HTTPS (or localhost HTTP)");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new PiScottyError(
      "input_invalid",
      "Origin must not contain credentials, a path, or query",
    );
  return url.origin;
};

export const loadConfig = async (path = defaultConfigPath()): Promise<PiScottyConfig> => {
  const metadata = await stat(path);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    throw new PiScottyError(
      "config_permissions",
      `Paired-client config must be mode 0600: ${path}`,
    );
  const decoded = decodeConfigJson(await readFile(path, "utf8"));
  if (decoded === undefined || normalizeOrigin(decoded.origin) !== decoded.origin)
    throw new PiScottyError("config_invalid", `Paired-client config is invalid: ${path}`);
  return decoded;
};

export const saveConfig = async (
  config: PiScottyConfig,
  path = defaultConfigPath(),
): Promise<void> => {
  const normalized: PiScottyConfig = {
    version: 1,
    origin: normalizeOrigin(config.origin),
    credential: config.credential,
  };
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(normalized)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
};
