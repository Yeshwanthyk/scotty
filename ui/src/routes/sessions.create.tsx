import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { create, message } from "../data/core";

export const Route = createFileRoute("/sessions/create")({ component: CreateSession });

function CreateSession() {
  const navigate = useNavigate();
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ input: string; key: string }>(undefined);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const input = JSON.stringify([title.trim(), repo.trim(), prompt.trim()]);
      if (attempt.current?.input !== input) attempt.current = { input, key: crypto.randomUUID() };
      const id = await create(title.trim(), repo.trim(), prompt.trim(), attempt.current.key);
      await navigate({ to: "/s/$sessionId", params: { sessionId: id } });
    } catch (failure) {
      setError(message(failure, "Could not create session"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page">
      <h1>New session</h1>
      <form onSubmit={(event) => void submit(event)} className="form">
        <label>
          Title
          <input required value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          Repository <span className="hint">owner/repo</span>
          <input
            required
            pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="octocat/Hello-World"
          />
        </label>
        <label>
          Prompt
          <textarea
            required
            rows={7}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button disabled={busy || !title.trim() || !repo.trim() || !prompt.trim()}>
          {busy ? "Creating…" : "Create session"}
        </button>
      </form>
    </section>
  );
}
