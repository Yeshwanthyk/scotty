import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Session } from "../data/core";
import { useSessions } from "../data/sessions-store";
import {
  ago,
  dormant,
  stopLabel,
  grouped,
  matchesFilter,
  statusLabel,
  statusOf,
  type Filter,
  type Status,
} from "../data/status";
import { Icon, Spinner } from "./Icon";
import { Menu } from "./Menu";

// How many times a value has changed since mount, counted during render so the change shows
// in the same frame.
function useChanges<T>(value: T) {
  const [last, setLast] = useState(value);
  const [count, setCount] = useState(0);
  if (last !== value) {
    setLast(value);
    setCount((changes) => changes + 1);
  }
  return count;
}

export function StatusMark({ status, title }: { status: Status; title?: string }) {
  // A mark that changes while on screen pops in; one that is simply shown does not.
  const changed = useChanges(status) > 0;
  return (
    <span
      className="status-mark"
      data-status={status}
      data-pop={changed || undefined}
      title={title ?? statusLabel[status]}
      role="img"
      aria-label={title ?? statusLabel[status]}
    >
      {status === "working" || status === "starting" ? (
        <Spinner key="spin" size={13} />
      ) : status === "failed" ? (
        <Icon key="alert" name="alert" size={14} />
      ) : status === "unseen" ? (
        <span key="dot" className="dot" />
      ) : status === "asleep" ? (
        <Icon key="moon" name="moon" size={13} />
      ) : status === "stopped" ? (
        <Icon key="branch" name="branch" size={14} />
      ) : (
        <span key="ring" className="ring" />
      )}
    </span>
  );
}

// The mark's dot field, drawn live: rings of dots around a bright centre. While a session works
// the centre breathes slowly; when one finishes, a single ripple runs out through the rings.
// Three quick clicks scatter the dots, and they settle back.
const rings = [
  { radius: 3.4, count: 6, size: 0.75 },
  { radius: 6.6, count: 11, size: 0.65 },
  { radius: 9.8, count: 16, size: 0.55 },
];
function BrandMark({ working, scatter }: { working: number; scatter: number }) {
  const [ripple, setRipple] = useState(0);
  const before = useRef(working);
  const mark = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (working < before.current) setRipple((count) => count + 1);
    before.current = working;
  }, [working]);
  useEffect(() => {
    if (scatter === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Each dot flies outward from the centre an uneven distance, then springs back.
    mark.current?.querySelectorAll<SVGCircleElement>(".brand-ring circle").forEach((dot, index) => {
      const dx = dot.cx.baseVal.value - 10;
      const dy = dot.cy.baseVal.value - 10;
      const reach = (5 + ((index * 7) % 5)) / Math.hypot(dx, dy);
      dot.animate(
        [
          { translate: "0 0" },
          { translate: `${dx * reach}px ${dy * reach}px`, offset: 0.3 },
          { translate: "0 0" },
        ],
        { duration: 900 + ((index * 37) % 200), easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    });
  }, [scatter]);
  return (
    <svg
      ref={mark}
      className="brand-mark"
      data-working={working > 0}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
    >
      <rect width="20" height="20" rx="5.5" />
      <circle className="brand-core" cx="10" cy="10" r="1.25" />
      {/* A new key restarts the ripple. */}
      <g key={ripple} data-ripple={ripple > 0}>
        {rings.map((ring, index) => (
          <g
            key={ring.radius}
            className="brand-ring"
            style={{ animationDelay: `${index * 140}ms` }}
          >
            {Array.from({ length: ring.count }, (_, dot) => {
              // Each ring is turned a little, so the dots read as a swirl rather than spokes.
              const angle = (dot / ring.count) * Math.PI * 2 + index * 0.45;
              return (
                <circle
                  key={dot}
                  cx={10 + Math.cos(angle) * ring.radius}
                  cy={10 + Math.sin(angle) * ring.radius}
                  r={ring.size}
                />
              );
            })}
          </g>
        ))}
      </g>
    </svg>
  );
}

// The subtitle leads with a state only when it asks for attention; otherwise repository and age.
function Meta({ session, status }: { session: Session; status: Status }) {
  const repo = session.display.repository.split("/").at(-1) ?? session.display.repository;
  // Codex is the default; only other agents are named.
  const agent =
    session.display.agentKind === "claude" ? <span className="agent-tag">Claude</span> : null;
  // The spinner already says working; starting shares it, so only starting is spelled out.
  const loud = status === "starting" || status === "failed" || status === "unseen";
  return (
    <span className="meta">
      {agent}
      {loud ? (
        <>
          <span data-status={status}>{statusLabel[status]}</span>
          {repo ? ` · ${repo}` : null}
        </>
      ) : (
        <>
          {repo || "No repository"} · {ago(session.display.activeAt)}
        </>
      )}
    </span>
  );
}

export const filters: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "automations", label: "Automations" },
  { id: "running", label: "Running" },
];

// A row that asks for attention flashes once when it changes to that state.
const loudStatus = (status: Status) => status === "unseen" || status === "failed";

function Row({ session, current }: { session: Session; current: boolean }) {
  const status = statusOf(session, current);
  const flashes = useChanges(loudStatus(status));
  // A session started moments ago slides in at the top rather than appearing.
  const [fresh] = useState(() => Date.now() - Date.parse(session.display.createdAt) < 10_000);
  return (
    <Link
      to="/s/$sessionId"
      params={{ sessionId: session.identity.id }}
      className="session-row"
      data-status={status}
      data-fresh={fresh || undefined}
      data-flash={(loudStatus(status) && flashes > 0) || undefined}
      aria-current={current ? "page" : undefined}
    >
      <StatusMark
        status={status}
        title={
          status === "stopped" && session.authority.kind === "stable"
            ? stopLabel(session.authority.stop)
            : undefined
        }
      />
      <span className="title">{session.display.title}</span>
      <Meta session={session} status={status} />
    </Link>
  );
}

// Relative times drift; a slow tick keeps "3m" honest without re-rendering on every poll.
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
}

const stoppedKey = "scotty.stoppedOpen";
// Undefined until the owner opens or closes the section once.
function useSectionOpen(key: string) {
  const [open, setOpen] = useState<boolean | undefined>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? undefined : stored === "1";
    } catch {
      return undefined;
    }
  });
  const toggle = (next: boolean) => {
    if (next === open) return;
    setOpen(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Private windows can refuse storage; the choice then lasts until reload.
    }
  };
  return [open, toggle] as const;
}

function Fold({
  label,
  sessions,
  open,
  currentId,
  onToggle,
}: {
  label: string;
  sessions: ReadonlyArray<Session>;
  open: boolean;
  currentId: string | undefined;
  onToggle: (open: boolean) => void;
}) {
  const viewing = sessions.some((session) => session.identity.id === currentId);
  return (
    <details
      className="fold-group"
      open={open || viewing}
      onToggle={(event) => {
        // Only a click is the owner's choice; opening for the session on screen or by default
        // also fires toggle.
        if (!viewing && event.currentTarget.open !== open) onToggle(event.currentTarget.open);
      }}
    >
      <summary className="fold-toggle pressable">
        <span>{label}</span>
        <Icon name="chevronRight" size={12} />
        <span className="fold-count">{sessions.length}</span>
      </summary>
      <div className="fold-rows">
        {sessions.map((session) => (
          <Row
            key={session.identity.id}
            session={session}
            current={session.identity.id === currentId}
          />
        ))}
      </div>
    </details>
  );
}

export function Sidebar({
  onSearch,
  onCollapse,
}: {
  onSearch: () => void;
  onCollapse: () => void;
}) {
  const { list, error, repo, setRepo } = useSessions();
  const [filter, setFilter] = useState<Filter>("all");
  const params = useParams({ strict: false });
  const currentId = "sessionId" in params ? params.sessionId : undefined;
  useMinuteTick();
  const [scatter, setScatter] = useState(0);
  const [showStopped, toggleStopped] = useSectionOpen(stoppedKey);
  const all = (list ?? []).filter(
    (session) =>
      (repo === "" || session.display.repository === repo) && matchesFilter(session, filter),
  );
  const live = grouped(all.filter((session) => !dormant(statusOf(session))));
  const stopped = all
    .filter((session) => dormant(statusOf(session)))
    .sort((a, b) => Date.parse(b.display.activeAt) - Date.parse(a.display.activeAt));
  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-top">
        <Link
          to="/sessions"
          className="brand"
          onClick={(event) => {
            if (event.detail === 3) setScatter((count) => count + 1);
          }}
        >
          <BrandMark
            scatter={scatter}
            working={
              (list ?? []).filter((session) => {
                const status = statusOf(session);
                return status === "working" || status === "starting";
              }).length
            }
          />
          Scotty
        </Link>
        <Link
          to="/automations"
          className="icon-button pressable mobile-only"
          aria-label="Automations"
        >
          <Icon name="refresh" />
        </Link>
        <Link to="/settings" className="icon-button pressable mobile-only" aria-label="Settings">
          <Icon name="settings" />
        </Link>
        <button
          type="button"
          className="icon-button pressable desktop-only"
          aria-label="Hide sidebar"
          onClick={onCollapse}
        >
          <Icon name="sidebar" />
        </button>
      </div>
      <nav className="sidebar-tools" aria-label="Session controls">
        {/* Search and its filter share one field; New session stands apart as the main action. */}
        <div className="sidebar-field">
          <button type="button" className="sidebar-search pressable" onClick={onSearch}>
            <Icon name="search" size={15} />
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>
          <div
            className="sidebar-filter"
            data-filtered={filter !== "all" || repo !== ""}
            title="Filter sessions"
          >
            <Menu
              label="Filter sessions"
              items={filters.map((item) => ({
                label: item.label,
                icon: "check",
                checked: filter === item.id,
                onSelect: () => setFilter(item.id),
              }))}
            >
              <Icon name="filter" size={15} />
            </Menu>
          </div>
        </div>
        <Link
          to="/sessions/create"
          className="sidebar-new pressable"
          aria-label="New session"
          title="New session"
          activeProps={{ "aria-current": "page" }}
        >
          <Icon name="plus" />
        </Link>
      </nav>
      {filter !== "all" || repo !== "" ? (
        <div className="session-filters">
          {filter !== "all" ? (
            <span className="session-filter">
              <span>{filters.find((item) => item.id === filter)?.label}</span>
              <button
                type="button"
                className="session-filter-clear pressable"
                aria-label="Clear session filter"
                title="Clear session filter"
                onClick={() => setFilter("all")}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ) : null}
          {repo !== "" ? (
            <span className="session-filter session-filter-repo">
              <span title={repo}>{repo}</span>
              <button
                type="button"
                className="session-filter-clear pressable"
                aria-label={`Clear repository ${repo}`}
                title={`Clear repository ${repo}`}
                onClick={() => setRepo("")}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="session-groups" data-scroll>
        {list === undefined && error === "" ? <Placeholder /> : null}
        {error && list === undefined ? (
          <p className="sidebar-empty" title={error}>
            Can't reach Scotty. Retrying…
          </p>
        ) : null}
        {list?.length === 0 ? (
          <p className="sidebar-empty">No sessions yet. Start one and it shows up here.</p>
        ) : null}
        {live.map(({ group, sessions }) => (
          <section key={group}>
            <div className="group-label">{group}</div>
            {sessions.map((session) => (
              <Row
                key={session.identity.id}
                session={session}
                current={session.identity.id === currentId}
              />
            ))}
          </section>
        ))}
        {list !== undefined && list.length > 0 && live.length === 0 && stopped.length === 0 ? (
          <p className="sidebar-empty">Nothing matches.</p>
        ) : null}
        {stopped.length > 0 ? (
          <div className="folds">
            <Fold
              label="Stopped"
              sessions={stopped}
              // With nothing running, recent stopped work is what the owner returns to.
              open={showStopped ?? live.length === 0}
              currentId={currentId}
              onToggle={toggleStopped}
            />
          </div>
        ) : null}
      </div>
      <nav className="sidebar-foot desktop-only">
        <Link
          to="/automations"
          className="nav-item pressable"
          activeProps={{ "aria-current": "page" }}
        >
          <Icon name="refresh" />
          Automations
        </Link>
        <Link
          to="/settings"
          className="nav-item pressable"
          activeProps={{ "aria-current": "page" }}
        >
          <Icon name="settings" />
          Settings
        </Link>
      </nav>
    </aside>
  );
}

function Placeholder() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading sessions"
      style={{ padding: "14px 8px", display: "grid", gap: 14 }}
    >
      {[72, 56, 64, 48].map((width) => (
        <div key={width} style={{ display: "grid", gap: 6 }}>
          <div className="skeleton" style={{ height: 10, width: `${width}%` }} />
          <div className="skeleton" style={{ height: 8, width: `${width - 24}%`, opacity: 0.6 }} />
        </div>
      ))}
    </div>
  );
}
