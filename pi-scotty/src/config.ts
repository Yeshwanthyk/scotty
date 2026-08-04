import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
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

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const configAccessError = (path: string, error: unknown): PiScottyError =>
  errorCode(error) === "ENOENT"
    ? new PiScottyError(
        "config_missing",
        `No paired-client config found at ${path}. Pair this device with: pi-scotty pair <origin>`,
      )
    : new PiScottyError("config_invalid", `Paired-client config could not be read: ${path}`);

const readPrivateConfig = async (path: string): Promise<string> => {
  const pathMetadata = await lstat(path).catch((error: unknown) => {
    throw configAccessError(path, error);
  });
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    (process.platform !== "win32" &&
      ((pathMetadata.mode & 0o077) !== 0 ||
        (typeof process.geteuid === "function" && pathMetadata.uid !== process.geteuid())))
  )
    throw new PiScottyError(
      "config_permissions",
      `Paired-client config must be a non-symlinked mode-0600 file: ${path}`,
    );
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const file = await open(path, flags).catch((error: unknown) => {
    throw configAccessError(path, error);
  });
  try {
    const openedMetadata = await file.stat();
    if (
      !openedMetadata.isFile() ||
      (process.platform !== "win32" &&
        ((openedMetadata.mode & 0o077) !== 0 ||
          (typeof process.geteuid === "function" && openedMetadata.uid !== process.geteuid()) ||
          openedMetadata.dev !== pathMetadata.dev ||
          openedMetadata.ino !== pathMetadata.ino))
    )
      throw new PiScottyError(
        "config_permissions",
        `Paired-client config must be a non-symlinked mode-0600 file: ${path}`,
      );
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
};

export const loadConfig = async (path = defaultConfigPath()): Promise<PiScottyConfig> => {
  const decoded = decodeConfigJson(await readPrivateConfig(path));
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
