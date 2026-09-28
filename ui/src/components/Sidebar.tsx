import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import scottyMark from "../assets/brand/scotty-mark-128.png?url";
import type { Session } from "../data/core";
import { useSessions } from "../data/sessions-store";
import { ago, grouped, statusLabel, statusOf, type Status } from "../data/status";
import { Icon, Spinner } from "./Icon";

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
  const loud =
    status === "working" || status === "starting" || status === "failed" || status === "unseen";
  return (
    <span className="meta">
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

export function Sidebar({
  onSearch,
  onCollapse,
}: {
  onSearch: () => void;
  onCollapse: () => void;
}) {
  const { list, error } = useSessions();
  const params = useParams({ strict: false });
  const currentId = "sessionId" in params ? params.sessionId : undefined;
  useMinuteTick();
  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-top">
        <Link to="/sessions" className="brand">
          <img src={scottyMark} alt="" />
          Scotty
        </Link>
        <button
          type="button"
          className="icon-button pressable"
          aria-label="Search"
          onClick={onSearch}
        >
          <Icon name="search" />
        </button>
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
      <div className="session-groups" data-scroll>
        {list === undefined && error === "" ? <Placeholder /> : null}
        {error && list === undefined ? <p className="sidebar-empty alert">{error}</p> : null}
        {list?.length === 0 ? (
          <p className="sidebar-empty">No sessions yet. Start one and it shows up here.</p>
        ) : null}
        {grouped(list ?? []).map(({ group, sessions }) => (
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
      </div>
      <div className="sidebar-bottom mobile-only-block">
        <Link to="/sessions/create" className="phone-compose pressable">
          <span>Ask Codex to build, fix, explain…</span>
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
