import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentChip, Composer } from "../components/Composer";
import { DiffStat } from "../components/DiffLines";
import { Icon, Spinner } from "../components/Icon";
import { Menu } from "../components/Menu";
import { SidebarButton } from "../components/Layout";
import { SidePanel, type PanelTab } from "../components/SidePanel";
import { Thread } from "../components/Thread";
import {
  conversation,
  lifecycle,
  message,
  remove,
  session,
  write,
  type Conversation,
  type Session,
} from "../data/core";
import { sessionChanges } from "../data/diff";
import { useSessions } from "../data/sessions-store";
import { markSeen, statusLabel, statusOf } from "../data/status";
import { startVisibilityPolling } from "../data/visibility-polling";

export const Route = createFileRoute("/s/$sessionId")({ component: SessionPage });

function SessionPage() {
  const { sessionId } = Route.useParams();
  return <SessionView key={sessionId} sessionId={sessionId} />;
}

const panelKey = "scotty.panel";
const readPanel = (): PanelTab | undefined => {
  try {
    const value = localStorage.getItem(panelKey);
    return value === "changes" || value === "preview" || value === "terminal" || value === "files"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

// Follow new output only while the reader is already near the bottom.
const pinDistance = 140;

function SessionView({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const sessions = useSessions();
  const [detail, setDetail] = useState<Session>();
  const [snapshot, setSnapshot] = useState<Conversation>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<PanelTab | undefined>(() =>
    typeof window !== "undefined" && window.innerWidth >= 1100 ? readPanel() : undefined,
  );
  const [pinned, setPinned] = useState(true);
  const thread = useRef<HTMLDivElement>(null);
  const refresh = useRef<() => void>(() => undefined);
  const attempt = useRef<{ input: string; req: string }>(undefined);
  useEffect(() => {
    const polling = startVisibilityPolling(document, async (signal) => {
      try {
        const [nextDetail, nextSnapshot] = await Promise.all([
          session(sessionId, signal),
          conversation(sessionId, signal),
        ]);
        if (!signal.aborted) {
          setDetail(nextDetail);
          setSnapshot(nextSnapshot);
          setError("");
          markSeen(nextDetail);
        }
      } catch (failure) {
        if (!signal.aborted) setError(message(failure, "Could not load session"));
      }
      return 2000;
    });
    refresh.current = polling.refresh;
    return () => polling.stop();
  }, [sessionId]);
  // What changes when the agent adds output; polls that change nothing don't move the view.
  const last = snapshot?.turns.at(-1);
  const growth = `${snapshot?.turns.length}:${last?.state}:${last?.items.length}:${JSON.stringify(last?.items.at(-1) ?? "").length}`;
  useLayoutEffect(() => {
    const element = thread.current;
    if (element === null || !pinned) return;
    element.scrollTop = element.scrollHeight;
    // Mermaid and images grow just after render; follow them briefly, then leave the reader be.
    const content = element.firstElementChild;
    if (content === null) return;
    const until = Date.now() + 1500;
    const observer = new ResizeObserver(() => {
      if (Date.now() < until) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    const timer = setTimeout(() => observer.disconnect(), 1500);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [growth, pinned]);
  const status = detail === undefined ? undefined : statusOf(detail, true);
  const working = status === "working";
  const failed = status === "failed";
  const stopped = status === "stopped";
  const running = detail?.authority.kind === "stable" && detail.authority.lifecycle === "running";
  async function send(action: "steer" | "interrupt") {
    if (snapshot === undefined || busy) return;
    setBusy(true);
    setError("");
    const turn = snapshot.currentTurn;
    const submitted = action === "steer" ? text.trim() : undefined;
    const input = JSON.stringify([action, turn, submitted]);
    if (attempt.current?.input !== input) attempt.current = { input, req: crypto.randomUUID() };
    try {
      const result = await write(sessionId, action, turn, attempt.current.req, submitted);
      attempt.current = undefined;
      setNote(
        action === "interrupt" ? "Stopping this turn…" : result === "pending" ? "Queued" : "",
      );
      if (action === "steer" && (result === "pending" || result === "delivered"))
        setText((current) => (current.trim() === submitted ? "" : current));
      setPinned(true);
      refresh.current();
      sessions.refresh();
    } catch (failure) {
      setError(message(failure, "Request failed"));
    } finally {
      setBusy(false);
    }
  }
  async function act(action: "stop" | "resume" | "delete") {
    setBusy(true);
    setError("");
    try {
      if (action === "delete") {
        if (!window.confirm("Delete this session and its history?")) return;
        await remove(sessionId);
        sessions.refresh();
        await navigate({ to: "/sessions" });
        return;
      }
      await lifecycle(sessionId, action);
      refresh.current();
      sessions.refresh();
    } catch (failure) {
      setError(message(failure, `Could not ${action} the session`));
    } finally {
      setBusy(false);
    }
  }
  function togglePanel() {
    const next = panel === undefined ? (readPanel() ?? "changes") : undefined;
    setPanel(next);
    try {
      localStorage.setItem(panelKey, next ?? "");
    } catch {
      // The panel then opens on Changes next time.
    }
  }
  useEffect(() => {
    if (!working) setNote((current) => (current === "Stopping this turn…" ? "" : current));
  }, [working]);
  const turns = useMemo(() => snapshot?.turns ?? [], [snapshot]);
  const changes = useMemo(() => sessionChanges(turns), [turns]);
  const added = changes.reduce((sum, file) => sum + file.added, 0);
  const removed = changes.reduce((sum, file) => sum + file.removed, 0);
  return (
    <>
      <header className="header">
        <Link
          to="/sessions"
          className="icon-button pressable mobile-only"
          aria-label="Back to sessions"
        >
          <Icon name="chevronLeft" />
        </Link>
        <SidebarButton />
        <div className="header-title">
          <h1>{detail?.display.title ?? " "}</h1>
          {detail ? (
            <span className="crumbs">
              <Icon name="branch" size={12} />
              <span>
                {detail.display.repository}
                {/* Scotty's own branch name is the session id; only a chosen branch is worth showing. */}
                {detail.display.branch && !detail.display.branch.startsWith("scotty/")
                  ? ` · ${detail.display.branch}`
                  : ""}
              </span>
            </span>
          ) : null}
        </div>
        <div className="header-actions">
          {status !== undefined && status !== "idle" && status !== "unseen" ? (
            <span className="pill desktop-only" data-status={status}>
              {status === "working" || status === "starting" ? <Spinner size={11} /> : null}
              {statusLabel[status]}
            </span>
          ) : null}
          {/* The diff stat is the way into the panel: the header says what changed at a glance. */}
          {added > 0 || removed > 0 ? (
            <button
              type="button"
              className="button pressable changes-button"
              aria-label={`Changes: ${changes.length} ${changes.length === 1 ? "file" : "files"}, ${added} added, ${removed} removed`}
              aria-pressed={panel !== undefined}
              onClick={togglePanel}
            >
              <DiffStat added={added} removed={removed} />
            </button>
          ) : (
            <button
              type="button"
              className="icon-button pressable"
              aria-label="Changes, preview and files"
              aria-pressed={panel !== undefined}
              onClick={togglePanel}
            >
              <Icon name="panel" />
            </button>
          )}
          <Menu
            label="Session actions"
            disabled={busy}
            items={[
              ...(stopped
                ? [
                    {
                      label: "Resume",
                      icon: "resume" as const,
                      detail: "Start its container again",
                      onSelect: () => void act("resume"),
                    },
                  ]
                : []),
              ...(running
                ? [
                    {
                      label: "Stop session",
                      icon: "stop" as const,
                      detail: "Shut down its container",
                      onSelect: () => void act("stop"),
                    },
                  ]
                : []),
              ...(stopped || failed
                ? [
                    {
                      label: "Delete session",
                      icon: "trash" as const,
                      tone: "danger" as const,
                      onSelect: () => void act("delete"),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </header>
      <div className="workspace" data-panel={panel === undefined ? "closed" : "open"}>
        <div className="chat">
          <div
            className="thread"
            data-scroll
            ref={thread}
            onScroll={(event) => {
              const element = event.currentTarget;
              setPinned(
                element.scrollHeight - element.scrollTop - element.clientHeight < pinDistance,
              );
            }}
          >
            <div className="thread-inner">
              {snapshot === undefined && error === "" ? <ThreadPlaceholder /> : null}
              {snapshot !== undefined ? <Thread sessionId={sessionId} turns={turns} /> : null}
              {status === "starting" && !turns.some((turn) => turn.state === "streaming") ? (
                <div className="live">
                  <Spinner size={13} />
                  <span className="shimmer">Starting the container</span>
                </div>
              ) : null}
              {failed && detail?.authority.kind === "stable" ? (
                <div className="notice" data-tone="error">
                  <Icon name="alert" size={13} />
                  <span>
                    This session failed to start. Its history stays here; start a new session to try
                    again.
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          {!pinned ? (
            <button type="button" className="jump pressable" onClick={() => setPinned(true)}>
              <Icon name="arrowDown" size={13} />
              Latest
            </button>
          ) : null}
          <div className="composer-wrap">
            {error || note ? (
              <p
                className="composer-note"
                data-tone={error ? "error" : undefined}
                role={error ? "alert" : "status"}
              >
                <Icon name={error ? "alert" : "check"} size={13} />
                {error || note}
              </p>
            ) : null}
            <Composer
              label="Message"
              value={text}
              onChange={setText}
              onSubmit={() => void send("steer")}
              onStop={() => void send("interrupt")}
              working={working}
              busy={busy}
              disabled={failed || snapshot === undefined}
              placeholder={
                failed
                  ? "This session can't take messages"
                  : stopped
                    ? "Send to resume…"
                    : working
                      ? "Steer the agent…"
                      : "Add a follow up…"
              }
            >
              <AgentChip kind={detail?.display.agentKind ?? "codex"} />
            </Composer>
          </div>
        </div>
        {panel !== undefined ? (
          <SidePanel
            sessionId={sessionId}
            turns={turns}
            changes={changes}
            running={running}
            tab={panel}
            onTab={(tab) => {
              setPanel(tab);
              try {
                localStorage.setItem(panelKey, tab);
              } catch {
                // Remembering the tab is a convenience only.
              }
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function ThreadPlaceholder() {
  return (
    <div aria-busy="true" aria-label="Loading conversation" style={{ display: "grid", gap: 16 }}>
      <div className="skeleton" style={{ height: 44, borderRadius: 10 }} />
      <div className="skeleton" style={{ height: 10, width: "40%" }} />
      <div className="skeleton" style={{ height: 10, width: "85%" }} />
      <div className="skeleton" style={{ height: 10, width: "70%" }} />
    </div>
  );
}
