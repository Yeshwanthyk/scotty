import type { Session } from "../data/core";
import {
  failureSentence,
  statusLabel,
  stopLabel,
  stopSentence,
  stopWord,
  until,
  type Status,
} from "../data/status";
import { Icon, Spinner } from "./Icon";
import { useNow } from "./Thread";

const stopOf = (session: Session) =>
  session.authority.kind === "stable" ? session.authority.stop : undefined;

// The header pill: what the session is doing, or why it isn't.
export function StatusPill({ session, status }: { session: Session; status: Status }) {
  if (status === "idle" || status === "unseen") return null;
  const stop = stopOf(session);
  const full = status === "stopped" ? stopLabel(stop) : statusLabel[status];
  // The phone header has room for a word, not a reason.
  const short = status === "stopped" ? stopWord(stop) : statusLabel[status];
  return (
    <span className="pill" data-status={status} title={full}>
      {status === "working" || status === "starting" ? <Spinner size={11} /> : null}
      {status === "asleep" ? <Icon name="moon" size={11} /> : null}
      <span className="desktop-only">{full}</span>
      <span className="mobile-only">{short}</span>
    </span>
  );
}

// A quiet countdown while an idle running session waits to sleep.
export function SleepsIn({ at }: { at: string }) {
  const now = useNow(true, 15_000);
  const left = Date.parse(at) - now < 60_000 ? "soon" : until(at, now);
  return (
    <span
      className="sleeps tabular"
      title="An idle session sleeps to save cost; a message wakes it"
      aria-label={`Sleeps ${left === "soon" ? "soon" : `in ${left}`}`}
    >
      <Icon name="moon" size={12} />
      <span className="desktop-only">Sleeps {left === "soon" ? "" : "in "}</span>
      {left}
    </span>
  );
}

const bootSteps = ["Starting the container", "Preparing the workspace", "Starting the agent"];

// Container, then workspace, then the agent's first output.
export function BootSteps({ step }: { step: 0 | 1 | 2 }) {
  return (
    <ol className="boot-steps" aria-label="Starting">
      {bootSteps.map((label, index) => {
        const state = index < step ? "done" : index === step ? "active" : "waiting";
        return (
          <li key={label} data-state={state} aria-current={state === "active" ? "step" : undefined}>
            {state === "done" ? (
              <Icon name="check" size={13} />
            ) : state === "active" ? (
              <Spinner size={12} />
            ) : (
              <Icon name="circle" size={13} />
            )}
            <span className={state === "active" ? "shimmer" : undefined}>{label}</span>
            {state === "active" ? null : <span className="sr-only">, {state}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// Why the session isn't running, and the way back.
export function LifecycleNotice({
  session,
  status,
  busy,
  onResume,
}: {
  session: Session;
  status: Status;
  busy: boolean;
  onResume: () => void;
}) {
  const authority = session.authority;
  if (authority.kind !== "stable") return null;
  const resume = (
    <button type="button" className="button pressable" disabled={busy} onClick={onResume}>
      <Icon name="resume" size={13} />
      Resume
    </button>
  );
  if (status === "asleep")
    return (
      <div className="notice lifecycle-notice" data-tone="asleep" role="status">
        <Icon name="moon" size={13} />
        <span>Asleep to save cost. Send a message or resume to wake it.</span>
        {resume}
      </div>
    );
  if (status === "stopped") {
    const reason = authority.stop?.reason;
    const loud = reason === "crashed" || reason === "stalled" || reason === "gone";
    return (
      <div
        className="notice lifecycle-notice"
        data-tone={loud ? "warning" : "stopped"}
        role="status"
      >
        <Icon name={loud ? "alert" : "stop"} size={loud ? 13 : 11} />
        <span>{stopSentence(authority.stop)} Send a message or resume to start it again.</span>
        {resume}
      </div>
    );
  }
  if (status === "failed")
    return authority.failure?.recovery === "resume" ? (
      <div className="notice lifecycle-notice" data-tone="error" role="alert">
        <Icon name="alert" size={13} />
        <span title={authority.failure.code}>
          {failureSentence(authority.failure.code)} Its history is kept; resume to try again.
        </span>
        {resume}
      </div>
    ) : (
      <div className="notice" data-tone="error">
        <Icon name="alert" size={13} />
        <span title={authority.failure?.code}>
          {failureSentence(authority.failure?.code)} Its history stays here; start a new session to
          try again.
        </span>
      </div>
    );
  return null;
}
