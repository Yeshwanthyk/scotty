import { homedir } from "node:os";
import { join } from "node:path";
import { TuiError } from "./errors.ts";

export const defaultStateDirectory = (): string => {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "scotty", "tui");
};

export const normalizeOrigin = (input: string): string => {
  if (!URL.canParse(input))
    throw new TuiError("input_invalid", "Origin must be a valid absolute URL");
  const url = new URL(input);
  const localHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp)
    throw new TuiError("input_invalid", "Origin must use HTTPS (or localhost HTTP)");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new TuiError("input_invalid", "Origin must not contain credentials, a path, or query");
  return url.origin;
};
