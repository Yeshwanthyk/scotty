import { Link, useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { defaultSize, type Size } from "../../../src/places/place";
import { create, lifecycle, message, type Session } from "../data/core";
import { useSessions } from "../data/sessions-store";
import { claudeStatus, repoDefaults, repoPattern, type RepoDefault } from "../data/settings";
import { ago, dormant, statusLabel, statusOf, type Status } from "../data/status";
import { Composer } from "./Composer";
import { Icon, Spinner } from "./Icon";
import { SidebarButton } from "./Layout";
import { SizePicker } from "./SizePicker";
import { StatusMark } from "./Sidebar";

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

// A pasted github.com link to a repository, issue or pull request picks the repository and,
// for an issue or pull request, writes a prompt the owner can edit before sending.
const githubLink =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(issues|pull)\/(\d+))?(?:[/?#]\S*)?$/u;
function fromLink(text: string): { repo: string; prompt: string } | undefined {
  const url = text.trim();
  const match = githubLink.exec(url);
  if (match === null) return undefined;
  const [, owner, name, kind, number] = match;
  if (owner === undefined || name === undefined) return undefined;
  const repo = `${owner}/${name}`;
  if (kind === "issues")
    return {
      repo,
      prompt: `Fix issue #${number}: ${url}\n\nRead it with gh, make the change and open a pull request.`,
    };
  if (kind === "pull")
    return {
      repo,
      prompt: `Review pull request #${number}: ${url}\n\nRead the diff with gh and list what's wrong, most serious first.`,
    };
  return { repo, prompt: "" };
}

// What needs the owner first: a reply they haven't read, a failure, work under way, then the rest.
const urgency: Record<Status, number> = {
  unseen: 0,
  failed: 1,
  starting: 2,
  working: 2,
  idle: 3,
  asleep: 4,
  stopped: 4,
};
// Words only where the mark alone could be missed; a spinner already says "working".
const loud = new Set<Status>(["unseen", "failed"]);

// As many rows as the window has room for below the box, between three and nine.
const pickupRoom = () =>
  typeof window === "undefined"
    ? 5
    : Math.max(3, Math.min(9, Math.floor((window.innerHeight - 480) / 40)));

// From the empty box, ↓ steps into the list; there ↑ and ↓ move, Enter opens and a number
// jumps straight to its row.
const pickupLinks = (from: Element) => [
  ...(from.closest(".new-session-inner")?.querySelectorAll<HTMLElement>(".pickup-link") ?? []),
];

function pickupKeys(event: KeyboardEvent<HTMLElement>) {
  const links = pickupLinks(event.currentTarget);
  const index = links.findIndex((link) => link === document.activeElement);
  if (index < 0) return;
  const jump = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : undefined;
  if (jump !== undefined) links[jump]?.click();
  else if (event.key === "ArrowDown") links[index + 1]?.focus();
  else if (event.key === "ArrowUp") {
    if (index === 0)
      event.currentTarget.closest(".new-session-inner")?.querySelector("textarea")?.focus();
    else links[index - 1]?.focus();
  } else return;
  event.preventDefault();
}

function PickUp({
  sessions,
  onResume,
  resuming,
}: {
  sessions: ReadonlyArray<{ session: Session; status: Status }>;
  onResume: (session: Session) => void;
  resuming: string | undefined;
}) {
  return (
    <section className="pickup" aria-labelledby="pickup-label">
      <h2 id="pickup-label">Pick up where you left off</h2>
      <ul onKeyDown={pickupKeys}>
        {sessions.map(({ session, status }, index) => {
          const repo = session.display.repository.split("/").at(-1) ?? "";
          return (
            <li key={session.identity.id} className="pickup-row" data-status={status}>
              <Link
                to="/s/$sessionId"
                params={{ sessionId: session.identity.id }}
                className="pickup-link pressable"
              >
                <StatusMark status={status} />
                <span className="pickup-title">{session.display.title}</span>
                <span className="pickup-meta">
                  {loud.has(status) ? (
                    <span data-status={status}>{statusLabel[status]}</span>
                  ) : null}
                  <span>
                    {repo || "No repository"} · {ago(session.display.activeAt)}
                  </span>
                </span>
                <span className="pickup-go" aria-hidden="true">
                  <kbd>{index + 1}</kbd>
                  <Icon name="arrowRight" size={13} />
                </span>
              </Link>
              {dormant(status) ? (
                <button
                  type="button"
                  className="pickup-action pressable"
                  disabled={resuming !== undefined}
                  onClick={() => onResume(session)}
                >
                  {resuming === session.identity.id ? (
                    <Spinner size={12} />
                  ) : (
                    <Icon name="resume" size={12} />
                  )}
                  Resume
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AgentSwitch({
  value,
  claudeReady,
  onChange,
}: {
  value: Agent;
  claudeReady: boolean;
  onChange: (agent: Agent) => void;
}) {
  // One pill slides under the chosen option instead of each option lighting up.
  const buttons = useRef<Partial<Record<Agent, HTMLButtonElement | null>>>({});
  const [pill, setPill] = useState<{ x: number; width: number }>();
  useLayoutEffect(() => {
    const measure = () => {
      const button = buttons.current[value];
      if (button) setPill({ x: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    void document.fonts.ready.then(measure);
  }, [value]);
  return (
    <div className="agent-switch" role="group" aria-label="Agent">
      {pill ? (
        <span
          className="agent-switch-pill"
          style={{ width: pill.width, transform: `translateX(${pill.x}px)` }}
        />
      ) : null}
      {(["codex", "claude"] as const).map((agent) => (
        <button
          type="button"
          key={agent}
          ref={(button) => {
            buttons.current[agent] = button;
          }}
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
  // A size picked by hand, for the repository it was picked for.
  const [picked, setPicked] = useState<{ repo: string; size: typeof Size.Type }>();
  // Shown only: the Worker applies a repository's default to a create that names no size.
  const [defaults, setDefaults] = useState<RepoDefault[]>([]);
  const [defaultsFailed, setDefaultsFailed] = useState(false);
  // Unknown until the status loads; Claude can be picked only with its token set.
  const [claudeReady, setClaudeReady] = useState<boolean | undefined>(undefined);
  const [claudeHint, setClaudeHint] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filled, setFilled] = useState("");
  const [resuming, setResuming] = useState<string>();
  // Counts link pastes, so each one shows what it filled.
  const [pasted, setPasted] = useState(0);
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const field = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [room] = useState(pickupRoom);
  const attempt = useRef<{ input: string; key: string }>(undefined);
  const recent = useMemo(
    () =>
      [...new Set((list ?? []).map((session) => session.display.repository).filter(Boolean))].slice(
        0,
        3,
      ),
    [list],
  );
  const pickup = useMemo(
    () =>
      (list ?? [])
        .map((session) => {
          const status = statusOf(session);
          // A failure from days ago is history, not something to act on now.
          const stale =
            status === "failed" && Date.parse(session.display.activeAt) < Date.now() - 86_400_000;
          return { session, status, rank: stale ? urgency.stopped : urgency[status] };
        })
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            Date.parse(b.session.display.activeAt) - Date.parse(a.session.display.activeAt),
        )
        .slice(0, room),
    [list, room],
  );
  useEffect(() => {
    const abort = new AbortController();
    claudeStatus(abort.signal).then(
      (status) => setClaudeReady(status.status !== "signed-out"),
      () => setClaudeReady(false),
    );
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    repoDefaults(abort.signal).then(setDefaults, () => {
      if (!abort.signal.aborted) setDefaultsFailed(true);
    });
    return () => abort.abort();
  }, []);
  useEffect(() => () => clearTimeout(typingTimer.current), []);
  // A pasted link flashes the repository it set and fades in the prompt it wrote.
  useEffect(() => {
    if (pasted === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const picker = inner.current?.querySelector(".repo-picker");
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    picker?.animate(
      [
        {
          boxShadow: `0 0 0 1.5px ${accent}`,
          background: `color-mix(in srgb, ${accent} 22%, transparent)`,
        },
        {},
      ],
      { duration: 1100, easing: "ease-out" },
    );
    inner.current
      ?.querySelector("textarea")
      ?.animate([{ opacity: 0, translate: "0 4px" }, {}], { duration: 360, easing: "ease-out" });
  }, [pasted]);
  function typed(value: string) {
    setPrompt(value);
    // The field brightens while keys are coming and settles a moment after they stop.
    setTyping(true);
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 700);
  }
  function drift(event: PointerEvent) {
    if (event.pointerType !== "mouse" || field.current === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    // A few pixels toward the mouse, at most.
    const x = ((event.clientX - box.left) / box.width - 0.5) * 12;
    const y = ((event.clientY - box.top) / box.height - 0.5) * 12;
    field.current.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
  }
  const chosen: Agent = agent === "claude" && claudeReady === false ? "codex" : agent;
  const others = recent.filter((name) => name !== repo.trim());
  const validRepo = repoPattern.test(repo.trim());
  const repoDefault = defaults.find((item) => item.repo === repo.trim().toLowerCase());
  const own = picked?.repo === repo.trim() ? picked.size : undefined;
  const size = own ?? repoDefault?.size ?? defaultSize;
  function pick(next: Agent) {
    if (next === "claude" && claudeReady === false) {
      setClaudeHint(true);
      return;
    }
    setClaudeHint(false);
    setAgent(next);
    remember(lastAgentKey, next);
  }
  function paste(event: ClipboardEvent) {
    if (prompt.trim() !== "") return;
    const link = fromLink(event.clipboardData.getData("text"));
    if (link === undefined) return;
    event.preventDefault();
    setRepo(link.repo);
    setPrompt(link.prompt);
    setError("");
    setFilled(link.repo);
    setPasted((count) => count + 1);
  }
  async function resume(session: Session) {
    setResuming(session.identity.id);
    setError("");
    try {
      await lifecycle(session.identity.id, "resume");
      refresh();
      await navigate({ to: "/s/$sessionId", params: { sessionId: session.identity.id } });
    } catch (failure) {
      setError(message(failure, "Could not resume session"));
    } finally {
      setResuming(undefined);
    }
  }
  async function submit() {
    if (!validRepo) {
      setError("Pick a repository as owner/name");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input = JSON.stringify([repo.trim(), prompt.trim(), chosen, own]);
      if (attempt.current?.input !== input) attempt.current = { input, key: crypto.randomUUID() };
      const id = await create(
        titleOf(prompt),
        repo.trim(),
        prompt.trim(),
        attempt.current.key,
        chosen,
        own,
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
      <div className="new-session" onPointerMove={drift}>
        <div
          ref={field}
          className="new-session-field"
          data-typing={typing || undefined}
          aria-hidden="true"
        />
        <div
          ref={inner}
          className="new-session-inner"
          onPaste={paste}
          onKeyDown={(event) => {
            if (
              event.key === "ArrowDown" &&
              event.target instanceof HTMLTextAreaElement &&
              prompt === ""
            ) {
              const first = pickupLinks(event.currentTarget)[0];
              if (first === undefined) return;
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <h1 className="desktop-only sr-only">New session</h1>
          <Composer
            label="Prompt"
            value={prompt}
            onChange={typed}
            onSubmit={() => void submit()}
            placeholder={`Ask ${agentName[chosen]} to build, fix or explain… or paste a GitHub link`}
            busy={busy}
            autoFocus
          >
            <label className="repo-picker">
              <Icon name="repo" size={14} />
              <input
                value={repo}
                onChange={(event) => {
                  setRepo(event.target.value);
                  setFilled("");
                }}
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
            <SizePicker
              value={size}
              // Unread defaults: the Worker still applies the repository's, whatever it is.
              {...(own === undefined && defaultsFailed ? { label: "repo default" } : {})}
              onChange={(next) => setPicked({ repo: repo.trim(), size: next })}
            />
          </Composer>
          {filled !== "" ? (
            <p className="composer-note">
              <Icon name="check" size={13} />
              <span>Repository set to {filled} from the link</span>
            </p>
          ) : null}
          {own === undefined && defaultsFailed ? (
            <p className="composer-note" data-tone="error">
              <Icon name="alert" size={13} />
              <span>
                Repository defaults did not load; a session with no size picked still gets its
                repository's default
              </span>
            </p>
          ) : null}
          {own === undefined && repoDefault !== undefined ? (
            <p className="composer-note">
              <Icon name="check" size={13} />
              <span>
                {repoDefault.size}: the {repoDefault.repo} default
              </span>
            </p>
          ) : null}
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
                  onClick={() => {
                    setRepo(name);
                    setFilled("");
                  }}
                >
                  <Icon name="repo" size={13} />
                  {name}
                </button>
              ))}
            </div>
          ) : null}
          {pickup.length > 0 ? (
            <PickUp
              sessions={pickup}
              onResume={(session) => void resume(session)}
              resuming={resuming}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
