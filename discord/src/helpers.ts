const THREAD_PREFIX = "scotty-";
const SESSION_FRAGMENT_LENGTH = 12;

export function threadName(sessionId: string): string {
  return `${THREAD_PREFIX}${sessionId.slice(0, SESSION_FRAGMENT_LENGTH)}`;
}

export function parseThreadName(name: string): string | undefined {
  const match = /^scotty-([A-Za-z0-9_-]{12})$/.exec(name);
  return match?.[1];
}

export function isConfiguredDiscordLocation(
  guildId: string | null,
  channelId: string | null,
  configuredGuildId: string,
  configuredChannelId: string,
): boolean {
  return guildId === configuredGuildId && channelId === configuredChannelId;
}

export function truncate(text: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  if (limit === 1) {
    return "…";
  }
  return `${text.slice(0, limit - 1)}…`;
}
