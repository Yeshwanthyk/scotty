import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  automations as loadAutomations,
  removeAutomation,
  runAutomation,
  runs as loadRuns,
  saveAutomation,
  sentence,
  switchAutomation,
  type Automation,
  type Definition,
  type Run,
} from "../data/automations";
import { message } from "../data/core";
import { ago } from "../data/status";
import { Icon, Spinner } from "./Icon";
import { SidebarButton } from "./Layout";

// The list of automations and their recent runs; `name` shows one, with its editor.
export function AutomationsPage({ name }: { name?: string }) {
  const [items, setItems] = useState<Automation[]>();
  const [recent, setRecent] = useState<Run[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [next, log] = await Promise.all([loadAutomations(), loadRuns(name)]);
      setItems(next);
      setRecent(log);
    } catch (failure) {
      setError(message(failure, "Could not load automations"));
    }
  }, [name]);
  useEffect(() => void load(), [load]);
  async function act(key: string, action: () => Promise<void>, fallback: string) {
    setBusy(key);
    setError("");
    try {
      await action();
      await load();
    } catch (failure) {
      setError(message(failure, fallback));
    } finally {
      setBusy("");
    }
  }
  const navigate = useNavigate();
  const shown = name === undefined ? undefined : items?.find((item) => item.name === name);
  const toggle = (item: Automation) => (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={item.enabled}
      aria-label={`${item.name} on`}
      disabled={busy !== ""}
      onClick={() =>
        void act(item.name, () => switchAutomation(item.name, !item.enabled), "Could not switch it")
      }
    >
      <span />
    </button>
  );
  return (
    <>
      <header className="header">
        <SidebarButton />
        <Link
          to={name === undefined ? "/sessions" : "/automations"}
          className={`icon-button pressable${name === undefined ? " mobile-only" : ""}`}
          aria-label="Back"
        >
          <Icon name="chevronLeft" />
        </Link>
        <div className="header-title">
          <h1>{name ?? "Automations"}</h1>
        </div>
        {name === undefined && !creating ? (
          <div className="header-actions">
            <button type="button" className="button pressable" onClick={() => setCreating(true)}>
              <Icon name="plus" size={13} />
              New
            </button>
          </div>
        ) : null}
      </header>
      <div className="automations" data-scroll>
        {error ? (
          <p className="notice" data-tone="error" role="alert">
            <Icon name="alert" size={13} />
            {error}
          </p>
        ) : null}
        {items === undefined ? (
          error ? null : (
            <div className="settings-card" aria-busy="true" />
          )
        ) : name === undefined ? (
          <>
            {creating ? (
              <Editor
                onCancel={() => setCreating(false)}
                onSaved={(saved) => {
                  setCreating(false);
                  void navigate({ to: "/automations/$name", params: { name: saved } });
                }}
              />
            ) : null}
            <div className="settings-card">
              <p className="settings-intro">
                An automation starts a session on a schedule or on a webhook delivery. A new or
                changed one is off until you switch it on. From a terminal:{" "}
                <code>scotty automation add</code>
              </p>
              {items.length === 0 ? (
                <div className="settings-empty">No automations yet.</div>
              ) : (
                items.map((item) => (
                  <div
                    key={item.name}
                    className="settings-row"
                    data-off={!item.enabled || undefined}
                  >
                    <Link
                      to="/automations/$name"
                      params={{ name: item.name }}
                      className="settings-row-text"
                    >
                      <div className="settings-row-title">
                        <span className="mono">{item.name}</span>
                        <span className="quiet settings-size">{lastRun(item.lastRun)}</span>
                      </div>
                      <div className="settings-row-detail">{sentence(item)}</div>
                    </Link>
                    {toggle(item)}
                  </div>
                ))
              )}
            </div>
            <h2 className="automations-heading">Recent runs</h2>
            <Runs runs={recent} />
          </>
        ) : shown === undefined ? (
          <div className="settings-empty">No automation is named {name}.</div>
        ) : (
          <>
            <div className="settings-card">
              <div className="settings-row" data-off={!shown.enabled || undefined}>
                <div className="settings-row-text">
                  <div className="settings-row-title">
                    {shown.enabled ? "On" : "Off"}
                    <span className="quiet settings-size">{nextRun(shown)}</span>
                  </div>
                  <div className="settings-row-detail">{sentence(shown)}</div>
                </div>
                {toggle(shown)}
              </div>
              <div className="settings-actions">
                <button
                  type="button"
                  className="button pressable"
                  disabled={busy !== ""}
                  onClick={() =>
                    void act(
                      "run",
                      async () => {
                        await runAutomation(shown.name);
                      },
                      "Could not run it",
                    )
                  }
                >
                  {busy === "run" ? <Spinner size={12} /> : <Icon name="play" size={13} />}
                  Run now
                </button>
                <button
                  type="button"
                  className="button pressable"
                  disabled={busy !== ""}
                  onClick={() => {
                    if (window.confirm(`Delete the ${shown.name} automation?`))
                      void act(
                        "remove",
                        async () => {
                          await removeAutomation(shown.name);
                          await navigate({ to: "/automations" });
                        },
                        "Could not delete it",
                      );
                  }}
                >
                  <Icon name="trash" size={13} />
                  Delete
                </button>
              </div>
            </div>
            <h2 className="automations-heading">Runs</h2>
            <Runs runs={recent} />
            <h2 className="automations-heading">Edit</h2>
            <Editor key={JSON.stringify(shown)} existing={shown} onSaved={() => void load()} />
          </>
        )}
      </div>
    </>
  );
}

const lastRun = (run: Run | Automation["lastRun"]) =>
  run === null ? "never run" : `${statusText[run.status]} ${ago(new Date(run.at).toISOString())}`;

const nextRun = (automation: Automation) =>
  automation.nextDue === null
    ? ""
    : `next ${new Date(automation.nextDue).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })}`;

const statusText: Record<Run["status"], string> = {
  received: "Waiting",
  skipped: "Skipped",
  failed: "Failed",
  started: "Started",
  steered: "Steered",
};
const outcomeText: Record<NonNullable<Run["outcome"]>, string> = {
  working: "working",
  completed: "turn done",
  aborted: "turn interrupted",
  failed: "turn failed",
  stopped: "session stopped",
};

function Runs({ runs }: { runs: Run[] }) {
  return (
    <div className="settings-card">
      {runs.length === 0 ? (
        <div className="settings-empty">No runs yet.</div>
      ) : (
        runs.slice(0, 30).map((run) => (
          <div key={run.id} className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">
                <span
                  className="settings-dot"
                  data-tone={
                    run.status === "failed" || run.outcome === "failed"
                      ? "warn"
                      : run.status === "skipped"
                        ? undefined
                        : "good"
                  }
                />
                {statusText[run.status]}
                {run.outcome === null ? "" : `, ${outcomeText[run.outcome]}`}
                <span className="quiet tabular settings-size">
                  {run.automation} · {run.trigger} · {ago(new Date(run.at).toISOString())}
                </span>
              </div>
              <div className="settings-row-detail">{run.reason ?? run.key ?? run.id}</div>
            </div>
            {run.session ? (
              <Link
                to="/s/$sessionId"
                params={{ sessionId: run.session }}
                className="button pressable"
              >
                Open session
              </Link>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

type Draft = {
  name: string;
  kind: Definition["when"]["kind"];
  cron: string;
  tz: string;
  minutes: string;
  connection: string;
  only: string;
  key: string;
  repo: string;
  agent: Definition["agent"];
  prompt: string;
};

const draftOf = (automation?: Automation): Draft => {
  const when = automation?.when;
  return {
    name: automation?.name ?? "",
    kind: when?.kind ?? "calendar",
    cron: when?.kind === "calendar" ? when.cron : "0 9 * * 1-5",
    tz: when?.kind === "calendar" ? when.tz : Intl.DateTimeFormat().resolvedOptions().timeZone,
    minutes: when?.kind === "interval" ? String(when.minutes) : "60",
    connection: when?.kind === "event" ? when.connection : "",
    // One `field=value` per line; commas give one-of.
    only: Object.entries(automation?.only ?? {})
      .map(([field, value]) => `${field}=${typeof value === "string" ? value : value.join(",")}`)
      .join("\n"),
    key: automation?.key ?? "",
    repo: automation?.repo ?? "",
    agent: automation?.agent ?? "codex",
    prompt: automation?.prompt ?? "",
  };
};

const definitionOf = (draft: Draft): Definition => {
  const only = Object.fromEntries(
    draft.only
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const at = line.indexOf("=");
        const values = line.slice(at + 1).split(",");
        return [line.slice(0, at).trim(), values.length === 1 ? line.slice(at + 1) : values];
      }),
  );
  return {
    when:
      draft.kind === "calendar"
        ? { kind: "calendar", cron: draft.cron.trim(), tz: draft.tz.trim() }
        : draft.kind === "interval"
          ? { kind: "interval", minutes: Number(draft.minutes) }
          : { kind: "event", connection: draft.connection.trim() },
    ...(Object.keys(only).length === 0 ? {} : { only }),
    ...(draft.key.trim() === "" ? {} : { key: draft.key.trim() }),
    repo: draft.repo.trim(),
    agent: draft.agent,
    prompt: draft.prompt,
  };
};

const kinds = [
  { id: "calendar", label: "Calendar" },
  { id: "interval", label: "Interval" },
  { id: "event", label: "Webhook" },
] as const;

function Editor({
  existing,
  onSaved,
  onCancel,
}: {
  existing?: Automation;
  onSaved: (name: string) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(existing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await saveAutomation(draft.name.trim(), definitionOf(draft), existing !== undefined);
      onSaved(draft.name.trim());
    } catch (failure) {
      setError(message(failure, "Could not save"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="settings-card automation-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {existing === undefined ? (
        <label>
          Name
          <input
            className="field mono"
            placeholder="daily-digest"
            autoComplete="off"
            value={draft.name}
            onChange={(event) => set({ name: event.target.value.toLowerCase() })}
          />
        </label>
      ) : null}
      <div className="automation-choices" role="group" aria-label="When it runs">
        {kinds.map((kind) => (
          <button
            key={kind.id}
            type="button"
            className="filter-chip pressable"
            aria-pressed={draft.kind === kind.id}
            onClick={() => set({ kind: kind.id })}
          >
            {kind.label}
          </button>
        ))}
      </div>
      {draft.kind === "calendar" ? (
        <div className="automation-pair">
          <label>
            Cron (minute hour day month weekday)
            <input
              className="field mono"
              value={draft.cron}
              onChange={(event) => set({ cron: event.target.value })}
            />
          </label>
          <label>
            Time zone
            <input
              className="field mono"
              placeholder="Europe/London"
              value={draft.tz}
              onChange={(event) => set({ tz: event.target.value })}
            />
          </label>
        </div>
      ) : draft.kind === "interval" ? (
        <label>
          Every (minutes)
          <input
            className="field tabular"
            inputMode="numeric"
            value={draft.minutes}
            onChange={(event) => set({ minutes: event.target.value })}
          />
        </label>
      ) : (
        <label>
          Webhook connection
          <input
            className="field mono"
            placeholder="sentry"
            value={draft.connection}
            onChange={(event) => set({ connection: event.target.value.toLowerCase() })}
          />
        </label>
      )}
      <label>
        Only when (one field=value per line; commas for any of)
        <textarea
          className="field settings-text automation-only"
          placeholder="action=created,reopened"
          spellCheck={false}
          value={draft.only}
          onChange={(event) => set({ only: event.target.value })}
        />
      </label>
      <div className="automation-pair">
        <label>
          Repository
          <input
            className="field mono"
            placeholder="owner/repo"
            value={draft.repo}
            onChange={(event) => set({ repo: event.target.value })}
          />
        </label>
        <label>
          Session key (optional; a repeat steers that session)
          <input
            className="field mono"
            placeholder="issue-{{data.issue.id}}"
            value={draft.key}
            onChange={(event) => set({ key: event.target.value })}
          />
        </label>
      </div>
      <div className="automation-choices" role="group" aria-label="Agent">
        {(["codex", "claude"] as const).map((agent) => (
          <button
            key={agent}
            type="button"
            className="filter-chip pressable"
            aria-pressed={draft.agent === agent}
            onClick={() => set({ agent })}
          >
            {agent === "codex" ? "Codex" : "Claude"}
          </button>
        ))}
      </div>
      <label>
        Prompt ({"{{field}}"} takes a value from the payload)
        <textarea
          className="field settings-text"
          placeholder="Summarise yesterday's commits and flag anything risky."
          value={draft.prompt}
          onChange={(event) => set({ prompt: event.target.value })}
        />
      </label>
      <div className="settings-actions">
        {onCancel ? (
          <button type="button" className="button pressable" data-tone="ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          className="button pressable"
          data-tone="primary"
          disabled={busy || draft.name.trim() === "" || draft.prompt.trim() === ""}
        >
          {busy ? <Spinner size={12} /> : null}
          {existing === undefined ? "Add, off" : "Save, turns it off"}
        </button>
      </div>
      {error ? (
        <p className="settings-problem" role="alert">
          <Icon name="alert" size={13} />
          {error}
        </p>
      ) : null}
    </form>
  );
}
