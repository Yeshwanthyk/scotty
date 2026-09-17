import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { Check, GitBranch, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { readRepositories } from "../data/settings";
import {
  buildCreateSessionPayload,
  createSession,
  createSessionIdempotencyKey,
  DEFAULT_HARD_CAP_SECONDS,
  type CreateSessionDraft,
  type CreateSessionFailure,
  type CreateSessionField,
} from "../data/session-creator";
import { colors, motion, spacing } from "../theme/tokens.stylex";

const initialDraft: CreateSessionDraft = {
  title: "",
  repository: "",
  prompt: "",
  hardCapSeconds: "",
};

const styles = stylex.create({
  page: {
    minHeight: "100dvh",
    padding: "clamp(24px, 7vw, 80px) clamp(16px, 6vw, 80px)",
    backgroundColor: colors.space,
  },
  content: {
    width: "min(720px, 100%)",
    marginInline: "auto",
    display: "grid",
    gap: spacing.xxl,
  },
  intro: { display: "grid", gap: spacing.sm },
  heading: {
    margin: 0,
    color: colors.ink,
    fontSize: "28px",
    fontWeight: 720,
    lineHeight: 1.05,
    letterSpacing: "-0.025em",
    textWrap: "balance",
  },
  copy: {
    maxWidth: "56ch",
    margin: 0,
    color: colors.muted,
    fontSize: "14px",
    lineHeight: 1.55,
  },
  fields: { display: "contents", borderWidth: 0, padding: 0, margin: 0 },
  form: {
    display: "grid",
    gap: spacing.xl,
    padding: "clamp(16px, 4vw, 28px)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "12px",
    backgroundColor: colors.panel,
  },
  field: { minWidth: 0, display: "grid", alignContent: "start", gap: spacing.xs },
  label: { color: colors.ink, fontSize: "12px", fontWeight: 650 },
  hint: { margin: 0, color: colors.muted, fontSize: "12px", lineHeight: 1.4 },
  control: {
    width: "100%",
    minHeight: "44px",
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "8px",
    outline: 0,
    backgroundColor: colors.control,
    color: colors.ink,
    fontSize: "14px",
    transitionProperty: "border-color, box-shadow",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.easeOut,
    ":focus": {
      borderColor: colors.focus,
      boxShadow: `0 0 0 2px ${colors.focus}`,
    },
    "::placeholder": { color: colors.muted },
  },
  textarea: { minHeight: "160px", resize: "vertical", lineHeight: 1.5 },
  repositoryList: { display: "grid", gap: spacing.xs, maxHeight: "204px", overflowY: "auto" },
  repositoryOption: {
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: "44px",
    padding: spacing.sm,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: colors.control,
    color: colors.ink,
    cursor: "pointer",
    textAlign: "left",
    ":hover": { backgroundColor: colors.panelRaised },
  },
  repositoryName: { flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: "13px" },
  icon: { width: "16px", height: "16px", flexShrink: 0, color: colors.muted },
  selectedRepository: { display: "flex", alignItems: "center", gap: spacing.sm, minHeight: "44px" },
  optional: { display: "grid", gap: spacing.lg, paddingTop: spacing.lg },
  summary: { color: colors.muted, cursor: "pointer", fontSize: "13px", paddingBlock: spacing.xs },
  footerHint: { margin: 0, marginRight: "auto", color: colors.muted, fontSize: "12px" },
  error: {
    margin: 0,
    padding: spacing.md,
    display: "grid",
    gap: spacing.xs,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.danger,
    borderRadius: "8px",
    backgroundColor: "rgb(207 99 63 / 0.08)",
    color: colors.ink,
    fontSize: "13px",
    lineHeight: 1.45,
  },
  errorCode: { color: colors.danger, fontSize: "11px", fontWeight: 700 },
  fieldError: { margin: 0, color: colors.danger, fontSize: "11px", lineHeight: 1.4 },
  actions: {
    display: "flex",
    flexWrap: "wrap-reverse",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.lineSoft,
    "@media (max-width: 420px)": {
      display: "grid",
      gridTemplateColumns: "1fr",
    },
  },
  actionButton: { "@media (max-width: 420px)": { width: "100%" } },
  busyIcon: {
    width: "15px",
    height: "15px",
    strokeWidth: 1.8,
    animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
});

interface DraftFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly field: CreateSessionField;
  readonly error?: string;
  readonly hint?: string;
  readonly onChange: (value: string) => void;
}

function DraftField({ error, field, hint, id, label, onChange, value }: DraftFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div {...stylex.props(styles.field)}>
      <label htmlFor={id} {...stylex.props(styles.label)}>
        {label}
      </label>
      <input
        id={id}
        name={field === "repository" ? "repo" : field}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-invalid={error !== undefined}
        aria-describedby={error ? errorId : undefined}
        {...stylex.props(styles.control)}
      />
      {error ? (
        <p id={errorId} {...stylex.props(styles.fieldError)}>
          {error}
        </p>
      ) : hint ? (
        <p {...stylex.props(styles.hint)}>{hint}</p>
      ) : null}
    </div>
  );
}

const failureCode = (failure: CreateSessionFailure): string | undefined =>
  failure.kind === "http" && failure.code !== undefined ? failure.code : undefined;

export function CreateSessionForm({
  recentRepositories = [],
}: {
  readonly recentRepositories?: ReadonlyArray<string>;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(initialDraft);
  const [repositories, setRepositories] = useState<ReadonlyArray<string>>([]);
  const [repositoryStatus, setRepositoryStatus] = useState("Loading repositories…");
  const [repositorySelected, setRepositorySelected] = useState(false);
  const repositoryInputRef = useRef<HTMLInputElement>(null);
  const repositoryListRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) repositoryInputRef.current?.focus();
    const controller = new AbortController();
    void readRepositories({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setRepositories(
          [...result.value]
            .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
            .map((entry) => entry.repo),
        );
        setRepositoryStatus(
          result.value.length ? "" : "Enter a repository as owner/name to get started.",
        );
      } else
        setRepositoryStatus(
          "Repository list unavailable. Choose a recent repository or enter owner/name.",
        );
    });
    return () => controller.abort();
  }, []);
  const choices = [...new Set([...repositories, ...recentRepositories])];
  const matchingRepositories = choices.filter((repo) =>
    repo.toLocaleLowerCase().includes(draft.repository.trim().toLocaleLowerCase()),
  );
  const [fieldError, setFieldError] = useState<
    { readonly field: CreateSessionField; readonly message: string } | undefined
  >();
  const [failure, setFailure] = useState<CreateSessionFailure | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef<string | undefined>(undefined);

  const updateDraft = (field: keyof CreateSessionDraft, value: string) => {
    idempotencyKeyRef.current = undefined;
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldError((current) => (current?.field === field ? undefined : current));
    setFailure(undefined);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const parsed = buildCreateSessionPayload({
      ...draft,
      title:
        draft.title.trim() ||
        draft.prompt.trim().split(/\r?\n/u)[0]?.slice(0, 120) ||
        "New session",
    });
    if (!parsed.ok) {
      setFieldError({ field: parsed.field, message: parsed.message });
      setFailure(undefined);
      const fieldId = {
        title: "session-title",
        repository: "session-repository",
        prompt: "session-prompt",
        hardCapSeconds: "session-cap",
      }[parsed.field];
      if (parsed.field === "repository") setRepositorySelected(false);
      requestAnimationFrame(() => {
        const field = document.getElementById(fieldId);
        const details = field?.closest("details");
        if (details) details.open = true;
        field?.focus();
      });
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFieldError(undefined);
    setFailure(undefined);
    try {
      const idempotencyKey = idempotencyKeyRef.current ?? createSessionIdempotencyKey();
      idempotencyKeyRef.current = idempotencyKey;
      const result = await createSession(parsed.payload, { idempotencyKey });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      idempotencyKeyRef.current = undefined;
      await navigate({ to: "/s/$sessionId", params: { sessionId: result.session.id } });
    } catch {
      setFailure({ kind: "network", message: "Scotty could not be reached." });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const errorFor = (field: CreateSessionField): string | undefined =>
    fieldError?.field === field ? fieldError.message : undefined;

  return (
    <section aria-labelledby="create-session-heading" {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.content)}>
        <header {...stylex.props(styles.intro)}>
          <h1 id="create-session-heading" {...stylex.props(styles.heading)}>
            New session
          </h1>
          <p {...stylex.props(styles.copy)}>Pick a repository. Tell Codex what to do.</p>
        </header>

        <form
          noValidate
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          aria-busy={submitting}
          onSubmit={(event) => void submit(event)}
          {...stylex.props(styles.form)}
        >
          <fieldset disabled={submitting} {...stylex.props(styles.fields)}>
            <div {...stylex.props(styles.field)}>
              <label htmlFor="session-repository" {...stylex.props(styles.label)}>
                Repository
              </label>
              {repositorySelected ? (
                <div {...stylex.props(styles.selectedRepository)}>
                  <GitBranch aria-hidden {...stylex.props(styles.icon)} />
                  <span {...stylex.props(styles.repositoryName)}>{draft.repository}</span>
                  <Check aria-hidden {...stylex.props(styles.icon)} />
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={submitting}
                    onClick={() => {
                      setRepositorySelected(false);
                      updateDraft("repository", "");
                      requestAnimationFrame(() => repositoryInputRef.current?.focus());
                    }}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <>
                  <input
                    ref={repositoryInputRef}
                    id="session-repository"
                    name="repo"
                    autoComplete="off"
                    placeholder="Search or enter owner/name"
                    value={draft.repository}
                    disabled={submitting}
                    aria-invalid={errorFor("repository") !== undefined}
                    aria-describedby={
                      errorFor("repository") ? "session-repository-error" : "repository-help"
                    }
                    onChange={(event) => updateDraft("repository", event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        repositoryListRef.current?.querySelector("button")?.focus();
                      }
                      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                        event.preventDefault();
                        const first = matchingRepositories[0];
                        if (first) updateDraft("repository", first);
                        if (first || draft.repository.trim()) {
                          setRepositorySelected(true);
                          promptRef.current?.focus();
                        }
                      }
                    }}
                    {...stylex.props(styles.control)}
                  />
                  <p id="repository-help" {...stylex.props(styles.hint)}>
                    {repositoryStatus || "Select a repository, or enter another owner/name."}
                  </p>
                  <div
                    ref={repositoryListRef}
                    aria-label="Repository suggestions"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        repositoryInputRef.current?.focus();
                        return;
                      }
                      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                      const buttons = [...event.currentTarget.querySelectorAll("button")];
                      const current = buttons.findIndex(
                        (button) => button === document.activeElement,
                      );
                      if (current < 0) return;
                      event.preventDefault();
                      buttons[
                        (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                          buttons.length
                      ]?.focus();
                    }}
                    {...stylex.props(styles.repositoryList)}
                  >
                    {matchingRepositories.map((repo) => (
                      <button
                        key={repo}
                        type="button"
                        disabled={submitting}
                        onClick={() => {
                          updateDraft("repository", repo);
                          setRepositorySelected(true);
                          promptRef.current?.focus();
                        }}
                        {...stylex.props(styles.repositoryOption)}
                      >
                        <GitBranch aria-hidden {...stylex.props(styles.icon)} />
                        <span {...stylex.props(styles.repositoryName)}>{repo}</span>
                        <span {...stylex.props(styles.hint)}>Select</span>
                      </button>
                    ))}
                  </div>
                  {matchingRepositories.length === 0 && draft.repository.trim() ? (
                    <p {...stylex.props(styles.hint)}>
                      Use the repository above to start your session.
                    </p>
                  ) : null}
                </>
              )}
              {errorFor("repository") ? (
                <p id="session-repository-error" {...stylex.props(styles.fieldError)}>
                  {errorFor("repository")}
                </p>
              ) : null}
            </div>

            <div {...stylex.props(styles.field)}>
              <label htmlFor="session-prompt" {...stylex.props(styles.label)}>
                What would you like to do?
              </label>
              <textarea
                ref={promptRef}
                disabled={submitting}
                id="session-prompt"
                name="prompt"
                value={draft.prompt}
                onChange={(event) => updateDraft("prompt", event.currentTarget.value)}
                placeholder="Describe the outcome and how to verify it."
                aria-invalid={errorFor("prompt") !== undefined}
                aria-describedby={errorFor("prompt") ? "session-prompt-error" : undefined}
                {...stylex.props(styles.control, styles.textarea)}
              />
              {errorFor("prompt") ? (
                <p id="session-prompt-error" {...stylex.props(styles.fieldError)}>
                  {errorFor("prompt")}
                </p>
              ) : null}
            </div>

            <details>
              <summary {...stylex.props(styles.summary)}>
                Session options <span {...stylex.props(styles.hint)}>· title & time limit</span>
              </summary>
              <div {...stylex.props(styles.optional)}>
                <DraftField
                  id="session-title"
                  label="Title (optional)"
                  field="title"
                  value={draft.title}
                  error={errorFor("title")}
                  hint="Uses the first line of your task when left blank."
                  onChange={(value) => updateDraft("title", value)}
                />
                <div {...stylex.props(styles.field)}>
                  <label htmlFor="session-cap" {...stylex.props(styles.label)}>
                    Time limit <span {...stylex.props(styles.hint)}>(optional)</span>
                  </label>
                  <select
                    id="session-cap"
                    name="hardCapSeconds"
                    value={draft.hardCapSeconds ?? ""}
                    onChange={(event) => updateDraft("hardCapSeconds", event.currentTarget.value)}
                    aria-invalid={errorFor("hardCapSeconds") !== undefined}
                    aria-describedby={errorFor("hardCapSeconds") ? "session-cap-error" : undefined}
                    {...stylex.props(styles.control)}
                  >
                    <option value="">Default · {DEFAULT_HARD_CAP_SECONDS / 3_600} hours</option>
                    <option value="3600">1 hour</option>
                    <option value="14400">4 hours</option>
                    <option value="28800">8 hours</option>
                    <option value="43200">12 hours</option>
                    <option value="86400">24 hours</option>
                  </select>
                  {errorFor("hardCapSeconds") ? (
                    <p id="session-cap-error" {...stylex.props(styles.fieldError)}>
                      {errorFor("hardCapSeconds")}
                    </p>
                  ) : null}
                </div>
              </div>
            </details>

            {failure ? (
              <div role="alert" {...stylex.props(styles.error)}>
                <strong>{failure.message}</strong>
                {failureCode(failure) ? (
                  <span {...stylex.props(styles.errorCode)}>{failureCode(failure)}</span>
                ) : null}
                {failure.kind === "http" && failure.hint ? <span>{failure.hint}</span> : null}
              </div>
            ) : null}

            <footer {...stylex.props(styles.actions)}>
              <p {...stylex.props(styles.footerHint)}>
                Codex · Cloudflare ·{" "}
                {Number(draft.hardCapSeconds || DEFAULT_HARD_CAP_SECONDS) / 3600}
                h limit
              </p>
              <Button
                type="button"
                variant="quiet"
                disabled={submitting}
                onClick={() => void navigate({ to: "/sessions" })}
                {...stylex.props(styles.actionButton)}
              >
                Cancel
              </Button>
              <Button
                title="Start session (⌘Enter / Ctrl+Enter)"
                aria-keyshortcuts="Meta+Enter Control+Enter"
                type="submit"
                variant="primary"
                disabled={submitting}
                {...stylex.props(styles.actionButton)}
              >
                {submitting ? (
                  <LoaderCircle aria-hidden {...stylex.props(styles.busyIcon)} />
                ) : null}
                {submitting ? "Starting session…" : "Start session"}
              </Button>
            </footer>
          </fieldset>
        </form>
      </div>
    </section>
  );
}
