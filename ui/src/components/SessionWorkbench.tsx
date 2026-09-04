import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import * as stylex from "@stylexjs/stylex";
import {
  Check,
  ChevronRight,
  ExternalLink,
  FileDiff,
  FlaskConical,
  LoaderCircle,
  PanelRight,
  RefreshCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { Markdown } from "./Markdown";

const styles = stylex.create({
  root: {
    height: "100%",
    minHeight: 0,
    position: "relative",
    display: "grid",
    gridTemplateRows: "42px minmax(0, 1fr)",
    overflow: "hidden",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingInline: "clamp(0px, 1vw, 12px)",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
  },
  toolbarLabel: { color: colors.quiet, fontSize: "11px", fontWeight: 620 },
  toolbarActions: { display: "flex", alignItems: "center", gap: "2px" },
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
  },
  toolButtonActive: { backgroundColor: colors.panelRaised, color: colors.ink },
  icon: { width: "13px", height: "13px", strokeWidth: 1.8 },
  stage: { minHeight: 0, display: "grid", overflow: "hidden" },
  stageWithSummary: {
    gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 380px)",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  main: { minWidth: 0, minHeight: 0, overflow: "hidden" },
  panel: {
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    padding: spacing.xl,
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderLeftColor: colors.line,
    backgroundColor: colors.shell,
    animationName: stylex.keyframes({
      from: { opacity: 0, transform: "translateX(10px)" },
      to: { opacity: 1, transform: "translateX(0)" },
    }),
    animationDuration: motion.standard,
    animationTimingFunction: motion.easeOut,
    "@media (max-width: 900px)": {
      position: "absolute",
      zIndex: 15,
      inset: "42px 0 0",
      borderLeftWidth: 0,
    },
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  panelTitle: { margin: 0, color: colors.ink, fontSize: "15px", fontWeight: 680 },
  close: {
    width: "30px",
    height: "30px",
    display: "grid",
    placeItems: "center",
    borderWidth: 0,
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: colors.quiet,
    cursor: "pointer",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
  },
  summaryStack: { display: "grid", gap: spacing.xl },
  section: {
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
  muted: { margin: 0, color: colors.muted, fontSize: "12px", lineHeight: 1.55 },
  hatchLine: {
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
    gridTemplateColumns: "280px minmax(0, 1fr)",
    overflow: "hidden",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  fileList: {
    minHeight: 0,
    overflowY: "auto",
    padding: spacing.sm,
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderRightColor: colors.lineSoft,
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
  },
  fileButtonActive: { backgroundColor: colors.panelRaised, color: colors.ink },
  filePath: {
    overflow: "hidden",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileMeta: { color: colors.quiet, fontSize: "10px" },
  patch: {
    minHeight: 0,
    overflow: "auto",
    margin: 0,
    padding: spacing.xl,
    backgroundColor: "#080808",
    color: colors.muted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    lineHeight: 1.55,
    whiteSpace: "pre",
  },
  terminalDrawer: {
    position: "absolute",
    zIndex: 20,
    right: 0,
    bottom: 0,
    left: 0,
    height: "min(46%, 430px)",
    minHeight: "240px",
    display: "grid",
    gridTemplateRows: "42px minmax(0, 1fr)",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.lineHover,
    backgroundColor: "#07090a",
    boxShadow: "0 -18px 42px rgb(0 0 0 / 45%)",
    animationName: stylex.keyframes({
      from: { transform: "translateY(18px)", opacity: 0 },
      to: { transform: "translateY(0)", opacity: 1 },
    }),
    animationDuration: motion.standard,
    animationTimingFunction: motion.easeOut,
  },
  terminalHeader: {
    paddingInline: spacing.md,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
  },
  terminalTitle: {
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.muted,
    fontSize: "11px",
    fontWeight: 650,
  },
  terminalSurface: { minHeight: 0, padding: "8px 10px", overflow: "hidden" },
});

export function SessionWorkbench({
  children,
  runtimeAvailable,
  sessionId,
}: {
  readonly children: ReactNode;
  readonly runtimeAvailable: boolean;
  readonly sessionId: string;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  return (
    <div {...stylex.props(styles.root)}>
      <nav aria-label="Session workbench" {...stylex.props(styles.toolbar)}>
        <span {...stylex.props(styles.toolbarLabel)}>
          {changesOpen ? "Working changes" : "Conversation"}
        </span>
        <div {...stylex.props(styles.toolbarActions)}>
          <ToolButton
            active={summaryOpen}
            icon={PanelRight}
            label="Summary"
            onClick={() => setSummaryOpen((open) => !open)}
          />
          <ToolButton
            active={changesOpen}
            icon={FileDiff}
            label="Diff"
            onClick={() => setChangesOpen((open) => !open)}
          />
          <ToolButton
            active={terminalOpen}
            disabled={!runtimeAvailable}
            icon={TerminalSquare}
            label="Terminal"
            onClick={() => setTerminalOpen((open) => !open)}
          />
        </div>
      </nav>
      <div {...stylex.props(styles.stage, summaryOpen && styles.stageWithSummary)}>
        <div {...stylex.props(styles.main)}>
          {changesOpen ? <ChangesView sessionId={sessionId} /> : children}
        </div>
        {summaryOpen ? (
          <SummaryPanel close={() => setSummaryOpen(false)} sessionId={sessionId} />
        ) : null}
      </div>
      {terminalOpen ? (
        <TerminalDrawer close={() => setTerminalOpen(false)} sessionId={sessionId} />
      ) : null}
    </div>
  );
}

function ToolButton({
  active,
  disabled = false,
  icon: Icon,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly icon: typeof PanelRight;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      type="button"
      {...stylex.props(styles.toolButton, active && styles.toolButtonActive)}
    >
      <Icon aria-hidden {...stylex.props(styles.icon)} />
      {label}
    </button>
  );
}

function SummaryPanel({
  close,
  sessionId,
}: {
  readonly close: () => void;
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
    const controller = new AbortController();
    void readConversation(sessionId, { signal: controller.signal }).then((conversation) => {
      if (controller.signal.aborted) return;
      setState((current) =>
        conversation.ok
          ? { ...current, snapshot: conversation.snapshot }
          : { ...current, conversationError: conversation.failure.message },
      );
    });
    void readEvidence(sessionId, controller.signal).then(
      (evidence) => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, evidence }));
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState((current) => ({
            ...current,
            evidenceError: error instanceof Error ? error.message : "Evidence unavailable",
          }));
      },
    );
    void readHatch(sessionId, controller.signal).then(
      (hatch) => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, hatch }));
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState((current) => ({
            ...current,
            hatchError: error instanceof Error ? error.message : "Hatch unavailable",
          }));
      },
    );
    return () => controller.abort();
  }, [sessionId]);
  const latest = state.snapshot?.turns.findLast((turn) => turn.assistant.trim().length > 0);
  return (
    <aside aria-label="Session summary" {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.panelHeader)}>
        <h2 {...stylex.props(styles.panelTitle)}>Summary</h2>
        <button
          aria-label="Close summary"
          onClick={close}
          type="button"
          {...stylex.props(styles.close)}
        >
          <X aria-hidden {...stylex.props(styles.icon)} />
        </button>
      </header>
      <div {...stylex.props(styles.summaryStack)}>
        <section {...stylex.props(styles.section)}>
          <span {...stylex.props(styles.eyebrow)}>Latest update</span>
          {state.conversationError !== undefined ? (
            <p role="alert" {...stylex.props(styles.muted)}>
              {state.conversationError}
            </p>
          ) : state.snapshot === undefined ? (
            <LoaderCircle
              aria-label="Loading latest update"
              {...stylex.props(styles.icon, styles.spin)}
            />
          ) : latest === undefined ? (
            <p {...stylex.props(styles.muted)}>No completed update yet.</p>
          ) : (
            <Markdown source={latest.assistant} />
          )}
        </section>
        <HatchSection error={state.hatchError} hatch={state.hatch} sessionId={sessionId} />
        <EvidenceSection
          error={state.evidenceError}
          evidence={state.evidence}
          sessionId={sessionId}
        />
      </div>
    </aside>
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
              {hatch?.configured ? (hatch.serviceName ?? "Application service") : "Not configured"}
            </h3>
            <p {...stylex.props(styles.muted)}>
              {hatch?.configured
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
                  {job.recordVideo ? "Evidence + recording" : "Browser evidence"}
                  <ChevronRight aria-hidden {...stylex.props(styles.icon)} />
                </span>
              </a>
            ))}
        </div>
      )}
    </section>
  );
}

function ChangesView({ sessionId }: { readonly sessionId: string }) {
  const [files, setFiles] = useState<ReadonlyArray<ChangedFile>>();
  const [selected, setSelected] = useState<ChangedFile>();
  const [patch, setPatch] = useState<ChangedFilePatch>();
  const [error, setError] = useState<string>();
  const load = (): void => {
    setError(undefined);
    void readChangedFiles(sessionId)
      .then((next) => {
        setFiles(next);
        setSelected(next.find((file) => file.patchable) ?? next[0]);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Changes unavailable"),
      );
  };
  useEffect(load, [sessionId]);
  useEffect(() => {
    if (selected === undefined || !selected.patchable) {
      setPatch(undefined);
      return;
    }
    const controller = new AbortController();
    setPatch(undefined);
    void readChangedFilePatch(sessionId, selected, controller.signal)
      .then(setPatch)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Patch unavailable");
      });
    return () => controller.abort();
  }, [selected, sessionId]);
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
          <Check aria-hidden {...stylex.props(styles.icon)} /> The session worktree is clean.
        </p>
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
      <pre aria-label="Selected file patch" {...stylex.props(styles.patch)}>
        {selected?.patchable
          ? (patch?.patch ?? "Loading patch…")
          : "No textual patch is available for this file."}
      </pre>
    </div>
  );
}

function TerminalDrawer({
  close,
  sessionId,
}: {
  readonly close: () => void;
  readonly sessionId: string;
}) {
  const surface = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("Connecting");
  useEffect(() => {
    const host = surface.current;
    if (host === null) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 10_000,
      theme: {
        background: "#07090a",
        foreground: "#eee7d3",
        cursor: "#dab77e",
        selectionBackground: "#29424d",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    const url = new URL(`/s/${encodeURIComponent(sessionId)}/terminal`, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("cols", String(terminal.cols));
    url.searchParams.set("rows", String(terminal.rows));
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      if (typeof event.data !== "string") return;
      try {
        const message: unknown = JSON.parse(event.data);
        if (
          message !== null &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "ready"
        ) {
          setStatus("Connected");
          terminal.focus();
        }
      } catch {
        terminal.write(event.data);
      }
    });
    socket.addEventListener("close", () => setStatus("Disconnected"));
    socket.addEventListener("error", () => setStatus("Connection error"));
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    });
    resize.observe(host);
    return () => {
      resize.disconnect();
      input.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [sessionId]);
  return (
    <aside aria-label="Session terminal" {...stylex.props(styles.terminalDrawer)}>
      <header {...stylex.props(styles.terminalHeader)}>
        <span {...stylex.props(styles.terminalTitle)}>
          <TerminalSquare aria-hidden {...stylex.props(styles.icon)} />
          Terminal · {status}
        </span>
        <button
          aria-label="Close terminal"
          onClick={close}
          type="button"
          {...stylex.props(styles.close)}
        >
          <X aria-hidden {...stylex.props(styles.icon)} />
        </button>
      </header>
      <div ref={surface} {...stylex.props(styles.terminalSurface)} />
    </aside>
  );
}
