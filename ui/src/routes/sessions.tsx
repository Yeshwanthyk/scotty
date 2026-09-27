import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "../components/AppShell";
import { sessions, type Session } from "../data/core";

export const Route = createFileRoute("/sessions")({ component: Sessions });

function Sessions() {
  const creating = useMatchRoute()({ to: "/sessions/create", fuzzy: false }) !== false;
  const [list, setList] = useState<ReadonlyArray<Session>>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (creating) return;
    const controller = new AbortController();
    void sessions(controller.signal).then(
      (value) => {
        setList(value);
        setError("");
        setLoading(false);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : "Could not load sessions");
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [creating]);
  return (
    <AppShell>
      {creating ? (
        <Outlet />
      ) : (
        <section className="page">
          <div className="page-heading">
            <h1>Sessions</h1>
            <Link className="button" to="/sessions/create">
              New session
            </Link>
          </div>
          {loading ? <p role="status">Loading sessions…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {!loading && !error && list.length === 0 ? <p>No sessions yet.</p> : null}
          <ul className="session-list">
            {list.map((item) => (
              <li key={item.identity.id}>
                <Link to="/s/$sessionId" params={{ sessionId: item.identity.id }}>
                  <strong>{item.display.title}</strong>
                  <span>
                    {item.display.repository} ·{" "}
                    {item.authority.kind === "stable"
                      ? item.authority.lifecycle
                      : item.authority.phase}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}
