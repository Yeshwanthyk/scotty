import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { Cloud, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "./Button";
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
  eyebrow: {
    margin: 0,
    color: colors.accentStrong,
    fontSize: "11px",
    fontWeight: 750,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
  },
  heading: {
    margin: 0,
    color: colors.ink,
    fontSize: "clamp(28px, 5vw, 44px)",
    fontWeight: 720,
    lineHeight: 1.05,
    letterSpacing: "-0.045em",
    textWrap: "balance",
  },
  copy: {
    maxWidth: "56ch",
    margin: 0,
    color: colors.muted,
    fontSize: "14px",
    lineHeight: 1.55,
  },
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
  fieldGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: spacing.lg,
    "@media (max-width: 620px)": { gridTemplateColumns: "1fr" },
  },
  field: { minWidth: 0, display: "grid", alignContent: "start", gap: spacing.xs },
  label: { color: colors.ink, fontSize: "12px", fontWeight: 650 },
  hint: { margin: 0, color: colors.quiet, fontSize: "11px", lineHeight: 1.4 },
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
    "::placeholder": { color: colors.quiet },
  },
  textarea: { minHeight: "160px", resize: "vertical", lineHeight: 1.5 },
  provider: {
    minHeight: "44px",
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.lineSoft,
    borderRadius: "8px",
    backgroundColor: colors.control,
    color: colors.muted,
    fontSize: "13px",
  },
  providerIcon: { width: "15px", height: "15px", color: colors.focus, strokeWidth: 1.8 },
  providerName: { color: colors.ink, fontWeight: 650 },
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

export function CreateSessionForm() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(initialDraft);
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
    const parsed = buildCreateSessionPayload(draft);
    if (!parsed.ok) {
      setFieldError({ field: parsed.field, message: parsed.message });
      setFailure(undefined);
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
          <p {...stylex.props(styles.eyebrow)}>New workspace</p>
          <h1 id="create-session-heading" {...stylex.props(styles.heading)}>
            Create a session
          </h1>
          <p {...stylex.props(styles.copy)}>Choose a repository and give Codex its first task.</p>
        </header>

        <form
          noValidate
          aria-busy={submitting}
          onSubmit={(event) => void submit(event)}
          {...stylex.props(styles.form)}
        >
          <div {...stylex.props(styles.fieldGrid)}>
            <DraftField
              id="session-title"
              label="Title"
              field="title"
              value={draft.title}
              error={errorFor("title")}
              hint="A short name you will recognize later."
              onChange={(value) => updateDraft("title", value)}
            />
            <DraftField
              id="session-repository"
              label="Repository"
              field="repository"
              value={draft.repository}
              error={errorFor("repository")}
              hint="owner/name"
              onChange={(value) => updateDraft("repository", value)}
            />
          </div>

          <div {...stylex.props(styles.field)}>
            <span id="session-provider-label" {...stylex.props(styles.label)}>
              Provider
            </span>
            <div
              role="group"
              aria-labelledby="session-provider-label"
              {...stylex.props(styles.provider)}
            >
              <Cloud aria-hidden {...stylex.props(styles.providerIcon)} />
              <span {...stylex.props(styles.providerName)}>Cloudflare</span>
              <input type="hidden" name="provider" value="cloudflare" />
            </div>
          </div>

          <div {...stylex.props(styles.field)}>
            <label htmlFor="session-prompt" {...stylex.props(styles.label)}>
              Prompt
            </label>
            <textarea
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
              type="submit"
              variant="primary"
              disabled={submitting}
              {...stylex.props(styles.actionButton)}
            >
              {submitting ? <LoaderCircle aria-hidden {...stylex.props(styles.busyIcon)} /> : null}
              {submitting ? "Starting…" : "Start session"}
            </Button>
          </footer>
        </form>
      </div>
    </section>
  );
}
