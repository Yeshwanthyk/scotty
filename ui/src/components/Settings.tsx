import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "../data/core";
import {
  accounts,
  pollChatGpt,
  removeSkill,
  saveInstructions,
  setGitHub,
  settings,
  startChatGpt,
  switchSkill,
  uploadSkill,
  type Accounts as AccountState,
  type Device,
  type Settings as SettingsState,
} from "../data/settings";
import { Icon, Spinner, type IconName } from "./Icon";
import { SidebarButton } from "./Layout";

export const sections = [
  { id: "accounts", label: "Accounts", icon: "globe", detail: "ChatGPT and GitHub" },
  { id: "instructions", label: "Instructions", icon: "file", detail: "Added to every session" },
  { id: "skills", label: "Skills", icon: "list", detail: "Installed in new sessions" },
  { id: "signed-in", label: "Signed in", icon: "circle", detail: "Cloudflare Access" },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName; detail: string }>;
export type Section = (typeof sections)[number]["id"];
export const isSection = (value: string): value is Section =>
  sections.some((section) => section.id === value);

type Data = { settings?: SettingsState; accounts?: AccountState; error: string };

// The phone shows the list of sections, then one section per screen; the desktop shows both.
export function SettingsPage({ section }: { section?: Section }) {
  const [data, setData] = useState<Data>({ error: "" });
  const load = useCallback(async () => {
    try {
      const [nextSettings, nextAccounts] = await Promise.all([settings(), accounts()]);
      setData({ settings: nextSettings, accounts: nextAccounts, error: "" });
    } catch (failure) {
      setData((current) => ({ ...current, error: message(failure, "Could not load settings") }));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const shown = section ?? "accounts";
  const current = sections.find((item) => item.id === shown);
  return (
    <>
      <header className="header">
        <SidebarButton />
        {section === undefined ? (
          <Link to="/sessions" className="icon-button pressable mobile-only" aria-label="Back">
            <Icon name="chevronLeft" />
          </Link>
        ) : (
          <Link to="/settings" className="icon-button pressable mobile-only" aria-label="Back">
            <Icon name="chevronLeft" />
          </Link>
        )}
        <div className="header-title">
          {/* On the phone a section is its own screen, so it names itself. */}
          <h1>
            <span className={section === undefined ? undefined : "desktop-only"}>Settings</span>
            {section !== undefined ? (
              <span className="mobile-only-text">{current?.label}</span>
            ) : null}
          </h1>
        </div>
      </header>
      <div className="settings" data-section={section ?? "index"} data-scroll>
        <nav className="settings-nav" aria-label="Settings">
          {sections.map((item) => (
            <Link
              key={item.id}
              to="/settings/$section"
              params={{ section: item.id }}
              className="settings-link pressable"
              aria-current={item.id === shown ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span className="settings-link-text">
                <span>{item.label}</span>
                <span className="settings-link-detail">{item.detail}</span>
              </span>
              <Icon name="chevronRight" size={14} />
            </Link>
          ))}
        </nav>
        <div className="settings-body">
          <h2 className="desktop-only">{current?.label}</h2>
          {data.error ? (
            <p className="notice" data-tone="error" role="alert">
              <Icon name="alert" size={13} />
              {data.error}
            </p>
          ) : null}
          {data.settings === undefined || data.accounts === undefined ? (
            data.error ? null : (
              <div className="settings-card" aria-busy="true">
                <div className="skeleton" style={{ height: 12, width: "40%" }} />
                <div className="skeleton" style={{ height: 10, width: "70%" }} />
              </div>
            )
          ) : shown === "accounts" ? (
            <Accounts accounts={data.accounts} reload={load} />
          ) : shown === "instructions" ? (
            <Instructions saved={data.settings.instructions} reload={load} />
          ) : shown === "skills" ? (
            <Skills skills={data.settings.skills} reload={load} />
          ) : (
            <SignedIn email={data.settings.email} />
          )}
        </div>
      </div>
    </>
  );
}

function Row({
  title,
  detail,
  tone,
  children,
}: {
  title: string;
  detail: string;
  tone?: "good" | "warn";
  children?: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-title">
          {tone ? <span className="settings-dot" data-tone={tone} /> : null}
          {title}
        </div>
        <div className="settings-row-detail">{detail}</div>
      </div>
      {children}
    </div>
  );
}

function Problem({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="settings-problem" role="alert">
      <Icon name="alert" size={13} />
      {text}
    </p>
  );
}

function Accounts({ accounts: state, reload }: { accounts: AccountState; reload: () => void }) {
  const [device, setDevice] = useState<Device>();
  const [token, setToken] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const polling = useRef(0);
  useEffect(() => {
    if (device === undefined) return;
    const run = ++polling.current;
    const timer = setInterval(
      async () => {
        try {
          const result = await pollChatGpt();
          if (run !== polling.current || result.status === "pending") return;
          clearInterval(timer);
          setDevice(undefined);
          if (result.status === "expired") setError("The code expired; sign in again");
          else if (result.status === "failed")
            setError(`Sign-in failed (${result.code ?? "poll"})`);
          reload();
        } catch (failure) {
          setError(message(failure, "Could not check the sign-in"));
        }
      },
      Math.max(2, device.interval) * 1000,
    );
    return () => clearInterval(timer);
  }, [device, reload]);
  async function signIn() {
    setBusy(true);
    setError("");
    try {
      setDevice(await startChatGpt());
    } catch (failure) {
      setError(message(failure, "Could not start the sign-in"));
    } finally {
      setBusy(false);
    }
  }
  async function saveToken() {
    if (!token?.trim()) return;
    setBusy(true);
    setError("");
    try {
      await setGitHub(token.trim());
      setToken(undefined);
      reload();
    } catch (failure) {
      setError(message(failure, "Could not save the token"));
    } finally {
      setBusy(false);
    }
  }
  const chatgpt = state.chatgpt.status;
  return (
    <div className="settings-card">
      <Row
        title="ChatGPT"
        detail={
          chatgpt === "signed-in"
            ? "Signed in. Codex runs on this account."
            : chatgpt === "expiring"
              ? "Sign-in expires soon; sign in again."
              : "Not signed in. Sessions can't start until you are."
        }
        tone={chatgpt === "signed-in" ? "good" : "warn"}
      >
        {device === undefined ? (
          <button
            type="button"
            className="button pressable"
            disabled={busy}
            onClick={() => void signIn()}
          >
            {busy && token === undefined ? <Spinner size={12} /> : null}
            {chatgpt === "signed-in" ? "Sign in again" : "Sign in"}
          </button>
        ) : null}
      </Row>
      {device !== undefined ? (
        <div className="device-code">
          <span className="quiet">Open the link and enter this code</span>
          <code className="tabular">{device.userCode}</code>
          <div className="device-actions">
            <a
              className="button pressable"
              href={device.verificationUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="external" size={13} />
              Open ChatGPT
            </a>
            <button
              type="button"
              className="button pressable"
              onClick={() => void navigator.clipboard?.writeText(device.userCode)}
            >
              <Icon name="copy" size={13} />
              Copy code
            </button>
            <span className="quiet device-wait">
              <Spinner size={12} />
              Waiting
            </span>
          </div>
        </div>
      ) : null}
      <Row
        title="GitHub"
        detail={
          state.github.status === "set"
            ? `Token for ${state.github.login ?? "your account"}. Sessions push branches with it.`
            : "No token. Sessions can clone only the built-in fixture."
        }
        tone={state.github.status === "set" ? "good" : "warn"}
      >
        {token === undefined ? (
          <button type="button" className="button pressable" onClick={() => setToken("")}>
            {state.github.status === "set" ? "Replace" : "Add token"}
          </button>
        ) : null}
      </Row>
      {token !== undefined ? (
        <form
          className="token-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveToken();
          }}
        >
          <input
            className="field"
            type="password"
            autoComplete="off"
            placeholder="github_pat_…"
            aria-label="GitHub token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoFocus
          />
          <button
            type="submit"
            className="button pressable"
            data-tone="primary"
            disabled={busy || !token.trim()}
          >
            {busy ? <Spinner size={12} /> : null}
            Save
          </button>
          <button
            type="button"
            className="button pressable"
            data-tone="ghost"
            onClick={() => setToken(undefined)}
          >
            Cancel
          </button>
        </form>
      ) : null}
      <Problem text={error} />
    </div>
  );
}

function Instructions({ saved, reload }: { saved: string; reload: () => void }) {
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const changed = text !== saved;
  async function save() {
    setBusy(true);
    setError("");
    try {
      await saveInstructions(text);
      setDone(true);
      reload();
    } catch (failure) {
      setError(message(failure, "Could not save"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-card">
      <p className="settings-intro">
        Added to the agent's AGENTS.md when a session starts or resumes. Running sessions keep what
        they started with.
      </p>
      <textarea
        className="field settings-text"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setDone(false);
        }}
        placeholder="Prefer small commits. Run the tests before you finish."
        aria-label="Instructions"
        spellCheck={false}
      />
      <div className="settings-actions">
        {done && !changed ? (
          <span className="quiet settings-saved">
            <Icon name="check" size={13} />
            Saved
          </span>
        ) : null}
        <button
          type="button"
          className="button pressable"
          data-tone="primary"
          disabled={busy || !changed}
          onClick={() => void save()}
        >
          {busy ? <Spinner size={12} /> : null}
          Save
        </button>
      </div>
      <Problem text={error} />
    </div>
  );
}

function Skills({ skills, reload }: { skills: SettingsState["skills"]; reload: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function run(key: string, action: () => Promise<void>, fallback: string) {
    setBusy(key);
    setError("");
    try {
      await action();
      reload();
    } catch (failure) {
      setError(message(failure, fallback));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="settings-card">
      <p className="settings-intro">
        A skill is a zip with SKILL.md at its root or in one folder. Uploading one with the same
        name replaces it. From a terminal: <code>scotty skill add ./folder</code>
      </p>
      {skills.length === 0 ? (
        <div className="settings-empty">No skills yet.</div>
      ) : (
        skills.map((skill) => (
          <div key={skill.name} className="settings-row" data-off={!skill.enabled || undefined}>
            <div className="settings-row-text">
              <div className="settings-row-title">
                <span className="mono">{skill.name}</span>
                <span className="quiet tabular settings-size">
                  {Math.max(1, Math.round(skill.size / 1024))} KB
                </span>
              </div>
              <div className="settings-row-detail">{skill.description}</div>
            </div>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={skill.enabled}
              aria-label={`${skill.name} on`}
              disabled={busy !== ""}
              onClick={() =>
                void run(
                  skill.name,
                  () => switchSkill(skill.name, !skill.enabled),
                  "Could not switch it",
                )
              }
            >
              <span />
            </button>
            <button
              type="button"
              className="icon-button pressable"
              aria-label={`Delete ${skill.name}`}
              disabled={busy !== ""}
              onClick={() => {
                if (window.confirm(`Delete the ${skill.name} skill?`))
                  void run(skill.name, () => removeSkill(skill.name), "Could not delete it");
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))
      )}
      <div className="settings-actions">
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void run("upload", () => uploadSkill(file), "Could not upload the skill");
          }}
        />
        <button
          type="button"
          className="button pressable"
          disabled={busy !== ""}
          onClick={() => input.current?.click()}
        >
          {busy === "upload" ? <Spinner size={12} /> : <Icon name="plus" size={13} />}
          Upload zip
        </button>
      </div>
      <Problem text={error} />
    </div>
  );
}

function SignedIn({ email }: { email: string | null }) {
  return (
    <div className="settings-card">
      <Row title={email ?? "Unknown account"} detail="Signed in through Cloudflare Access.">
        <a className="button pressable" href="/cdn-cgi/access/logout">
          Sign out
        </a>
      </Row>
    </div>
  );
}
