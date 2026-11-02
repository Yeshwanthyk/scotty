import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ratesDated } from "../../../src/places/place";
import { message } from "../data/core";
import { stats as loadStats, type RepoStats, type Stats, type StatsWindow } from "../data/stats";
import { ago } from "../data/status";
import { Icon, Spinner } from "./Icon";
import { SidebarButton } from "./Layout";

const windows: { id: StatsWindow; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

// Container hours per repository, read from each session's event log when the page opens or
// Refresh is pressed; nothing polls.
export function StatsPage() {
  const [range, setRange] = useState<StatsWindow>("7d");
  const [data, setData] = useState<Stats>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setError("");
      try {
        setData(await loadStats(range, signal));
      } catch (failure) {
        if (!signal?.aborted) setError(message(failure, "Could not load stats"));
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [range],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const shown = data?.window === range ? data : undefined;
  return (
    <>
      <header className="header">
        <SidebarButton />
        <Link to="/sessions" className="icon-button pressable mobile-only" aria-label="Back">
          <Icon name="chevronLeft" />
        </Link>
        <div className="header-title">
          <h1>Stats</h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-button pressable"
            aria-label="Refresh"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? <Spinner size={13} /> : <Icon name="refresh" />}
          </button>
        </div>
      </header>
      <div className="stats" data-scroll>
        <div className="stats-bar">
          <WindowSwitch value={range} onChange={setRange} />
          {shown ? (
            <span className="quiet stats-asof">
              As of {new Date(shown.now).toLocaleTimeString(undefined, { timeStyle: "short" })}
            </span>
          ) : null}
        </div>
        {error ? (
          <p className="notice" data-tone="error" role="alert">
            <Icon name="alert" size={13} />
            {error}
          </p>
        ) : null}
        {shown === undefined ? (
          error ? null : (
            <div className="settings-card stats-loading" aria-busy="true" />
          )
        ) : shown.repos.length === 0 ? (
          <div className="settings-card">
            <div className="settings-empty">No session ran in this window.</div>
          </div>
        ) : (
          <>
            <Tiles total={shown.total} />
            <Table stats={shown} />
            <Rows stats={shown} />
          </>
        )}
        <p className="settings-intro stats-note">
          Hours run from start to stop, boot included. Est. cost assumes busy CPU and no included
          usage, so it is an upper bound. Rates dated {ratesDated}.
        </p>
      </div>
    </>
  );
}

function WindowSwitch({
  value,
  onChange,
}: {
  value: StatsWindow;
  onChange: (value: StatsWindow) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label="Time window">
      {windows.map((item) => (
        <button
          type="button"
          key={item.id}
          className="segmented-option pressable"
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const hours = (ms: number): string =>
  ms === 0
    ? "0"
    : ms < 3_600_000
      ? `${Math.max(1, Math.round(ms / 60_000))}m`
      : `${(ms / 3_600_000).toFixed(1)}h`;
const usd = (cost: number): string =>
  cost === 0 ? "$0" : cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
const counted = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;
const seconds = (ms: number | null): string =>
  ms === null ? "–" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
const top = (counts: RepoStats["failureCodes"], label = (key: string) => key): string =>
  counts
    .slice(0, 2)
    .map((item) => `${label(item.key)} ×${item.count}`)
    .join(", ");
const lastRun = (row: RepoStats, now: number) =>
  row.lastRun === null ? "–" : ago(new Date(row.lastRun).toISOString(), now);
const timeoutsOf = (row: RepoStats) => row.timeouts.reduce((sum, item) => sum + item.count, 0);
// Failed starts, crashes, invariant violations and timeouts, counted together.
const problems = (row: RepoStats): number =>
  row.failed + row.crashes + row.violations + timeoutsOf(row);
// The top kinds of each problem, in that order.
const kinds = (row: RepoStats): string =>
  [
    top(row.failureCodes),
    top(row.exitCodes, (key) => `exit ${key}`),
    row.violations > 0 ? `${row.violations} invariant` : "",
    row.timeouts.length > 0 ? top(row.timeouts, (key) => `${key} timeout`) : "",
  ]
    .filter((part) => part !== "")
    .join(", ");
const agents = (row: RepoStats): string =>
  [
    row.agents.codex.sessions > 0
      ? `Codex ${row.agents.codex.sessions} · ${hours(row.agents.codex.runMs)}`
      : "",
    row.agents.claude.sessions > 0
      ? `Claude ${row.agents.claude.sessions} · ${hours(row.agents.claude.runMs)}`
      : "",
  ]
    .filter((part) => part !== "")
    .join(" / ");

function Tile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "zero" | "danger";
}) {
  return (
    <div className="stats-tile" data-tone={tone}>
      <dt>{label}</dt>
      <dd className="stats-tile-value tabular">{value}</dd>
      {detail ? <dd className="stats-detail">{detail}</dd> : null}
    </div>
  );
}

// The window's totals, above the table on a desktop and the rows on a phone.
function Tiles({ total }: { total: RepoStats }) {
  const count = problems(total);
  return (
    <dl className="stats-tiles">
      <Tile label="Hours" value={hours(total.runMs)} />
      <Tile label="Est. cost" value={usd(total.cost)} detail="upper bound" />
      <Tile
        label="Sessions"
        value={String(total.sessions)}
        detail={counted(total.turns, "turn", "turns")}
      />
      <Tile
        label="Problems"
        value={String(count)}
        detail={kinds(total)}
        tone={count > 0 ? "danger" : "zero"}
      />
    </dl>
  );
}

function Running({ count, label = "" }: { count: number; label?: string }) {
  return count > 0 ? (
    <span className="stats-running">
      <span className="stats-live" />
      <span className="tabular">
        {count}
        {label}
      </span>
    </span>
  ) : (
    <span className="quiet tabular">0</span>
  );
}

// The count and its kinds on one line; the kinds are cut to fit, in full in the tooltip.
function Problems({ row }: { row: RepoStats }) {
  const count = problems(row);
  const detail = kinds(row);
  return count === 0 ? (
    <span className="quiet tabular">0</span>
  ) : (
    <span className="stats-problems" title={detail || undefined}>
      <span className="tabular">{count}</span>
      {detail ? <span className="stats-problems-kinds">{detail}</span> : null}
    </span>
  );
}

function Row({ row, now }: { row: RepoStats; now: number }) {
  const split = agents(row);
  return (
    <tr>
      <th scope="row" className="stats-repo">
        <span className="mono">{row.repo}</span>
        {split ? <div className="stats-detail">{split}</div> : null}
      </th>
      <td className="tabular">{hours(row.runMs)}</td>
      <td className="tabular">{usd(row.cost)}</td>
      <td className="tabular">
        {row.sessions}
        <div className="stats-detail">{counted(row.turns, "turn", "turns")}</div>
      </td>
      <td>
        <Running count={row.running} />
      </td>
      <td className="tabular">{lastRun(row, now)}</td>
      <td className="tabular">{seconds(row.bootMs)}</td>
      <td>
        <Problems row={row} />
      </td>
    </tr>
  );
}

function Table({ stats }: { stats: Stats }) {
  return (
    <div className="stats-table desktop-only">
      <table>
        <thead>
          <tr>
            <th scope="col">Repository</th>
            <th scope="col">Hours</th>
            <th scope="col" title="The counted hours at busy CPU, without included usage">
              Est. cost
            </th>
            <th scope="col">Sessions</th>
            <th scope="col">Running</th>
            <th scope="col">Last run</th>
            <th scope="col" title="Median time to a ready workspace">
              Boot
            </th>
            <th scope="col">Problems</th>
          </tr>
        </thead>
        <tbody>
          {stats.repos.map((row) => (
            <Row key={row.repo} row={row} now={stats.now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// On a phone, one row per repository under the tiles; the tiles carry the totals.
function Rows({ stats }: { stats: Stats }) {
  return (
    <div className="stats-rows">
      {stats.repos.map((row) => (
        <div key={row.repo} className="stats-row">
          <div className="stats-row-head">
            <span className="stats-row-repo mono">{row.repo}</span>
            <span className="stats-row-hours tabular">{hours(row.runMs)}</span>
          </div>
          <div className="stats-row-meta tabular">
            {usd(row.cost)} · {counted(row.sessions, "session", "sessions")} · last{" "}
            {lastRun(row, stats.now)}
            {row.running > 0 ? (
              <>
                {" · "}
                <Running count={row.running} label=" running" />
              </>
            ) : null}
          </div>
          {problems(row) > 0 ? <div className="stats-row-problems">{kinds(row)}</div> : null}
        </div>
      ))}
    </div>
  );
}
