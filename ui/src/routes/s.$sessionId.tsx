import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentChip, Composer } from "../components/Composer";
import { DiffStat } from "../components/DiffLines";
import { Icon } from "../components/Icon";
import { BootSteps, LifecycleNotice, SleepsIn, StatusPill } from "../components/Lifecycle";
import { Menu } from "../components/Menu";
import { SidebarButton } from "../components/Layout";
import { SidePanel, type PanelTab } from "../components/SidePanel";
import { Thread, type ThreadMode } from "../components/Thread";
import {
  decodeSessionFrame,
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
import { dormant, markSeen, statusOf } from "../data/status";
import { openLive, type Connection } from "../data/live";

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

// "closed": the server ended the socket, yet the session is still there.
type Link = Connection | "closed" | "missing";
const linkNote: Record<Link, string> = {
  open: "",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  closed: "Disconnected; reload to reconnect",
  missing: "Session not found",
};

function SessionView({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const sessions = useSessions();
  const [detail, setDetail] = useState<Session>();
  const [snapshot, setSnapshot] = useState<Conversation>();
  const [text, setText] = useState("");
  // `error` is the last action's failure and `link` the socket's state, kept apart so a frame
  // doesn't wipe an error.
  const [error, setError] = useState("");
  const [link, setLink] = useState<Link>("open");
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
    // The session pushes its whole view after changes; an older frame never replaces a newer one.
    let seq = -1;
    let stopped = false;
    // A deleted session closes its socket and an unknown one refuses it, and the socket can't say
    // which happened, so one read asks. `otherwise` is shown when the session is still there.
    const check = (otherwise?: Link) =>
      void session(sessionId).then(
        (found) => {
          if (stopped) return;
          if (found === undefined) {
            live.stop();
            setLink("missing");
          } else if (otherwise !== undefined) setLink(otherwise);
        },
        () => {
          if (!stopped && otherwise !== undefined) setLink(otherwise);
        },
      );
    const live = openLive(
      `/api/sessions/${encodeURIComponent(sessionId)}/live`,
      decodeSessionFrame,
      {
        frame: (frame) => {
          if (frame.seq < seq) return;
          seq = frame.seq;
          setDetail(frame.session);
          setSnapshot(frame.conversation);
          markSeen(frame.session);
        },
        connection: (state) => {
          setLink(state);
          if (state === "connecting") check();
        },
        ended: () => check("closed"),
      },
    );
    refresh.current = live.reconnect;
    return () => {
      stopped = true;
      live.stop();
    };
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
  // Asleep or stopped: no container, and a message or Resume starts one.
  const stopped = dormant(status);
  const resumable =
    stopped ||
    (failed &&
      detail?.authority.kind === "stable" &&
      detail.authority.failure?.recovery === "resume");
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
  // Booting runs container, then workspace, then the agent's first output. A follow up in a
  // session that was already running waits the same way, so the wait counts as booting only on
  // the first turn or after a start this page saw.
  const lastTurn = turns.at(-1);
  const waiting =
    working &&
    lastTurn?.state === "streaming" &&
    lastTurn.items.length === 0 &&
    lastTurn.assistant === "";
  const transitioning = detail?.authority.kind === "transitioning";
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (transitioning) setBooted(true);
    else if (!waiting) setBooted(false);
  }, [transitioning, waiting]);
  const agentStarting = waiting && (booted || turns.length === 1);
  const bootStep =
    detail?.authority.kind === "transitioning"
      ? detail.authority.phase === "workspace"
        ? 1
        : 0
      : agentStarting
        ? 2
        : undefined;
  const mode: ThreadMode = bootStep !== undefined ? "booting" : working ? "live" : "dormant";
  const alert = error || linkNote[link];
  const sleepsAt = running && !working ? detail?.progress.sleepsAt : undefined;
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
          {detail ? <SessionLine display={detail.display} /> : null}
        </div>
        <div className="header-actions">
          {/* One status: an idle session that will sleep shows when, in place of a pill. */}
          {sleepsAt != null && (status === "idle" || status === "unseen") ? (
            <SleepsIn at={sleepsAt} />
          ) : detail !== undefined && status !== undefined ? (
            <StatusPill session={detail} status={status} />
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
              ...(resumable
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
              {snapshot === undefined && link !== "missing" ? <ThreadPlaceholder /> : null}
              {snapshot !== undefined ? (
                <Thread sessionId={sessionId} turns={turns} mode={mode} />
              ) : null}
              {bootStep !== undefined ? <BootSteps step={bootStep} /> : null}
              {detail !== undefined && status !== undefined ? (
                <LifecycleNotice
                  session={detail}
                  status={status}
                  busy={busy}
                  onResume={() => void act("resume")}
                />
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
            {alert || note ? (
              <p
                className="composer-note"
                data-tone={alert ? "error" : undefined}
                role={alert ? "alert" : "status"}
              >
                <Icon name={alert ? "alert" : "check"} size={13} />
                {alert || note}
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
              disabled={failed || snapshot === undefined || link === "missing"}
              placeholder={
                failed
                  ? resumable
                    ? "Resume to try again"
                    : "This session can't take messages"
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

// Where the session works and what started it, as one line that ellipsizes as a whole. The phone
// shows the repository's name without its owner.
function SessionLine({ display }: { display: Session["display"] }) {
  const { repository, branch, origin } = display;
  const slash = repository.lastIndexOf("/");
  const owner = slash > 0 ? repository.slice(0, slash + 1) : "";
  const name = repository.slice(slash + 1) || "No repository";
  return (
    <span className="header-sub">
      <span title={repository}>
        {owner ? <span className="desktop-only">{owner}</span> : null}
        {name}
      </span>
      {/* Scotty's own branch name is the session id; only a chosen branch is worth showing. */}
      {branch && !branch.startsWith("scotty/") ? <span title={branch}> · {branch}</span> : null}
      {origin?.kind === "automation" ? (
        <>
          {" · "}
          <Link
            to="/automations/$name"
            params={{ name: origin.automation }}
            title={origin.key ?? undefined}
          >
            via {origin.automation}
          </Link>
        </>
      ) : origin?.kind === "hook" ? (
        <>
          {" · "}
          <Link
            to="/settings/$section"
            params={{ section: "connections" }}
            title={origin.key ?? undefined}
          >
            via webhook {origin.connection}
          </Link>
        </>
      ) : null}
    </span>
  );
}
