import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AppShell } from "../components/AppShell";
import { Markdown } from "../components/Markdown";
import {
  conversation,
  message,
  session,
  write,
  type Conversation,
  type Session,
} from "../data/core";
import { startVisibilityPolling } from "../data/visibility-polling";

export const Route = createFileRoute("/s/$sessionId")({ component: SessionPage });

function SessionPage() {
  const { sessionId } = Route.useParams();
  return <SessionView key={sessionId} sessionId={sessionId} />;
}

function SessionView({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<Session>();
  const [snapshot, setSnapshot] = useState<Conversation>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [writeStatus, setWriteStatus] = useState("");
  const [busy, setBusy] = useState(false);
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
        }
      } catch (failure) {
        if (!signal.aborted) setError(message(failure, "Could not load session"));
      }
      return 2000;
    });
    refresh.current = polling.refresh;
    return () => {
      polling.stop();
      refresh.current = () => undefined;
    };
  }, [sessionId]);
  async function send(action: "steer" | "interrupt", event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (snapshot === undefined || busy) return;
    setBusy(true);
    setError("");
    const turn = snapshot.currentTurn;
    const submitted = action === "steer" ? text.trim() : undefined;
    const input = JSON.stringify([action, turn, submitted]);
    if (attempt.current?.input !== input) attempt.current = { input, req: crypto.randomUUID() };
    try {
      const status = await write(sessionId, action, turn, attempt.current.req, submitted);
      attempt.current = undefined;
      setWriteStatus(status);
      if (action === "steer" && (status === "pending" || status === "delivered"))
        setText((current) => (current.trim() === submitted ? "" : current));
      refresh.current();
    } catch (failure) {
      setError(message(failure, "Request failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppShell>
      <section className="page conversation">
        <div className="page-heading">
          <div>
            <h1>{detail?.display.title ?? "Session"}</h1>
            {detail ? (
              <p className="hint">
                {detail.display.repository} · {detail.display.branch}
              </p>
            ) : null}
          </div>
          <button type="button" className="secondary" onClick={() => refresh.current()}>
            Refresh
          </button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {!snapshot && !error ? <p role="status">Loading conversation…</p> : null}
        <ol className="turns">
          {snapshot?.turns.map((turn) => (
            <li key={turn.id}>
              <div className="message user">
                <span className="speaker">You</span>
                <p>{turn.user}</p>
              </div>
              {turn.assistant ? (
                <div className="message assistant">
                  <span className="speaker">Codex</span>
                  <Markdown source={turn.assistant} />
                </div>
              ) : null}
              <span className="hint">{turn.state}</span>
            </li>
          ))}
        </ol>
        {writeStatus ? <p role="status">Request {writeStatus}</p> : null}
        <form className="composer" onSubmit={(event) => void send("steer", event)}>
          <label htmlFor="steer-text">Steer Codex</label>
          <textarea
            id="steer-text"
            value={text}
            rows={3}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="actions">
            <button type="submit" disabled={busy || !snapshot || !text.trim()}>
              Send
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !snapshot}
              onClick={() => void send("interrupt")}
            >
              Interrupt
            </button>
          </div>
        </form>
      </section>
    </AppShell>
  );
}
