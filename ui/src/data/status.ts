import type { Session } from "./core";

// One status per session, in the order the sidebar should draw attention to them. "asleep" is a
// session stopped for being idle: it holds no container but wakes on the next message.
export type Status = "starting" | "working" | "unseen" | "idle" | "asleep" | "stopped" | "failed";

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
  if (authority.lifecycle === "stopped")
    return authority.stop?.reason === "idle" ? "asleep" : "stopped";
  const seen = readSeen()[session.identity.id];
  if (!current && seen !== undefined && session.progress.turns > seen) return "unseen";
  return "idle";
}

export const statusLabel: Record<Status, string> = {
  starting: "Starting",
  working: "Working",
  unseen: "New reply",
  idle: "Ready",
  asleep: "Asleep",
  stopped: "Stopped",
  failed: "Failed",
};

// Neither asleep nor stopped holds a container.
export const dormant = (status: Status | undefined) => status === "asleep" || status === "stopped";

// Why a session stopped, in plain words; unknown reasons from a newer server read as "Stopped".
export function stopLabel(stop: { reason: string; exitCode?: number } | null | undefined): string {
  switch (stop?.reason) {
    case "user":
      return "You stopped it";
    case "idle":
      return "Asleep — idle";
    case "stalled":
      return "Stopped — no output for 30 min";
    case "crashed":
      return stop.exitCode === undefined ? "Crashed" : `Crashed (exit ${stop.exitCode})`;
    case "exited":
      return "Container exited";
    case "agent":
      return "Agent exited";
    case "deploy":
      return "Restarted by a deploy";
    case "gone":
      return "Container lost";
    default:
      return "Stopped";
  }
}

// The same, as a sentence for the thread.
export function stopSentence(stop: { reason: string; exitCode?: number } | null | undefined) {
  switch (stop?.reason) {
    case "user":
      return "You stopped this session.";
    case "stalled":
      return "Stopped after 30 minutes with no output from the agent.";
    case "crashed":
      return stop.exitCode === undefined
        ? "The container crashed."
        : `The container crashed (exit ${stop.exitCode}).`;
    case "exited":
      return "The container exited on its own.";
    case "agent":
      return "The agent exited.";
    case "deploy":
      return "A deploy replaced the container.";
    case "gone":
      return "The container was lost.";
    default:
      return "This session stopped.";
  }
}

// "7m" until an ISO time, never below one minute.
export function until(iso: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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

const groups = ["Today", "Yesterday", "This week", "This month", "Earlier"] as const;
export function groupOf(iso: string, now = new Date()): (typeof groups)[number] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = Date.parse(iso);
  if (at >= start) return "Today";
  if (at >= start - 86_400_000) return "Yesterday";
  if (at >= start - 6 * 86_400_000) return "This week";
  if (at >= start - 30 * 86_400_000) return "This month";
  return "Earlier";
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
