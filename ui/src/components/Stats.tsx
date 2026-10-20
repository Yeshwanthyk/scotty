import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
            <Table stats={shown} />
            <Cards stats={shown} />
          </>
        )}
        <p className="settings-intro stats-note">
          Read from each session's event log. A run counts from its start, container boot included,
          to its stop; hours are cut to the window. Deleted sessions are not counted. Est. cost is
          an upper bound: it counts a container's whole life as busy CPU and leaves out the plan's
          included usage, at Cloudflare's Containers rates dated {ratesDated}.
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
  const buttons = useRef<Partial<Record<StatsWindow, HTMLButtonElement | null>>>({});
  const [pill, setPill] = useState<{ x: number; width: number }>();
  useLayoutEffect(() => {
    const measure = () => {
      const button = buttons.current[value];
      if (button) setPill({ x: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    void document.fonts.ready.then(measure);
  }, [value]);
  return (
    <div className="agent-switch" role="group" aria-label="Time window">
      {pill ? (
        <span
          className="agent-switch-pill"
          style={{ width: pill.width, transform: `translateX(${pill.x}px)` }}
        />
      ) : null}
      {windows.map((item) => (
        <button
          type="button"
          key={item.id}
          ref={(button) => {
            buttons.current[item.id] = button;
          }}
          className="pressable"
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
// One line per size under a figure, so the Hours and Est. cost lines match up.
const bySize = (row: RepoStats, figure: (share: RepoStats["sizes"][number]) => string) =>
  row.sizes.map((share) => (
    <div key={share.size} className="stats-detail">
      {figure(share)}
    </div>
  ));
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
const health = (row: RepoStats): string =>
  [
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

// A count with its top kinds under it, quiet when there are none.
function Tally({ count, detail }: { count: number; detail: string }) {
  return (
    <div className="stats-tally" data-zero={count === 0 || undefined}>
      <span className="tabular">{count}</span>
      {detail ? <span className="stats-detail">{detail}</span> : null}
    </div>
  );
}

function Running({ count }: { count: number }) {
  return count > 0 ? (
    <span className="stats-running">
      <span className="stats-live" />
      <span className="tabular">{count}</span>
    </span>
  ) : (
    <span className="quiet tabular">0</span>
  );
}

function Row({ row, now, total }: { row: RepoStats; now: number; total?: boolean }) {
  return (
    <tr data-total={total || undefined}>
      <th scope="row" className="stats-repo">
        {total ? row.repo : <span className="mono">{row.repo}</span>}
      </th>
      <td className="tabular">{row.sessions}</td>
      <td className="tabular">
        {hours(row.runMs)}
        {bySize(row, (share) => `${share.size} ${hours(share.runMs)}`)}
      </td>
      <td className="tabular">
        {usd(row.cost)}
        {bySize(row, (share) => usd(share.cost))}
      </td>
      <td className="tabular">{row.turns}</td>
      <td>
        <Running count={row.running} />
      </td>
      <td className="tabular">{lastRun(row, now)}</td>
      <td>
        <Tally count={row.failed} detail={top(row.failureCodes)} />
      </td>
      <td>
        <Tally count={row.crashes} detail={top(row.exitCodes, (key) => `exit ${key}`)} />
      </td>
      <td className="tabular">{seconds(row.bootMs)}</td>
      <td>
        <Tally count={row.violations + timeoutsOf(row)} detail={health(row)} />
      </td>
      <td className="stats-detail">{agents(row) || "–"}</td>
    </tr>
  );
}

function Table({ stats }: { stats: Stats }) {
  return (
    <div className="settings-card stats-table desktop-only">
      <table>
        <thead>
          <tr>
            <th scope="col">Repository</th>
            <th scope="col">Sessions</th>
            <th scope="col">Hours</th>
            <th scope="col" title="An upper bound: the whole run counted as busy">
              Est. cost
            </th>
            <th scope="col">Turns</th>
            <th scope="col">Running</th>
            <th scope="col">Last run</th>
            <th scope="col">Failed</th>
            <th scope="col">Crashes</th>
            <th scope="col" title="Median time to a ready workspace">
              Boot
            </th>
            <th scope="col" title="Invariant violations and timeouts">
              Health
            </th>
            <th scope="col">Agents</th>
          </tr>
        </thead>
        <tbody>
          {stats.repos.map((row) => (
            <Row key={row.repo} row={row} now={stats.now} />
          ))}
        </tbody>
        <tfoot>
          <Row row={stats.total} now={stats.now} total />
        </tfoot>
      </table>
    </div>
  );
}

function Card({ row, now, total }: { row: RepoStats; now: number; total?: boolean }) {
  const failures = top(row.failureCodes);
  const exits = top(row.exitCodes, (key) => `exit ${key}`);
  const signals = health(row);
  const split = agents(row);
  return (
    <div className="settings-card stats-card" data-total={total || undefined}>
      <div className="stats-card-head">
        <span className={total ? "stats-card-title" : "stats-card-title mono"}>{row.repo}</span>
        {row.running > 0 ? <Running count={row.running} /> : null}
      </div>
      <dl className="stats-figures">
        <div>
          <dt>Hours</dt>
          <dd className="tabular">
            {hours(row.runMs)}
            {bySize(row, (share) => `${share.size} ${hours(share.runMs)}`)}
          </dd>
        </div>
        <div>
          <dt>Est. cost</dt>
          <dd className="tabular">
            {usd(row.cost)}
            {bySize(row, (share) => usd(share.cost))}
          </dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd className="tabular">{row.sessions}</dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd className="tabular">{row.turns}</dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd className="tabular">{lastRun(row, now)}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>
            <Tally count={row.failed} detail={failures} />
          </dd>
        </div>
        <div>
          <dt>Crashes</dt>
          <dd>
            <Tally count={row.crashes} detail={exits} />
          </dd>
        </div>
        <div>
          <dt>Boot (median)</dt>
          <dd className="tabular">{seconds(row.bootMs)}</dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>
            <Tally count={row.violations + timeoutsOf(row)} detail={signals} />
          </dd>
        </div>
      </dl>
      {split ? <div className="stats-detail">{split}</div> : null}
    </div>
  );
}

function Cards({ stats }: { stats: Stats }) {
  return (
    <div className="stats-cards">
      <Card row={stats.total} now={stats.now} total />
      {stats.repos.map((row) => (
        <Card key={row.repo} row={row} now={stats.now} />
      ))}
    </div>
  );
}
