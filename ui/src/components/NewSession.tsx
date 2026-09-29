import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { create, message } from "../data/core";
import { useSessions } from "../data/sessions-store";
import { claudeStatus } from "../data/settings";
import { Composer } from "./Composer";
import { Icon } from "./Icon";
import { SidebarButton } from "./Layout";

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const lastRepoKey = "scotty.repo";
const lastAgentKey = "scotty.agent";
type Agent = "codex" | "claude";
const agentName = { codex: "Codex", claude: "Claude" } as const;

// A title from the prompt's first line; the owner can rename later.
const titleOf = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
};

const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering choices is a convenience only.
  }
};

function AgentSwitch({
  value,
  claudeReady,
  onChange,
}: {
  value: Agent;
  claudeReady: boolean;
  onChange: (agent: Agent) => void;
}) {
  return (
    <div className="agent-switch" role="group" aria-label="Agent">
      {(["codex", "claude"] as const).map((agent) => (
        <button
          type="button"
          key={agent}
          className="pressable"
          aria-pressed={value === agent}
          data-locked={agent === "claude" && !claudeReady ? "" : undefined}
          onClick={() => onChange(agent)}
        >
          {agentName[agent]}
        </button>
      ))}
    </div>
  );
}

export function NewSession() {
  const navigate = useNavigate();
  const { list, refresh } = useSessions();
  const [repo, setRepo] = useState(() => read(lastRepoKey));
  const [agent, setAgent] = useState<Agent>(() =>
    read(lastAgentKey) === "claude" ? "claude" : "codex",
  );
  // Unknown until the status loads; Claude can be picked only with its token set.
  const [claudeReady, setClaudeReady] = useState<boolean | undefined>(undefined);
  const [claudeHint, setClaudeHint] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ input: string; key: string }>(undefined);
  const recent = useMemo(
    () =>
      [...new Set((list ?? []).map((session) => session.display.repository).filter(Boolean))].slice(
        0,
        3,
      ),
    [list],
  );
  useEffect(() => {
    const abort = new AbortController();
    claudeStatus(abort.signal).then(
      (status) => setClaudeReady(status.status !== "signed-out"),
      () => setClaudeReady(false),
    );
    return () => abort.abort();
  }, []);
  const chosen: Agent = agent === "claude" && claudeReady === false ? "codex" : agent;
  const others = recent.filter((name) => name !== repo.trim());
  const validRepo = repoPattern.test(repo.trim());
  function pick(next: Agent) {
    if (next === "claude" && claudeReady === false) {
      setClaudeHint(true);
      return;
    }
    setClaudeHint(false);
    setAgent(next);
    remember(lastAgentKey, next);
  }
  async function submit() {
    if (!validRepo) {
      setError("Pick a repository as owner/name");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input = JSON.stringify([repo.trim(), prompt.trim(), chosen]);
      if (attempt.current?.input !== input) attempt.current = { input, key: crypto.randomUUID() };
      const id = await create(
        titleOf(prompt),
        repo.trim(),
        prompt.trim(),
        attempt.current.key,
        chosen,
      );
      remember(lastRepoKey, repo.trim());
      refresh();
      await navigate({ to: "/s/$sessionId", params: { sessionId: id } });
    } catch (failure) {
      setError(message(failure, "Could not create session"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="header bare">
        <SidebarButton />
        <Link
          to="/sessions"
          className="icon-button pressable mobile-only"
          aria-label="Back to sessions"
        >
          <Icon name="chevronLeft" />
        </Link>
        <div className="header-title mobile-only-block">
          <h1>New session</h1>
        </div>
      </header>
      <div className="new-session">
        <div className="new-session-inner">
          <h1 className="desktop-only">What should we work on?</h1>
          <Composer
            label="Prompt"
            value={prompt}
            onChange={setPrompt}
            onSubmit={() => void submit()}
            placeholder={`Ask ${agentName[chosen]} to build, fix or explain…`}
            busy={busy}
            autoFocus
          >
            <label className="repo-picker">
              <Icon name="repo" size={14} />
              <input
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/repo"
                aria-label="Repository"
                aria-invalid={repo !== "" && !validRepo}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                style={{ width: `${Math.max(10, repo.length + 1)}ch` }}
              />
            </label>
            <AgentSwitch value={chosen} claudeReady={claudeReady !== false} onChange={pick} />
          </Composer>
          {claudeHint ? (
            <p className="composer-note">
              <Icon name="alert" size={13} />
              <span>
                Claude needs its token.{" "}
                <Link to="/settings/$section" params={{ section: "accounts" }}>
                  Add it in Settings
                </Link>
              </span>
            </p>
          ) : null}
          {error ? (
            <p className="composer-note" data-tone="error" role="alert">
              <Icon name="alert" size={13} />
              {error}
            </p>
          ) : null}
          {others.length > 0 ? (
            <div className="suggestions">
              <span className="suggestions-label">Recent</span>
              {others.map((name) => (
                <button
                  type="button"
                  key={name}
                  className="suggestion pressable"
                  onClick={() => setRepo(name)}
                >
                  <Icon name="repo" size={13} />
                  {name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
