import { Option, Schema } from "effect";
import { SignaturePreset, signaturePresets } from "../../../src/hooks/config";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "../data/core";
import { ago } from "../data/status";
import {
  accounts,
  addConnection,
  connectMcp,
  setToolPolicy,
  connections as loadConnections,
  deliveries as loadDeliveries,
  removeConnection,
  pollChatGpt,
  removeSkill,
  saveInstructions,
  setClaude,
  setGitHub,
  settings,
  startChatGpt,
  switchSkill,
  uploadSkill,
  type Accounts as AccountState,
  type Connection,
  type Delivery,
  type DeliveryReason,
  type Device,
  type Settings as SettingsState,
} from "../data/settings";
import { automations as loadAutomations, type Automation } from "../data/automations";
import { blueprints, installBlueprint } from "../data/blueprints";
import { Icon, Spinner, type IconName } from "./Icon";
import { SidebarButton } from "./Layout";

export const sections = [
  { id: "accounts", label: "Accounts", icon: "globe", detail: "ChatGPT, Claude and GitHub" },
  { id: "instructions", label: "Instructions", icon: "file", detail: "Added to every session" },
  { id: "skills", label: "Skills", icon: "list", detail: "Installed in new sessions" },
  {
    id: "connections",
    label: "Connections",
    icon: "branch",
    detail: "Webhooks, API tokens and MCP servers",
  },
  {
    id: "blueprints",
    label: "Blueprints",
    icon: "nodes",
    detail: "Connections and automations for one use",
  },
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
          ) : shown === "connections" ? (
            <Connections />
          ) : shown === "blueprints" ? (
            <Blueprints />
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
  // The account whose token is being entered, and what has been typed.
  const [token, setToken] = useState<{ account: "github" | "claude"; value: string }>();
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
    const value = token?.value.trim();
    if (token === undefined || !value) return;
    setBusy(true);
    setError("");
    try {
      await (token.account === "claude" ? setClaude(value) : setGitHub(value));
      setToken(undefined);
      reload();
    } catch (failure) {
      setError(message(failure, "Could not save the token"));
    } finally {
      setBusy(false);
    }
  }
  const chatgpt = state.chatgpt.status;
  const tokenForm = (
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
        placeholder={token?.account === "claude" ? "sk-ant-oat01-…" : "github_pat_…"}
        aria-label={token?.account === "claude" ? "Claude token" : "GitHub token"}
        value={token?.value ?? ""}
        onChange={(event) =>
          setToken(token && { account: token.account, value: event.target.value })
        }
        autoFocus
      />
      <button
        type="submit"
        className="button pressable"
        data-tone="primary"
        disabled={busy || !token?.value.trim()}
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
  );
  return (
    <div className="settings-card">
      <Row
        title="ChatGPT"
        detail={
          chatgpt === "signed-in"
            ? "Signed in. Codex runs on this account."
            : chatgpt === "expiring"
              ? "Sign-in expires soon; sign in again."
              : "Not signed in. Codex sessions can't start until you are."
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
        title="Claude"
        detail={
          state.claude.status === "signed-in"
            ? "Token set. Claude sessions run on your subscription."
            : state.claude.status === "expiring"
              ? "Token expires soon; add a new one."
              : "No token. Run claude setup-token and paste what it prints."
        }
        tone={state.claude.status === "signed-in" ? "good" : "warn"}
      >
        {token?.account !== "claude" ? (
          <button
            type="button"
            className="button pressable"
            onClick={() => setToken({ account: "claude", value: "" })}
          >
            {state.claude.status === "signed-out" ? "Add token" : "Replace"}
          </button>
        ) : null}
      </Row>
      {token?.account === "claude" ? tokenForm : null}
      <Row
        title="GitHub"
        detail={
          state.github.status === "set"
            ? `Token for ${state.github.login ?? "your account"}. Sessions push branches with it.`
            : "No token. Sessions can clone only the built-in fixture."
        }
        tone={state.github.status === "set" ? "good" : "warn"}
      >
        {token?.account !== "github" ? (
          <button
            type="button"
            className="button pressable"
            onClick={() => setToken({ account: "github", value: "" })}
          >
            {state.github.status === "set" ? "Replace" : "Add token"}
          </button>
        ) : null}
      </Row>
      {token?.account === "github" ? tokenForm : null}
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
        name replaces it. From a terminal: <code>scotty push skill ./folder</code>
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

const reasons: Record<DeliveryReason, string> = {
  missing_headers: "Missing webhook headers",
  unknown_connection: "Unknown connection",
  own_github_identity: "Skipped: sent by Scotty’s GitHub account",
  no_automation: "Skipped: no automation listens on this connection",
  too_large: "Body too large",
  bad_signature: "Bad signature",
  stale_timestamp: "Timestamp too old",
  bad_body: "Unreadable body",
  repository_not_found: "Repository not found",
  repository_unavailable: "Repository unavailable",
  key_conflict: "Key or delivery used for another repo, agent or prompt",
  session_unavailable: "Session unavailable",
};

const presetNames: Record<SignaturePreset, string> = {
  "standard-webhooks": "Webhook",
  github: "GitHub webhook",
  linear: "Linear webhook",
  slack: "Slack webhook",
};

// Structural equality of decoded JSON, so a stored signature config can be matched to its preset.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const right = new Map(Object.entries(b));
  const left = Object.entries(a);
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && same(value, right.get(key)))
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// What a connection is, in a few words.
function describe(item: Connection): string {
  switch (item.kind) {
    case "inbound": {
      const preset = SignaturePreset.literals.find((name) =>
        same(item.signature, signaturePresets[name]),
      );
      return preset === undefined ? "Webhook with a custom signature" : presetNames[preset];
    }
    case "token":
      return `Token for ${item.host}`;
    case "mcp":
      return [
        `MCP server · ${hostOf(item.url)}`,
        item.signIn === "signed-in"
          ? "signed in"
          : item.signIn === "needs-sign-in"
            ? "needs sign-in again"
            : "not connected",
        item.policy.kind === "named"
          ? `${item.policy.tools.length} named tool${item.policy.tools.length === 1 ? "" : "s"}`
          : item.policy.kind === "all"
            ? "all tools"
            : "read-only tools",
      ].join(" · ");
  }
}

function deliveryText(delivery: Delivery): string {
  if (delivery.outcome === "rejected" || delivery.outcome === "skipped")
    return delivery.reason === null
      ? delivery.outcome === "skipped"
        ? "Skipped"
        : "Rejected"
      : reasons[delivery.reason];
  return delivery.outcome === "duplicate" ? "Already delivered" : "Accepted";
}

// One row per delivery id: a sender's retry folds into its first attempt. The list comes newest
// first, so rows keep the order of their latest attempt and the last one seen is the original.
type Attempts = { first: Delivery; retries: number; session: string | null };
function foldRetries(deliveries: ReadonlyArray<Delivery>): Attempts[] {
  const rows = new Map<string, Attempts>();
  for (const delivery of deliveries) {
    const seen = rows.get(delivery.id);
    rows.set(delivery.id, {
      first: delivery,
      retries: seen === undefined ? 0 : seen.retries + 1,
      session: seen?.session ?? delivery.session,
    });
  }
  return [...rows.values()];
}

const tallyOrder = ["accepted", "bad signature", "rejected", "skipped", "already delivered"];
function tally(rows: ReadonlyArray<Attempts>): string {
  const counts = new Map<string, number>();
  for (const { first } of rows) {
    const label =
      first.outcome === "rejected"
        ? first.reason === "bad_signature"
          ? "bad signature"
          : "rejected"
        : first.outcome === "duplicate"
          ? "already delivered"
          : first.outcome;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return tallyOrder
    .flatMap((label) => {
      const count = counts.get(label);
      return count === undefined ? [] : [`${count} ${label}`];
    })
    .join(", ");
}

function since(at: number): string {
  const text = ago(new Date(at).toISOString());
  return text === "now" ? "just now" : /^\d/.test(text) ? `${text} ago` : `on ${text}`;
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

function Connections() {
  const [items, setItems] = useState<Connection[]>();
  const [log, setLog] = useState<Delivery[]>([]);
  const [users, setUsers] = useState<Automation[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"inbound" | "token" | "mcp">("inbound");
  const [preset, setPreset] = useState<SignaturePreset>("standard-webhooks");
  const [target, setTarget] = useState("");
  const [header, setHeader] = useState("Authorization: Bearer");
  const [secret, setSecret] = useState("");
  const [created, setCreated] = useState<{ name: string; url: string; secret: string }>();
  const [copied, setCopied] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [next, recent, automations] = await Promise.all([
        loadConnections(),
        loadDeliveries(),
        loadAutomations(),
      ]);
      setItems(next);
      setLog(recent);
      setUsers(automations);
    } catch (failure) {
      setError(message(failure, "Could not load connections"));
    }
  }, []);
  useEffect(() => void load(), [load]);
  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (failure) {
      setError(message(failure, fallback));
    } finally {
      setBusy(false);
    }
  }
  const copy = (what: string, text: string) =>
    void navigator.clipboard?.writeText(text).then(() => setCopied(what));
  if (items === undefined)
    return error ? <Problem text={error} /> : <div className="settings-card" aria-busy="true" />;
  return (
    <>
      <p className="settings-intro">
        A connection lets an outside service start sessions with a signed webhook, or lets agents
        call an API or MCP server through its internal URL.
      </p>
      {created ? (
        <div className="settings-card">
          <div className="settings-row secret-row">
            <div className="settings-row-text">
              <div className="settings-row-title">
                <span className="mono">{created.name}</span> secret, shown once
              </div>
              <div className="settings-row-detail mono">{created.secret}</div>
              <div className="settings-row-detail mono">{created.url}</div>
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="button pressable"
                onClick={() => copy("secret", created.secret)}
              >
                <Icon name={copied === "secret" ? "check" : "copy"} size={13} />
                Copy secret
              </button>
              <button
                type="button"
                className="button pressable"
                onClick={() => copy("url", created.url)}
              >
                <Icon name={copied === "url" ? "check" : "copy"} size={13} />
                Copy URL
              </button>
              <button
                type="button"
                className="button pressable"
                onClick={() => setCreated(undefined)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className="settings-card">
          <div className="settings-empty">No connections yet.</div>
        </div>
      ) : (
        items.map((item) => {
          const rows = foldRetries(log.filter((delivery) => delivery.connection === item.name));
          const used = users.filter(
            (automation) =>
              automation.when.kind === "event" && automation.when.connection === item.name,
          ).length;
          const url = item.kind === "inbound" ? item.url : item.internalUrl;
          const latest = rows[0]?.first;
          const summary =
            item.kind === "inbound"
              ? [
                  used === 0 ? "No automations" : null,
                  latest === undefined ? "No deliveries yet" : `last delivery ${since(latest.at)}`,
                  rows.length === 0 ? null : tally(rows),
                ]
                  .filter((part) => part !== null)
                  .join(" · ")
              : item.kind === "token"
                ? `Adds the ${item.header} header`
                : item.url;
          return (
            <div key={item.name} className="settings-card">
              <div className="settings-row">
                <div className="settings-row-text">
                  <div className="settings-row-title">
                    <span className="mono">{item.name}</span>
                    <span className="quiet settings-size">{describe(item)}</span>
                  </div>
                  <div className="settings-row-detail mono">{url}</div>
                  <div className="settings-row-detail">
                    {item.kind === "inbound" && used > 0 ? (
                      <>
                        <Link to="/automations">
                          Used by {used} automation{used === 1 ? "" : "s"}
                        </Link>
                        {" · "}
                      </>
                    ) : null}
                    {summary}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-button pressable"
                  aria-label={`Copy the URL of ${item.name}`}
                  onClick={() => copy(`url:${item.name}`, url)}
                >
                  <Icon name={copied === `url:${item.name}` ? "check" : "copy"} size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button pressable"
                  aria-label={`Delete ${item.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete the ${item.name} connection?`))
                      void run(() => removeConnection(item.name), "Could not delete it");
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
              {item.kind === "mcp" ? (
                // Keyed by the stored policy, so a reload that changes it resets the choice.
                <McpControls key={JSON.stringify(item.policy)} item={item} busy={busy} run={run} />
              ) : null}
              {rows.length > 0 ? (
                <details className="deliveries">
                  <summary>
                    <Icon name="chevronRight" size={12} />
                    Deliveries ({rows.length})
                  </summary>
                  {rows.map(({ first, retries, session }) => (
                    <div key={first.id} className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-title">
                          <span
                            className="settings-dot"
                            data-tone={first.outcome === "rejected" ? "warn" : "good"}
                          />
                          {deliveryText(first)}
                          {retries > 0 ? (
                            <span className="quiet settings-size">retried {retries}×</span>
                          ) : null}
                        </div>
                        <div className="settings-row-detail quiet">
                          <span className="tabular">{since(first.at)}</span> ·{" "}
                          <span className="mono" title={first.id}>
                            {shortId(first.id)}
                          </span>
                        </div>
                      </div>
                      {session ? (
                        <Link
                          to="/s/$sessionId"
                          params={{ sessionId: session }}
                          className="button pressable"
                        >
                          Open session
                        </Link>
                      ) : null}
                    </div>
                  ))}
                </details>
              ) : null}
            </div>
          );
        })
      )}
      {adding ? (
        <div className="settings-card">
          <form
            className="token-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await addConnection(
                  kind === "inbound"
                    ? {
                        kind,
                        name: name.trim(),
                        signing: { kind: "preset", preset },
                        ...(secret.trim() === "" ? {} : { secret: secret.trim() }),
                      }
                    : kind === "token"
                      ? {
                          kind,
                          name: name.trim(),
                          host: target.trim(),
                          header: header.trim(),
                          secret: secret.trim(),
                        }
                      : {
                          kind,
                          name: name.trim(),
                          url: target.trim(),
                          ...(secret.trim() === "" ? {} : { secret: secret.trim() }),
                        },
                );
                setCreated(
                  result.kind === "inbound" && result.secret !== null
                    ? { name: result.name, url: result.url, secret: result.secret }
                    : undefined,
                );
                setSecret("");
                setTarget("");
                setCopied("");
                setName("");
                setAdding(false);
              }, "Could not add the connection");
            }}
          >
            <select
              className="field"
              aria-label="Connection kind"
              value={kind}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "inbound" || value === "token" || value === "mcp") {
                  setKind(value);
                  setSecret("");
                  setTarget("");
                }
              }}
            >
              <option value="inbound">Webhook</option>
              <option value="token">API token</option>
              <option value="mcp">MCP server</option>
            </select>
            {kind === "inbound" ? (
              <select
                className="field"
                aria-label="Signature preset"
                value={preset}
                onChange={(event) => {
                  const value = Schema.decodeUnknownOption(SignaturePreset)(event.target.value);
                  if (Option.isSome(value)) {
                    setPreset(value.value);
                    setSecret("");
                  }
                }}
              >
                <option value="standard-webhooks">Standard Webhooks</option>
                <option value="github">GitHub</option>
                <option value="linear">Linear</option>
                <option value="slack">Slack</option>
              </select>
            ) : null}
            <input
              className="field"
              placeholder="name, like sentry"
              aria-label="Connection name"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value.toLowerCase())}
            />
            {kind === "token" || kind === "mcp" ? (
              <>
                <input
                  className="field"
                  aria-label={kind === "token" ? "HTTPS host" : "MCP URL"}
                  placeholder={kind === "token" ? "api.example.com" : "https://example.com/mcp"}
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  autoComplete="off"
                />
                {kind === "token" ? (
                  <input
                    className="field"
                    aria-label="Credential header"
                    placeholder="Authorization: Bearer or X-Api-Key"
                    value={header}
                    onChange={(event) => setHeader(event.target.value)}
                    autoComplete="off"
                  />
                ) : null}
                <input
                  className="field"
                  type="password"
                  aria-label="Connection secret"
                  placeholder={
                    kind === "mcp" ? "Token (optional; leave blank for OAuth)" : "Paste token"
                  }
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="off"
                />
              </>
            ) : null}
            {kind === "inbound" ? (
              <input
                className="field"
                type="password"
                aria-label="Signing secret"
                placeholder="Signing secret (leave blank to generate)"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
              />
            ) : null}
            <button
              type="submit"
              className="button pressable"
              data-tone="primary"
              disabled={
                busy ||
                name.trim() === "" ||
                ((kind === "token" || kind === "mcp") && target.trim() === "") ||
                (kind === "token" && secret.trim() === "") ||
                (kind === "token" && header.trim() === "")
              }
            >
              {busy ? <Spinner size={12} /> : <Icon name="plus" size={13} />}
              Add connection
            </button>
            <button
              type="button"
              className="button pressable"
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </form>
        </div>
      ) : (
        <div className="settings-actions">
          <button type="button" className="button pressable" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
            Add connection
          </button>
        </div>
      )}
      <Problem text={error} />
    </>
  );
}

function McpControls({
  item,
  busy,
  run,
}: {
  item: Extract<Connection, { kind: "mcp" }>;
  busy: boolean;
  run: (action: () => Promise<void>, fallback: string) => Promise<void>;
}) {
  const [mode, setMode] = useState(item.policy.kind);
  const [tools, setTools] = useState(
    item.policy.kind === "named" ? item.policy.tools.join(", ") : "",
  );
  const changed =
    mode !== item.policy.kind ||
    (mode === "named" &&
      tools
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean)
        .join(",") !== (item.policy.kind === "named" ? item.policy.tools.join(",") : ""));
  return (
    <div className="mcp-controls">
      <div className="settings-actions">
        <button
          type="button"
          className="button pressable"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              window.location.assign(await connectMcp(item.name));
            }, "Could not start sign-in")
          }
        >
          {item.signIn === "signed-in" ? "Reconnect" : "Connect"}
        </button>
      </div>
      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () =>
              setToolPolicy(
                item.name,
                mode === "named"
                  ? {
                      kind: mode,
                      tools: tools
                        .split(",")
                        .map((tool) => tool.trim())
                        .filter(Boolean),
                    }
                  : { kind: mode },
              ),
            "Could not save tool policy",
          );
        }}
      >
        <select
          className="field"
          aria-label={`Tool policy for ${item.name}`}
          // The browser must not restore an earlier choice over the stored policy.
          autoComplete="off"
          value={mode}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "all" || value === "read-only" || value === "named") setMode(value);
          }}
        >
          <option value="read-only">Read-only tools</option>
          <option value="all">All tools</option>
          <option value="named">Named tools</option>
        </select>
        {mode === "named" ? (
          <input
            className="field"
            aria-label={`Allowed tools for ${item.name}`}
            autoComplete="off"
            placeholder="list_issues, get_issue"
            value={tools}
            disabled={busy}
            onChange={(event) => setTools(event.target.value)}
          />
        ) : null}
        <button type="submit" className="button pressable" disabled={busy || !changed}>
          Save policy
        </button>
      </form>
    </div>
  );
}

// A shipped blueprint, installed off: the hook URLs are shown first because some senders (Linear)
// issue their signing secret only once the webhook exists.
function Blueprints() {
  const [chosen, setChosen] = useState(blueprints[0]?.name ?? "");
  const [repo, setRepo] = useState("");
  const [targets, setTargets] = useState([{ name: "", repo: "" }]);
  const [agent, setAgent] = useState<"codex" | "claude">("codex");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<Awaited<ReturnType<typeof installBlueprint>>>();
  const [copied, setCopied] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const blueprint = blueprints.find((item) => item.name === chosen);
  const copy = (what: string, text: string) =>
    void navigator.clipboard?.writeText(text).then(() => setCopied(what));
  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(message(failure, fallback));
    } finally {
      setBusy(false);
    }
  }
  if (blueprint === undefined) return null;
  const shared = blueprint.automations.some((automation) => automation.perTarget === undefined);
  const given = targets
    .map((target) => ({ name: target.name.trim(), repo: target.repo.trim() }))
    .filter((target) => target.name !== "" || target.repo !== "");
  const choices = {
    ...(shared ? { repo: repo.trim() } : {}),
    ...(blueprint.targets === undefined ? {} : { targets: given }),
  };
  const setTarget = (at: number, change: Partial<{ name: string; repo: string }>) =>
    setTargets((current) =>
      current.map((target, index) => (index === at ? { ...target, ...change } : target)),
    );
  const hook = (name: string) => `${window.location.origin}/hooks/${name}`;
  if (created !== undefined)
    return (
      <div className="settings-card">
        <p className="settings-intro">
          Installed {blueprint.title} for{" "}
          <span className="mono">
            {[
              ...(choices.repo === undefined ? [] : [choices.repo]),
              ...(choices.targets ?? []).map((target) => `${target.name} → ${target.repo}`),
            ].join(", ")}
          </span>
          , off. Paste each URL and secret where it says, then turn the automations on in{" "}
          <Link to="/automations">Automations</Link>. Generated secrets are shown once.
        </p>
        {created.map((connection) => {
          const secret = connection.kind === "inbound" ? connection.secret : null;
          return (
            <div key={connection.name} className="settings-row secret-row">
              <div className="settings-row-text">
                <div className="settings-row-title">
                  <span className="mono">{connection.name}</span>
                  <span className="quiet settings-size">{connection.kind}</span>
                </div>
                <div className="settings-row-detail mono">
                  {connection.kind === "inbound" ? connection.url : connection.internalUrl}
                </div>
                {secret === null ? null : <div className="settings-row-detail mono">{secret}</div>}
                <div className="settings-row-detail">
                  {blueprint.connections.find((item) => item.name === connection.name)?.setup}
                </div>
              </div>
              <div className="settings-actions">
                {connection.kind === "inbound" ? (
                  <button
                    type="button"
                    className="button pressable"
                    onClick={() => copy(`url:${connection.name}`, connection.url)}
                  >
                    <Icon name={copied === `url:${connection.name}` ? "check" : "copy"} size={13} />
                    Copy URL
                  </button>
                ) : null}
                {secret === null ? null : (
                  <button
                    type="button"
                    className="button pressable"
                    onClick={() => copy(`secret:${connection.name}`, secret)}
                  >
                    <Icon
                      name={copied === `secret:${connection.name}` ? "check" : "copy"}
                      size={13}
                    />
                    Copy secret
                  </button>
                )}
                {connection.kind === "mcp" && connection.signIn !== "signed-in" ? (
                  <button
                    type="button"
                    className="button pressable"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        window.location.assign(await connectMcp(connection.name));
                      }, "Could not start sign-in")
                    }
                  >
                    Connect
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="settings-actions">
          <button
            type="button"
            className="button pressable"
            onClick={() => {
              setCreated(undefined);
              setCopied("");
            }}
          >
            Done
          </button>
        </div>
        <Problem text={error} />
      </div>
    );
  return (
    <div className="settings-card">
      <p className="settings-intro">
        A blueprint adds the connections and automations for one use, all off. Choose the repo and
        agent, paste the secrets it asks for, and install; then paste the URLs where it says and
        turn the automations on.
      </p>
      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            setCreated(await installBlueprint(blueprint, { ...choices, agent, secrets }));
            setSecrets({});
          }, "Could not install the blueprint");
        }}
      >
        <select
          className="field"
          aria-label="Blueprint"
          value={chosen}
          onChange={(event) => {
            setChosen(event.target.value);
            setSecrets({});
          }}
        >
          {blueprints.map((item) => (
            <option key={item.name} value={item.name}>
              {item.title}
            </option>
          ))}
        </select>
        <p className="settings-row-detail">{blueprint.description}</p>
        {blueprint.connections.map((connection) => (
          <div key={connection.name} className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">
                <span className="mono">{connection.name}</span>
                <span className="quiet settings-size">{connection.kind}</span>
              </div>
              {connection.kind === "inbound" ? (
                <div className="settings-row-detail mono">{hook(connection.name)}</div>
              ) : null}
              {connection.setup ? (
                <div className="settings-row-detail">{connection.setup}</div>
              ) : null}
            </div>
            {connection.kind === "inbound" ? (
              <button
                type="button"
                className="button pressable"
                onClick={() => copy(`hook:${connection.name}`, hook(connection.name))}
              >
                <Icon name={copied === `hook:${connection.name}` ? "check" : "copy"} size={13} />
                Copy URL
              </button>
            ) : null}
          </div>
        ))}
        {blueprint.connections.map((connection) =>
          connection.ask ? (
            <input
              key={connection.name}
              className="field"
              type="password"
              aria-label={`Secret for ${connection.name}`}
              placeholder={`${connection.name}: ${connection.ask.prompt}`}
              value={secrets[connection.name] ?? ""}
              onChange={(event) =>
                setSecrets((current) => ({ ...current, [connection.name]: event.target.value }))
              }
              autoComplete="off"
            />
          ) : null,
        )}
        <div className="settings-row-detail">
          Automations: {blueprint.automations.map((automation) => automation.name).join(", ")}
        </div>
        {shared ? (
          <input
            className="field"
            aria-label="Repository"
            placeholder="owner/repo"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            autoComplete="off"
          />
        ) : null}
        {blueprint.targets === undefined ? null : (
          <>
            <p className="settings-row-detail">Targets: {blueprint.targets.ask}</p>
            {targets.map((target, at) => (
              <div key={at} className="token-form">
                <input
                  className="field"
                  aria-label={`Target ${at + 1} name`}
                  placeholder="name"
                  value={target.name}
                  onChange={(event) => setTarget(at, { name: event.target.value })}
                  autoComplete="off"
                />
                <input
                  className="field"
                  aria-label={`Target ${at + 1} repository`}
                  placeholder="owner/repo"
                  value={target.repo}
                  onChange={(event) => setTarget(at, { repo: event.target.value })}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="icon-button pressable"
                  aria-label={`Remove target ${at + 1}`}
                  disabled={targets.length === 1}
                  onClick={() =>
                    setTargets((current) => current.filter((_, index) => index !== at))
                  }
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button pressable"
              onClick={() => setTargets((current) => [...current, { name: "", repo: "" }])}
            >
              <Icon name="plus" size={13} />
              Add target
            </button>
          </>
        )}
        <select
          className="field"
          aria-label="Agent"
          value={agent}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "codex" || value === "claude") setAgent(value);
          }}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
        <button
          type="submit"
          className="button pressable"
          data-tone="primary"
          disabled={
            busy ||
            (shared && repo.trim() === "") ||
            (blueprint.targets !== undefined && given.length === 0) ||
            blueprint.connections.some(
              (connection) =>
                connection.ask !== undefined &&
                connection.ask.optional === undefined &&
                (secrets[connection.name] ?? "").trim() === "",
            )
          }
        >
          {busy ? <Spinner size={12} /> : <Icon name="plus" size={13} />}
          Install, off
        </button>
      </form>
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
