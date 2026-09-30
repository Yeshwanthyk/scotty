import type { Session } from "./core";

// One status per session, in the order the sidebar should draw attention to them.
export type Status = "starting" | "working" | "unseen" | "idle" | "stopped" | "failed";

const seenKey = "scotty.seen";
const readSeen = (): Record<string, number> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(seenKey) ?? "{}");
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
};

// Turns the owner has seen per session; a finished turn beyond it is "unseen".
export function markSeen(session: Session) {
  const seen = readSeen();
  if (seen[session.identity.id] === session.progress.turns) return;
  try {
    localStorage.setItem(
      seenKey,
      JSON.stringify({ ...seen, [session.identity.id]: session.progress.turns }),
    );
  } catch {
    // Private windows can refuse storage; unseen then stays off.
  }
}

export function statusOf(session: Session, current = false): Status {
  const authority = session.authority;
  if (authority.kind === "transitioning") return "starting";
  if (authority.lifecycle === "failed") return "failed";
  if (session.progress.working) return "working";
  if (authority.lifecycle === "stopped") return "stopped";
  const seen = readSeen()[session.identity.id];
  if (!current && seen !== undefined && session.progress.turns > seen) return "unseen";
  return "idle";
}

export const statusLabel: Record<Status, string> = {
  starting: "Starting",
  working: "Working",
  unseen: "New reply",
  idle: "Ready",
  stopped: "Stopped",
  failed: "Failed",
};

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const groups = ["Today", "This week", "Older"] as const;
export function groupOf(iso: string, now = new Date()): (typeof groups)[number] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = Date.parse(iso);
  if (at >= start) return "Today";
  if (at >= start - 6 * 86_400_000) return "This week";
  return "Older";
}

// A session asleep (stopped) for over a week moves out of the way, still searchable.
const archiveAfter = 7 * 86_400_000;
export function archived(session: Session, now = Date.now()): boolean {
  return (
    session.authority.kind === "stable" &&
    session.authority.lifecycle === "stopped" &&
    now - Date.parse(session.display.activeAt) > archiveAfter
  );
}

export type Filter = "all" | "running";
// Running is a live container: starting up or up. Stopped and failed sessions are not.
export function matchesFilter(session: Session, filter: Filter): boolean {
  if (filter === "all") return true;
  return session.authority.kind === "transitioning" || session.authority.lifecycle === "running";
}

// Case-insensitive substring over the same fields the server searches.
export function matchesText(session: Session, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  const { title, repository, branch, prompt } = session.display;
  return [title, repository, branch, prompt].some((field) => field.toLowerCase().includes(needle));
}

export function grouped(list: ReadonlyArray<Session>) {
  const buckets = new Map<string, Session[]>();
  // Most recently active first: a session with a fresh answer rises to the top.
  const recent = [...list].sort(
    (a, b) => Date.parse(b.display.activeAt) - Date.parse(a.display.activeAt),
  );
  for (const session of recent) {
    const group = groupOf(session.display.activeAt);
    buckets.set(group, [...(buckets.get(group) ?? []), session]);
  }
  return groups.flatMap((group) => {
    const sessions = buckets.get(group);
    return sessions === undefined ? [] : [{ group, sessions }];
  });
}
