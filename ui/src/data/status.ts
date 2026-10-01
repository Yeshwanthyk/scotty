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
      return "Stopped by you";
    case "ended":
      return "Ended by an automation";
    case "stalled":
      return "Stopped — no output";
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

// A short word for the phone header, where the full label doesn't fit.
export function stopWord(stop: { reason: string } | null | undefined): string {
  switch (stop?.reason) {
    case "crashed":
      return "Crashed";
    case "stalled":
      return "Stalled";
    default:
      return "Stopped";
  }
}

// The same, as a sentence for the thread.
export function stopSentence(stop: { reason: string; exitCode?: number } | null | undefined) {
  switch (stop?.reason) {
    case "user":
      return "You stopped this session.";
    case "ended":
      return "An automation ended this session.";
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

// Why a session failed to start, in plain words; the raw code stays in a tooltip.
export function failureSentence(code: string | undefined): string {
  switch (code) {
    case "container_start":
    case "container_timeout":
      return "The container didn't start.";
    case "workspace":
    case "workspace_timeout":
      return "The workspace couldn't be prepared.";
    case "signin_required":
      return "The agent needs you to sign in again in Settings.";
    case "start":
    case "start_failed":
    case "dial_timeout":
    case "redial_timeout":
      return "The agent didn't start.";
    case "protocol":
      return "The agent sent something Scotty couldn't read.";
    default:
      return "This session failed to start.";
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

const groups = ["Today", "This week", "Older"] as const;
// Calendar days in local time, so a day that is 23 or 25 hours long still counts as one.
export function groupOf(iso: string, now = new Date()): (typeof groups)[number] {
  const at = new Date(iso).getTime();
  if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) return "Today";
  if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime())
    return "This week";
  return "Older";
}

// A session asleep (stopped) for over a week moves out of the way, still searchable.
// The week counts from when it went to sleep, not from its last activity.
export function archived(session: Session, now = new Date()): boolean {
  const { authority, display } = session;
  if (authority.kind !== "stable" || authority.lifecycle !== "stopped") return false;
  if (display.stoppedAt === null) return false;
  return Date.parse(display.stoppedAt) < now.getTime() - 7 * 86_400_000;
}

// Mine: started by a person, in the UI or CLI or through the API with a key. Automations: a hook
// or an automation.
export type Filter = "all" | "mine" | "automations" | "running";
export function matchesFilter(session: Session, filter: Filter): boolean {
  const origin = session.display.origin;
  if (filter === "mine") return origin === null || origin.kind === "api";
  if (filter === "automations") return origin !== null && origin.kind !== "api";
  if (filter === "running")
    return session.authority.kind === "transitioning" || session.authority.lifecycle === "running";
  return true;
}

// Case-insensitive substring over what the list already holds; the server adds the whole prompt.
export function matchesText(session: Session, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  const { title, repository, branch, prompt, origin } = session.display;
  const fields = [
    title,
    repository,
    branch,
    prompt,
    origin !== null && "key" in origin ? (origin.key ?? "") : "",
    origin?.kind === "hook" ? origin.connection : "",
    origin?.kind === "automation" ? origin.automation : "",
  ];
  return fields.some((field) => field.toLowerCase().includes(needle));
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
