import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { create, message } from "../data/core";
import { useSessions } from "../data/sessions-store";
import { AgentChip, Composer } from "./Composer";
import { Icon } from "./Icon";
import { SidebarButton } from "./Layout";

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const lastRepoKey = "scotty.repo";

// A title from the prompt's first line; the owner can rename later.
const titleOf = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
};

const readRepo = () => {
  try {
    return localStorage.getItem(lastRepoKey) ?? "";
  } catch {
    return "";
  }
};

export function NewSession() {
  const navigate = useNavigate();
  const { list, refresh } = useSessions();
  const [repo, setRepo] = useState(readRepo);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ input: string; key: string }>(undefined);
  const recent = useMemo(
    () =>
      [...new Set((list ?? []).map((session) => session.display.repository).filter(Boolean))].slice(
        0,
        4,
      ),
    [list],
  );
  const validRepo = repoPattern.test(repo.trim());
  async function submit() {
    if (!validRepo) {
      setError("Pick a repository as owner/name");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input = JSON.stringify([repo.trim(), prompt.trim()]);
      if (attempt.current?.input !== input) attempt.current = { input, key: crypto.randomUUID() };
      const id = await create(titleOf(prompt), repo.trim(), prompt.trim(), attempt.current.key);
      try {
        localStorage.setItem(lastRepoKey, repo.trim());
      } catch {
        // Remembering the repository is a convenience only.
      }
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
            placeholder="Ask Codex to build, fix or explain…"
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
              />
            </label>
            <AgentChip kind="codex" />
          </Composer>
          {error ? (
            <p className="composer-note" data-tone="error" role="alert">
              <Icon name="alert" size={13} />
              {error}
            </p>
          ) : null}
          {recent.length > 0 ? (
            <div className="suggestions">
              {recent.map((name) => (
                <button
                  type="button"
                  key={name}
                  className="suggestion pressable"
                  aria-pressed={repo === name}
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
