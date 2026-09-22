import * as stylex from "@stylexjs/stylex";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readConversation, type ConversationSnapshot } from "../data/conversation-client";
import {
  type ChangedFile,
  type ChangedFilePatch,
  type EvidenceSummary,
  type HatchSummary,
  readChangedFilePatch,
  readChangedFiles,
  readEvidence,
  readHatch,
} from "../data/session-workbench";
import { colors, motion, spacing } from "../theme/tokens.stylex";
import type { ConversationTurn } from "../domain/conversation";
import { Markdown } from "./Markdown";
import { publishUnlessAborted, startVisibilityPolling } from "../data/visibility-polling";

const PierreDiff = lazy(() => import("./PierreDiff"));
const TerminalView = lazy(() => import("./Terminal"));

const styles = stylex.create({
  root: {
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    overflow: "hidden",
  },
  sessionToolsMenu: {
    marginBottom: spacing.sm,
    paddingBottom: spacing.sm,
    display: "grid",
    gap: "2px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  toolButton: {
    minHeight: "30px",
    paddingInline: "9px",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    borderWidth: 0,
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: colors.quiet,
    fontSize: "11px",
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: motion.fast,
    ":hover": { backgroundColor: "rgb(255 255 255 / 0.05)", color: colors.ink },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "2px" },
    ":disabled": { cursor: "not-allowed", opacity: 0.42 },
    "@media (max-width: 760px)": { minHeight: "44px", paddingInline: "8px" },
    "@media (max-width: 360px)": { paddingInline: "4px" },
  },
  toolButtonActive: { color: colors.ink, fontWeight: 650 },
  icon: { width: "13px", height: "13px", strokeWidth: 1.8 },
  stage: { minHeight: 0, display: "grid", overflow: "hidden" },
  main: { minWidth: 0, minHeight: 0, overflow: "hidden" },
  toolView: {
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    backgroundColor: colors.shell,
    animationName: stylex.keyframes({
      from: { opacity: 0 },
      to: { opacity: 1 },
    }),
    animationDuration: motion.fast,
    animationTimingFunction: motion.easeOut,
  },
  toolViewHeader: {
    minHeight: "44px",
    paddingInline: spacing.md,
    display: "flex",
    alignItems: "center",
    gap: spacing.md,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
    backgroundColor: colors.shell,
    "@media (max-width: 760px)": { minHeight: "48px" },
  },
  back: {
    minHeight: "36px",
    paddingInline: "4px",
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 0,
    borderRadius: "4px",
    backgroundColor: "transparent",
    color: colors.muted,
    fontFamily: "inherit",
    fontSize: "12px",
    fontWeight: 500,
    order: -1,
    cursor: "pointer",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "2px" },
    "@media (max-width: 760px)": { minHeight: "44px" },
  },
  panelTitle: {
    margin: 0,
    color: colors.ink,
    fontSize: "13px",
    fontWeight: 600,
    outline: "none",
  },
  toolViewBody: { minWidth: 0, minHeight: 0, overflow: "hidden" },
  toolViewBodyScroll: { overflowX: "hidden", overflowY: "auto", padding: spacing.xl },
  summaryStack: { minWidth: 0, display: "grid", gap: spacing.xl },
  section: {
    minWidth: 0,
    display: "grid",
    gap: spacing.md,
    paddingBottom: spacing.xl,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
  },
  eyebrow: {
    color: colors.quiet,
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  sectionTitle: { margin: 0, color: colors.ink, fontSize: "13px", fontWeight: 650 },
  muted: {
    margin: 0,
    color: colors.muted,
    fontSize: "12px",
    lineHeight: 1.55,
    overflowWrap: "anywhere",
  },
  hatchLine: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  status: { color: colors.success, fontSize: "11px" },
  evidenceGrid: { display: "grid", gap: spacing.md },
  evidenceCard: {
    padding: spacing.md,
    display: "grid",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.lineSoft,
    borderRadius: "8px",
    color: "inherit",
    textDecoration: "none",
    ":hover": { borderColor: colors.lineHover, backgroundColor: "rgb(255 255 255 / 0.025)" },
  },
  evidenceMeta: {
    display: "flex",
    justifyContent: "space-between",
    gap: spacing.md,
    color: colors.quiet,
    fontSize: "10px",
  },
  evidenceFrames: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "minmax(0, 1fr)",
    gap: "4px",
    overflow: "hidden",
    borderRadius: "6px",
  },
  evidenceFrame: {
    width: "100%",
    aspectRatio: "16 / 10",
    display: "block",
    objectFit: "cover",
    backgroundColor: colors.space,
  },
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    color: colors.ink,
    fontSize: "11px",
    textDecoration: "none",
  },
  loading: { minHeight: "160px", display: "grid", placeItems: "center", color: colors.quiet },
  spin: {
    animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  changes: {
    height: "100%",
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "minmax(160px, 220px) minmax(0, 1fr)",
    overflow: "hidden",
    "@media (max-width: 760px)": {
      gridTemplateColumns: "1fr",
      gridTemplateRows: "auto minmax(0, 1fr)",
    },
  },
  fileList: {
    minHeight: 0,
    overflowY: "auto",
    padding: spacing.sm,
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderRightColor: colors.lineSoft,
    "@media (max-width: 760px)": {
      display: "flex",
      overflowX: "auto",
      overflowY: "hidden",
      borderRightWidth: 0,
      borderBottomWidth: "1px",
      borderBottomStyle: "solid",
      borderBottomColor: colors.lineSoft,
    },
  },
  fileButton: {
    width: "100%",
    padding: "9px 10px",
    display: "grid",
    gap: "3px",
    borderWidth: 0,
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: colors.muted,
    textAlign: "left",
    cursor: "pointer",
    ":hover": { backgroundColor: "rgb(255 255 255 / 0.04)", color: colors.ink },
    "@media (max-width: 760px)": { width: "auto", minWidth: "180px", flex: "0 0 auto" },
  },
  fileButtonActive: { color: colors.ink, fontWeight: 650 },
  filePath: {
    overflow: "hidden",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileMeta: { color: colors.quiet, fontSize: "10px" },
  diffPanel: {
    minWidth: 0,
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
  },
  diffControls: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px",
    padding: "4px 10px",
  },
  diffControl: {
    minHeight: "36px",
    paddingInline: "7px",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: "transparent",
    color: colors.quiet,
    fontFamily: "inherit",
    fontSize: "12px",
    cursor: "pointer",
    ":hover": { backgroundColor: "rgb(255 255 255 / 0.04)", color: colors.ink },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "-2px" },
    "@media (max-width: 760px)": { minHeight: "44px", paddingInline: "7px" },
  },
  diffControlActive: { color: colors.ink, fontWeight: 650 },
  diffToggle: {
    minHeight: "36px",
    paddingInline: "7px",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: colors.quiet,
    fontSize: "12px",
    cursor: "pointer",
    "@media (max-width: 760px)": { minHeight: "44px" },
  },
  patch: {
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
    margin: 0,
    padding: spacing.sm,
    backgroundColor: "#080808",
    color: colors.muted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    lineHeight: 1.55,
  },
});

export function SessionWorkbench({
  previewTurns,
  defaultBranch,
  children,
  runtimeAvailable,
  sessionId,
}: {
  readonly previewTurns?: ReadonlyArray<ConversationTurn>;
  readonly defaultBranch: string | null;
  readonly children: ReactNode;
  readonly runtimeAvailable: boolean;
  readonly sessionId: string;
}) {
  const [activeTool, setActiveTool] = useState<"summary" | "diff" | "terminal" | null>(null);
  const [sessionActionsTarget, setSessionActionsTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSessionActionsTarget(document.getElementById("session-workbench-actions"));
  }, []);
  useEffect(() => {
    if (activeTool === null) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveTool(null);
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(".session-menu > summary")?.focus();
        });
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [activeTool]);
  const closeTool = (): void => {
    setActiveTool(null);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".session-menu > summary")?.focus();
    });
  };
  return (
    <div data-design="workbench" {...stylex.props(styles.root)}>
      {sessionActionsTarget === null
        ? null
        : createPortal(
            <nav aria-label="Session tools" {...stylex.props(styles.sessionToolsMenu)}>
              <ToolButton
                active={activeTool === "summary"}
                label="Summary"
                onClick={() => setActiveTool((tool) => (tool === "summary" ? null : "summary"))}
              />
              <ToolButton
                active={activeTool === "diff"}
                label="Diff"
                onClick={() => setActiveTool((tool) => (tool === "diff" ? null : "diff"))}
              />
              <ToolButton
                active={activeTool === "terminal"}
                disabled={!runtimeAvailable || previewTurns !== undefined}
                label="Terminal"
                onClick={() => setActiveTool((tool) => (tool === "terminal" ? null : "terminal"))}
              />
            </nav>,
            sessionActionsTarget,
          )}
      <div data-design="workbench-stage" {...stylex.props(styles.stage)}>
        <div hidden={activeTool !== null} {...stylex.props(styles.main)}>
          {children}
        </div>
        {activeTool === "summary" ? (
          <ToolView close={closeTool} title="Summary" scroll>
            <SummaryContent key={sessionId} previewTurns={previewTurns} sessionId={sessionId} />
          </ToolView>
        ) : activeTool === "diff" ? (
          <ToolView
            close={closeTool}
            title={defaultBranch === null ? "Diff" : `Diff · ${defaultBranch}`}
          >
            <ChangesView
              sessionId={sessionId}
              preview={previewTurns !== undefined}
              defaultBranch={defaultBranch}
            />
          </ToolView>
        ) : activeTool === "terminal" ? (
          <ToolView close={closeTool} title="Terminal">
            <Suspense fallback={<p role="status">Loading terminal…</p>}>
              <TerminalView sessionId={sessionId} />
            </Suspense>
          </ToolView>
        ) : null}
      </div>
    </div>
  );
}

function ToolButton({
  active,
  disabled = false,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      disabled={disabled}
      onClick={(event) => {
        onClick();
        const menu = event.currentTarget.closest("details");
        if (menu !== null) menu.open = false;
      }}
      type="button"
      {...stylex.props(styles.toolButton, active && styles.toolButtonActive)}
    >
      {label}
    </button>
  );
}

function ToolView({
  children,
  close,
  scroll = false,
  title,
}: {
  readonly children: ReactNode;
  readonly close: () => void;
  readonly scroll?: boolean;
  readonly title: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section aria-label={`${title} tool`} {...stylex.props(styles.toolView)}>
      <header {...stylex.props(styles.toolViewHeader)}>
        <h2 ref={heading} tabIndex={-1} {...stylex.props(styles.panelTitle)}>
          {title}
        </h2>
        <button
          aria-label="Back to conversation"
          onClick={close}
          type="button"
          {...stylex.props(styles.back)}
        >
          <ArrowLeft aria-hidden {...stylex.props(styles.icon)} />
          Conversation
        </button>
      </header>
      <div {...stylex.props(styles.toolViewBody, scroll && styles.toolViewBodyScroll)}>
        {children}
      </div>
    </section>
  );
}

function SummaryContent({
  previewTurns,
  sessionId,
}: {
  readonly previewTurns?: ReadonlyArray<ConversationTurn>;
  readonly sessionId: string;
}) {
  const [state, setState] = useState<{
    snapshot?: ConversationSnapshot;
    evidence?: ReadonlyArray<EvidenceSummary>;
    hatch?: HatchSummary;
    conversationError?: string;
    evidenceError?: string;
    hatchError?: string;
  }>({});
  useEffect(() => {
    if (previewTurns !== undefined) return;
    const polling = startVisibilityPolling(document, async (signal) => {
      const conversationRequest = readConversation(sessionId, { signal }).then((conversation) => {
        if (signal.aborted) return;
        setState((current) =>
          conversation.ok
            ? { ...current, snapshot: conversation.snapshot, conversationError: undefined }
            : { ...current, conversationError: conversation.failure.message },
        );
      });
      const evidenceRequest = readEvidence(sessionId, signal).then(
        (evidence) => {
          if (!signal.aborted)
            setState((current) => ({ ...current, evidence, evidenceError: undefined }));
        },
        (error: unknown) => {
          if (!signal.aborted)
            setState((current) => ({
              ...current,
              evidenceError: error instanceof Error ? error.message : "Evidence unavailable",
            }));
        },
      );
      const hatchRequest = readHatch(sessionId, signal).then(
        (hatch) => {
          if (!signal.aborted)
            setState((current) => ({ ...current, hatch, hatchError: undefined }));
        },
        (error: unknown) => {
          if (!signal.aborted)
            setState((current) => ({
              ...current,
              hatchError: error instanceof Error ? error.message : "Hatch unavailable",
            }));
        },
      );
      await Promise.all([conversationRequest, evidenceRequest, hatchRequest]);
      return 5_000;
    });
    return polling.stop;
  }, [sessionId, previewTurns]);
  const latest = (previewTurns ?? state.snapshot?.turns)?.findLast(
    (turn) => turn.assistant.trim().length > 0,
  );
  return (
    <div aria-label="Session summary" {...stylex.props(styles.summaryStack)}>
      <section {...stylex.props(styles.section)}>
        <span {...stylex.props(styles.eyebrow)}>Latest update</span>
        {state.conversationError !== undefined ? (
          <p role="alert" {...stylex.props(styles.muted)}>
            {state.conversationError}
          </p>
        ) : state.snapshot === undefined && previewTurns === undefined ? (
          <LoaderCircle
            aria-label="Loading latest update"
            {...stylex.props(styles.icon, styles.spin)}
          />
        ) : latest === undefined ? (
          <p {...stylex.props(styles.muted)}>No completed update yet.</p>
        ) : (
          <Markdown
            source={latest.assistant}
            sessionId={sessionId}
            evidence={
              state.evidenceError !== undefined
                ? { kind: "error", sessionId, message: state.evidenceError }
                : state.evidence === undefined
                  ? { kind: "loading", sessionId }
                  : { kind: "ready", sessionId, evidence: state.evidence }
            }
          />
        )}
      </section>
      {previewTurns ? (
        <section {...stylex.props(styles.section)}>
          <span {...stylex.props(styles.eyebrow)}>Local preview</span>
          <p {...stylex.props(styles.muted)}>
            Summary text comes from the conversation fixture. Browser evidence and workspace
            services are not connected.
          </p>
        </section>
      ) : (
        <>
          <HatchSection error={state.hatchError} hatch={state.hatch} sessionId={sessionId} />
          <EvidenceSection
            error={state.evidenceError}
            evidence={state.evidence}
            sessionId={sessionId}
          />
        </>
      )}
    </div>
  );
}

function HatchSection({
  error,
  hatch,
  sessionId,
}: {
  readonly error: string | undefined;
  readonly hatch: HatchSummary | undefined;
  readonly sessionId: string;
}) {
  return (
    <section {...stylex.props(styles.section)}>
      <span {...stylex.props(styles.eyebrow)}>Hatch</span>
      {error !== undefined ? (
        <p role="alert" {...stylex.props(styles.muted)}>
          {error}
        </p>
      ) : (
        <div {...stylex.props(styles.hatchLine)}>
          <div>
            <h3 {...stylex.props(styles.sectionTitle)}>
              {hatch?.startupFailure
                ? "Startup failed"
                : hatch?.configured
                  ? (hatch.serviceName ?? "Application service")
                  : "Not configured"}
            </h3>
            <p {...stylex.props(styles.muted)}>
              {hatch?.startupFailure
                ? `Hatch failed: ${hatch.startupFailure.replaceAll("_", " ")}. Review the Hatch tool result for diagnostics.`
                : hatch?.configured
                  ? (hatch.status ?? "Unknown")
                  : "No application service is attached to this session."}
            </p>
          </div>
          {hatch?.available ? (
            <a
              href={`/s/${encodeURIComponent(sessionId)}/hatch/open`}
              target="_blank"
              rel="noreferrer"
              {...stylex.props(styles.link)}
            >
              Open <ExternalLink aria-hidden {...stylex.props(styles.icon)} />
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}

function EvidenceSection({
  error,
  evidence,
  sessionId,
}: {
  readonly error: string | undefined;
  readonly evidence: ReadonlyArray<EvidenceSummary> | undefined;
  readonly sessionId: string;
}) {
  return (
    <section {...stylex.props(styles.section)}>
      <span {...stylex.props(styles.eyebrow)}>Evidence</span>
      <h3 {...stylex.props(styles.sectionTitle)}>
        {evidence === undefined
          ? "Checking browser evidence"
          : evidence.length === 0
            ? "No browser evidence"
            : `${evidence.length} captured run${evidence.length === 1 ? "" : "s"}`}
      </h3>
      {error !== undefined ? (
        <p role="alert" {...stylex.props(styles.muted)}>
          {error}
        </p>
      ) : evidence === undefined ? (
        <LoaderCircle aria-label="Loading evidence" {...stylex.props(styles.icon, styles.spin)} />
      ) : evidence.length === 0 ? (
        <p {...stylex.props(styles.muted)}>
          Screenshots and recordings will appear here after a verified browser run.
        </p>
      ) : (
        <div {...stylex.props(styles.evidenceGrid)}>
          {evidence
            .slice(-4)
            .reverse()
            .map((job) => (
              <a
                key={job.jobId}
                href={`/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(job.jobId)}`}
                target="_blank"
                rel="noreferrer"
                {...stylex.props(styles.evidenceCard)}
              >
                <div {...stylex.props(styles.evidenceMeta)}>
                  <span>{job.status}</span>
                  <span>
                    {job.completedSteps}/{job.totalSteps} steps
                  </span>
                </div>
                {job.steps.some((step) => step.frameId !== undefined) ? (
                  <div {...stylex.props(styles.evidenceFrames)}>
                    {job.steps
                      .filter(
                        (step): step is typeof step & { readonly frameId: string } =>
                          step.frameId !== undefined,
                      )
                      .slice(-3)
                      .map((step) => (
                        <img
                          alt={`${step.name} browser evidence`}
                          key={step.frameId}
                          loading="lazy"
                          src={`/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(job.jobId)}/frames/${encodeURIComponent(step.frameId)}.png`}
                          {...stylex.props(styles.evidenceFrame)}
                        />
                      ))}
                  </div>
                ) : null}
                <span {...stylex.props(styles.link)}>
                  <FlaskConical aria-hidden {...stylex.props(styles.icon)} />
                  {job.videoAvailable ? "Evidence + recording" : "Browser evidence"}
                  <ChevronRight aria-hidden {...stylex.props(styles.icon)} />
                </span>
              </a>
            ))}
        </div>
      )}
    </section>
  );
}

const previewPatch: ChangedFilePatch = {
  path: "src/greeting.ts",
  status: "modified",
  staged: false,
  unstaged: true,
  additions: 2,
  deletions: 2,
  binary: false,
  patchable: true,
  truncated: false,
  patch:
    "diff --git a/src/greeting.ts b/src/greeting.ts\n--- a/src/greeting.ts\n+++ b/src/greeting.ts\n@@ -1,4 +1,4 @@\n export function greeting(name: string) {\n-  const message = `Hello, ${name}`;\n-  return message;\n+  const message = `Welcome, ${name}!`;\n+  return message.trim();\n }\n",
};

function ChangesView({
  sessionId,
  preview,
  defaultBranch,
}: {
  readonly sessionId: string;
  readonly preview: boolean;
  readonly defaultBranch: string | null;
}) {
  const comparison = defaultBranch ?? "the default branch";
  const [refresh, setRefresh] = useState(0);
  const [split, setSplit] = useState(false);
  const [words, setWords] = useState(true);
  const [files, setFiles] = useState<ReadonlyArray<ChangedFile>>();
  const [selected, setSelected] = useState<ChangedFile>();
  const [patch, setPatch] = useState<ChangedFilePatch>();
  const [error, setError] = useState<string>();
  const load = (): void => setRefresh((value) => value + 1);
  useEffect(() => {
    setError(undefined);
    if (preview) {
      setFiles([previewPatch]);
      setSelected(previewPatch);
      return;
    }
    const controller = new AbortController();
    setFiles(undefined);
    void readChangedFiles(sessionId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setFiles(next);
        setSelected(
          (current) =>
            next.find((file) => file.path === current?.path) ??
            next.find((file) => file.patchable) ??
            next[0],
        );
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Changes unavailable");
      });
    return () => controller.abort();
  }, [sessionId, preview, refresh]);
  useEffect(() => {
    if (selected === undefined || !selected.patchable) {
      setPatch(undefined);
      return;
    }
    if (preview) {
      setPatch(previewPatch);
      return;
    }
    const controller = new AbortController();
    setPatch(undefined);
    void readChangedFilePatch(sessionId, selected, controller.signal)
      .then((nextPatch) => publishUnlessAborted(controller.signal, nextPatch, setPatch))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Patch unavailable");
      });
    return () => controller.abort();
  }, [selected, sessionId, preview]);
  if (error !== undefined)
    return (
      <div {...stylex.props(styles.loading)}>
        <p role="alert" {...stylex.props(styles.muted)}>
          {error}
        </p>
        <button onClick={load} type="button" {...stylex.props(styles.toolButton)}>
          <RefreshCw aria-hidden {...stylex.props(styles.icon)} />
          Retry
        </button>
      </div>
    );
  if (files === undefined)
    return (
      <div {...stylex.props(styles.loading)}>
        <LoaderCircle aria-hidden {...stylex.props(styles.icon, styles.spin)} />
      </div>
    );
  if (files.length === 0)
    return (
      <div {...stylex.props(styles.loading)}>
        <p {...stylex.props(styles.muted)}>
          <Check aria-hidden {...stylex.props(styles.icon)} /> No changes since branching from{" "}
          {comparison}.
        </p>
        <button type="button" onClick={load} {...stylex.props(styles.toolButton)}>
          Refresh
        </button>
      </div>
    );
  return (
    <div {...stylex.props(styles.changes)}>
      <nav aria-label="Changed files" {...stylex.props(styles.fileList)}>
        {files.map((file) => (
          <button
            key={file.path}
            aria-current={selected?.path === file.path}
            onClick={() => setSelected(file)}
            type="button"
            {...stylex.props(
              styles.fileButton,
              selected?.path === file.path && styles.fileButtonActive,
            )}
          >
            <span {...stylex.props(styles.filePath)}>{file.path}</span>
            <span {...stylex.props(styles.fileMeta)}>
              {file.status}
              {file.additions === undefined ? "" : ` · +${file.additions} −${file.deletions ?? 0}`}
            </span>
          </button>
        ))}
      </nav>
      <section aria-label="Selected file patch" {...stylex.props(styles.diffPanel)}>
        <div aria-label="Diff options" {...stylex.props(styles.diffControls)}>
          <button
            type="button"
            aria-pressed={!split}
            onClick={() => setSplit(false)}
            {...stylex.props(styles.diffControl, !split && styles.diffControlActive)}
          >
            Unified
          </button>
          <button
            type="button"
            aria-pressed={split}
            onClick={() => setSplit(true)}
            {...stylex.props(styles.diffControl, split && styles.diffControlActive)}
          >
            Split
          </button>
          <label {...stylex.props(styles.diffToggle)}>
            <input
              checked={words}
              onChange={(event) => setWords(event.currentTarget.checked)}
              type="checkbox"
            />
            Word highlights
          </label>
          <button type="button" onClick={load} {...stylex.props(styles.diffControl)}>
            <RefreshCw aria-hidden {...stylex.props(styles.icon)} />
            Refresh
          </button>
        </div>
        <div {...stylex.props(styles.patch)}>
          {patch?.truncated ? (
            <p role="status">This patch is truncated. Only part of the changes is shown.</p>
          ) : null}
          {!selected?.patchable ? (
            <p>No textual patch is available for this file.</p>
          ) : patch === undefined ? (
            <p role="status">Loading patch…</p>
          ) : !patch.patch ? (
            <p>No textual changes in this file.</p>
          ) : (
            <Suspense fallback={<p role="status">Loading diff viewer…</p>}>
              <PierreDiff patch={patch.patch} split={split} words={words} />
            </Suspense>
          )}
        </div>
      </section>
    </div>
  );
}
