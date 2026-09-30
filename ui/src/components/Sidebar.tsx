import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import scottyMark from "../assets/brand/scotty-mark-128.png?url";
import type { Session } from "../data/core";
import { useSessions } from "../data/sessions-store";
import {
  ago,
  archived,
  grouped,
  matchesFilter,
  statusLabel,
  statusOf,
  type Filter,
  type Status,
} from "../data/status";
import { Icon, Spinner } from "./Icon";
import { Menu } from "./Menu";

export function StatusMark({ status }: { status: Status }) {
  return (
    <span className="status-mark" data-status={status} title={statusLabel[status]}>
      {status === "working" || status === "starting" ? (
        <Spinner size={13} />
      ) : status === "failed" ? (
        <Icon name="alert" size={14} />
      ) : status === "unseen" ? (
        <span className="dot" />
      ) : status === "stopped" ? (
        <Icon name="branch" size={14} />
      ) : (
        <span className="ring" />
      )}
    </span>
  );
}

// The subtitle leads with a state only when it asks for attention; otherwise repository and age.
function Meta({ session, status }: { session: Session; status: Status }) {
  const repo = session.display.repository.split("/").at(-1) ?? session.display.repository;
  // Codex is the default; only other agents are named.
  const agent =
    session.display.agentKind === "claude" ? <span className="agent-tag">Claude</span> : null;
  const loud =
    status === "working" || status === "starting" || status === "failed" || status === "unseen";
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

const filters: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "automations", label: "Automations" },
  { id: "running", label: "Running" },
];

function Row({ session, current }: { session: Session; current: boolean }) {
  const status = statusOf(session, current);
  return (
    <Link
      to="/s/$sessionId"
      params={{ sessionId: session.identity.id }}
      className="session-row"
      data-status={status}
      aria-current={current ? "page" : undefined}
    >
      <StatusMark status={status} />
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

const archivedKey = "scotty.archivedOpen";
function useArchivedOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(archivedKey) === "1";
    } catch {
      return false;
    }
  });
  const toggle = (next: boolean) => {
    if (next === open) return;
    setOpen(next);
    try {
      localStorage.setItem(archivedKey, next ? "1" : "0");
    } catch {
      // Private windows can refuse storage; the section then starts closed.
    }
  };
  return [open, toggle] as const;
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
  const [showArchived, toggleArchived] = useArchivedOpen();
  const all = (list ?? []).filter(
    (session) =>
      (repo === "" || session.display.repository === repo) && matchesFilter(session, filter),
  );
  const live = grouped(all.filter((session) => !archived(session)));
  const old = all
    .filter((session) => archived(session))
    .sort((a, b) => Date.parse(b.display.activeAt) - Date.parse(a.display.activeAt));
  const viewingArchived = old.some((session) => session.identity.id === currentId);
  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-top">
        <Link to="/sessions" className="brand">
          <img src={scottyMark} alt="" />
          Scotty
        </Link>
        <button
          type="button"
          className="icon-button pressable mobile-only"
          aria-label="Search"
          onClick={onSearch}
        >
          <Icon name="search" />
        </button>
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
      <nav className="sidebar-actions desktop-only">
        <Link
          to="/sessions/create"
          className="nav-item pressable"
          activeProps={{ "aria-current": "page" }}
        >
          <Icon name="plus" />
          New session
        </Link>
        <button type="button" className="nav-item pressable" onClick={onSearch}>
          <Icon name="search" />
          Search
          <kbd>⌘K</kbd>
        </button>
      </nav>
      <div className="session-heading group-label" data-filtered={filter !== "all" || repo !== ""}>
        <span>Sessions</span>
        {filter !== "all" ? (
          <span className="session-heading-filter">
            <span>· {filters.find((item) => item.id === filter)?.label}</span>
            <button
              type="button"
              className="session-filter-clear pressable"
              aria-label="Clear session filter"
              onClick={() => setFilter("all")}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ) : null}
        {repo !== "" ? (
          <span className="session-heading-filter session-heading-repo">
            <span title={repo}>· {repo}</span>
            <button
              type="button"
              className="session-filter-clear pressable"
              aria-label={`Clear repository ${repo}`}
              onClick={() => setRepo("")}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ) : null}
        <Menu
          label="Filter sessions"
          items={filters.map((item) => ({
            label: item.label,
            icon: "check",
            checked: filter === item.id,
            onSelect: () => setFilter(item.id),
          }))}
        >
          <Icon name="filter" size={14} />
        </Menu>
      </div>
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
        {list !== undefined && list.length > 0 && live.length === 0 && old.length === 0 ? (
          <p className="sidebar-empty">Nothing matches.</p>
        ) : null}
        {old.length > 0 ? (
          <details
            className="archived-group"
            open={showArchived || viewingArchived}
            onToggle={(event) => {
              // Opening for the session on screen doesn't change what the owner chose.
              if (!viewingArchived) toggleArchived(event.currentTarget.open);
            }}
          >
            <summary className="group-label">
              <Icon name="chevronRight" size={12} />
              Archived · {old.length}
            </summary>
            {old.map((session) => (
              <Row
                key={session.identity.id}
                session={session}
                current={session.identity.id === currentId}
              />
            ))}
          </details>
        ) : null}
      </div>
      <nav className="sidebar-foot desktop-only">
        <Link
          to="/settings"
          className="nav-item pressable"
          activeProps={{ "aria-current": "page" }}
        >
          <Icon name="settings" />
          Settings
        </Link>
      </nav>
      <div className="sidebar-bottom mobile-only-block">
        <Link to="/sessions/create" className="phone-compose pressable">
          <span>Build, fix or explain…</span>
          <span className="send-button" aria-hidden>
            <Icon name="arrowUp" size={14} />
          </span>
        </Link>
      </div>
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
