import { Schema } from "effect";
import { hourlyRate, Size } from "../places/place.js";
import type { AgentKind, SessionEvent } from "./events.js";
import { fold, initial, type State } from "./fold.js";
import { live } from "./state.js";

// One container run: from the event that began its generation to the one that ended it, or
// still open. A run counts from the start intent, so it includes the container's boot. Its size
// is the fold's when the run begins: a running container never changes size.
export type Run = {
  readonly gen: number;
  readonly size: typeof Size.Type;
  readonly start: number;
  readonly end: number | null;
};

// What one session's log says, read by replaying the fold; every time is an event's `at`.
export type SessionStats = {
  readonly repo: string;
  readonly agentKind: typeof AgentKind.Type;
  readonly live: boolean;
  readonly runs: readonly Run[];
  // When each turn ended, completed or cut off by a stop.
  readonly turns: readonly number[];
  readonly failures: readonly { readonly at: number; readonly code: string }[];
  readonly crashes: readonly { readonly at: number; readonly exitCode: number | null }[];
  readonly boots: readonly { readonly at: number; readonly ms: number }[];
  readonly violations: readonly number[];
  readonly timeouts: readonly { readonly at: number; readonly op: string }[];
};

// Scheduled checks that fire in a healthy session; they say nothing went wrong.
const routine = new Set(["idle", "watch", "redial"]);
// Request timeouts are named per request (`req:<id>`); they are one kind.
const timeoutKind = (op: string): string => (op.startsWith("req:") ? "request" : op);

// Null for a log without `created`, which a delete that stopped partway leaves.
export function sessionStats(events: readonly SessionEvent[]): SessionStats | null {
  let state: State = initial;
  const runs: Run[] = [];
  const turns: number[] = [];
  const failures: { at: number; code: string }[] = [];
  const crashes: { at: number; exitCode: number | null }[] = [];
  const boots: { at: number; ms: number }[] = [];
  const violations: number[] = [];
  const timeouts: { at: number; op: string }[] = [];
  for (const event of events) {
    const before = state;
    state = fold(before, event);
    const gen = state.gen;
    if (state.startSeq === event.seq && before.startSeq !== event.seq && gen !== undefined)
      runs.push({ gen, size: state.size, start: event.at, end: null });
    const open = runs.at(-1);
    if (live(before) && !live(state) && open !== undefined && open.end === null) {
      runs[runs.length - 1] = { ...open, end: event.at };
      if (state.phase === "failed" && state.failure !== undefined)
        failures.push({ at: event.at, code: state.failure.code });
      if (state.stop?.reason === "crashed")
        crashes.push({ at: event.at, exitCode: state.stop.exitCode ?? null });
    }
    for (let turn = before.turns.length; turn < state.turns.length; turn++) turns.push(event.at);
    if (event.kind === "workspace.ready" && state.readySeq === event.seq && event.ms !== undefined)
      boots.push({ at: event.at, ms: event.ms });
    if (event.kind === "invariant.violated") violations.push(event.at);
    // Only a timeout the fold acted on: one whose deadline was pending and due.
    if (
      event.kind === "timeout" &&
      !routine.has(event.op) &&
      before.pending.some((item) => item.op === event.op && item.due <= event.at)
    )
      timeouts.push({ at: event.at, op: timeoutKind(event.op) });
  }
  const created = state.created;
  if (created === undefined) return null;
  return {
    repo: created.repo,
    agentKind: created.agentKind,
    live: runs.at(-1)?.end === null,
    runs,
    turns,
    failures,
    crashes,
    boots,
    violations,
    timeouts,
  };
}

export const StatsWindow = Schema.Literals(["7d", "30d", "all"]);
export type StatsWindow = typeof StatsWindow.Type;
const windowMs: Record<StatsWindow, number> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: Number.POSITIVE_INFINITY,
};

const Count = Schema.Struct({ key: Schema.String, count: Schema.Number });
const AgentShare = Schema.Struct({ sessions: Schema.Number, runMs: Schema.Number });
// Estimated USD: hours × the size's `hourlyRate`, an upper bound.
const SizeShare = Schema.Struct({ size: Size, runMs: Schema.Number, cost: Schema.Number });
export const RepoStats = Schema.Struct({
  repo: Schema.String,
  sessions: Schema.Number,
  runMs: Schema.Number,
  turns: Schema.Number,
  lastRun: Schema.NullOr(Schema.Number),
  failed: Schema.Number,
  failureCodes: Schema.Array(Count),
  crashes: Schema.Number,
  exitCodes: Schema.Array(Count),
  bootMs: Schema.NullOr(Schema.Number),
  violations: Schema.Number,
  timeouts: Schema.Array(Count),
  running: Schema.Number,
  agents: Schema.Struct({ codex: AgentShare, claude: AgentShare }),
  // The sizes that ran in the window, in `Size` order; their `runMs` sum to the repo's.
  sizes: Schema.Array(SizeShare),
  cost: Schema.Number,
});
export type RepoStats = typeof RepoStats.Type;
export const Stats = Schema.Struct({
  window: StatsWindow,
  now: Schema.Number,
  repos: Schema.Array(RepoStats),
  total: RepoStats,
});
export type Stats = typeof Stats.Type;

const counted = (keys: readonly string[]): { key: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
};
const median = (values: readonly number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle];
  if (high === undefined) return null;
  const low = sorted[middle - 1];
  return sorted.length % 2 === 1 || low === undefined ? high : (low + high) / 2;
};

// The sessions with a run in [from, now], summed; hours are clipped to that span.
function summarize(
  repo: string,
  sessions: readonly SessionStats[],
  from: number,
  now: number,
): RepoStats {
  const inWindow = (at: number) => at >= from && at <= now;
  const clipped = (run: Run) =>
    Math.max(0, Math.min(run.end ?? now, now) - Math.max(run.start, from));
  const shown = sessions.filter((session) =>
    session.runs.some((run) => run.start <= now && (run.end ?? now) >= from),
  );
  const runMs = (list: readonly SessionStats[]) =>
    list.reduce((sum, session) => sum + session.runs.reduce((ms, run) => ms + clipped(run), 0), 0);
  const share = (kind: typeof AgentKind.Type) => {
    const of = shown.filter((session) => session.agentKind === kind);
    return { sessions: of.length, runMs: runMs(of) };
  };
  const failures = shown.flatMap((session) => session.failures.filter((f) => inWindow(f.at)));
  const crashes = shown.flatMap((session) => session.crashes.filter((c) => inWindow(c.at)));
  const starts = shown.flatMap((session) => session.runs.map((run) => run.start));
  const runs = shown.flatMap((session) => session.runs);
  const sizes = Size.literals
    .map((size) => {
      const ms = runs.reduce((sum, run) => sum + (run.size === size ? clipped(run) : 0), 0);
      return { size, runMs: ms, cost: (ms / 3_600_000) * hourlyRate(size) };
    })
    .filter((share) => share.runMs > 0);
  return {
    repo,
    sessions: shown.length,
    runMs: runMs(shown),
    turns: shown.reduce((sum, session) => sum + session.turns.filter(inWindow).length, 0),
    lastRun: starts.length === 0 ? null : Math.max(...starts),
    failed: shown.filter((session) => session.failures.some((f) => inWindow(f.at))).length,
    failureCodes: counted(failures.map((failure) => failure.code)),
    crashes: crashes.length,
    exitCodes: counted(crashes.map((crash) => String(crash.exitCode ?? "unknown"))),
    bootMs: median(
      shown.flatMap((session) => session.boots.filter((b) => inWindow(b.at)).map((b) => b.ms)),
    ),
    violations: shown.reduce((sum, session) => sum + session.violations.filter(inWindow).length, 0),
    timeouts: counted(
      shown.flatMap((session) => session.timeouts.filter((t) => inWindow(t.at)).map((t) => t.op)),
    ),
    running: shown.filter((session) => session.live).length,
    agents: { codex: share("codex"), claude: share("claude") },
    sizes,
    cost: sizes.reduce((sum, share) => sum + share.cost, 0),
  };
}

// Per repository and in total over the window ending at `now`; busiest repositories first.
export function repoStats(
  sessions: readonly SessionStats[],
  window: StatsWindow,
  now: number,
): Stats {
  const from = now - windowMs[window];
  const byRepo = new Map<string, SessionStats[]>();
  for (const session of sessions)
    byRepo.set(session.repo, [...(byRepo.get(session.repo) ?? []), session]);
  const repos = [...byRepo]
    .map(([repo, list]) => summarize(repo, list, from, now))
    .filter((repo) => repo.sessions > 0)
    .sort((a, b) => b.runMs - a.runMs || a.repo.localeCompare(b.repo));
  return { window, now, repos, total: summarize("All repositories", sessions, from, now) };
}
