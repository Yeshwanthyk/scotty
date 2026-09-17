import * as stylex from "@stylexjs/stylex";
import { Check, CircleAlert, ExternalLink, Images, LoaderCircle } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  turnActivityLabel,
  turnPreview,
  type ConversationTurn,
  type ToolActivity,
} from "../domain/conversation";
import type { EvidenceSummary } from "../data/session-workbench";
import { colors, motion, spacing } from "../theme/tokens.stylex";
import { Markdown } from "./Markdown";

const styles = stylex.create({
  viewport: {
    minHeight: 0,
    overflowY: "auto",
    padding: "28px clamp(16px, 3vw, 32px)",
  },
  feed: {
    width: "min(840px, 100%)",
    marginInline: "auto",
    display: "grid",
  },
  completedTurn: {
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
  },
  completedSummary: {
    minHeight: "44px",
    padding: `${spacing.sm} ${spacing.md}`,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: spacing.md,
    color: colors.muted,
    cursor: "pointer",
    listStyle: "none",
    transitionProperty: "background-color, color",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.easeOut,
    ":hover": { color: colors.ink },
    "::-webkit-details-marker": { display: "none" },
    "@media (max-width: 720px)": {
      minHeight: "58px",
      gridTemplateColumns: "minmax(0, 1fr)",
      alignContent: "center",
      gap: "3px",
      padding: `${spacing.sm} ${spacing.md}`,
    },
  },
  completedSummaryOpen: { backgroundColor: "rgb(255 255 255 / 0.025)", color: colors.ink },
  summaryCopy: { minWidth: 0 },
  summaryLabel: {
    overflow: "hidden",
    color: "inherit",
    fontSize: "13px",
    fontWeight: 590,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "@media (max-width: 720px)": {
      display: "-webkit-box",
      overflow: "hidden",
      whiteSpace: "normal",
      WebkitBoxOrient: "vertical",
      WebkitLineClamp: 2,
      lineHeight: 1.35,
    },
  },
  summaryMeta: {
    color: colors.quiet,
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    "@media (max-width: 720px)": { justifySelf: "start", fontSize: "10px" },
  },
  showEarlier: {
    width: "100%",
    minHeight: "40px",
    paddingInline: spacing.sm,
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 0,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
    backgroundColor: "transparent",
    color: colors.quiet,
    fontSize: "11px",
    cursor: "pointer",
    ":hover": { color: colors.muted, backgroundColor: "rgb(255 255 255 / 0.025)" },
  },
  turnBody: {
    padding: "2px 0 28px 28px",
    display: "grid",
    gap: spacing.lg,
    "@media (max-width: 720px)": { paddingLeft: 0 },
  },
  activeTurn: {
    paddingBlock: "28px 8px",
    display: "grid",
    gap: spacing.lg,
    animationName: stylex.keyframes({
      from: { opacity: 0, transform: "translateY(6px)" },
      to: { opacity: 1, transform: "translateY(0)" },
    }),
    animationDuration: motion.standard,
    animationTimingFunction: motion.easeOut,
  },
  latestTurn: {
    paddingBlock: "28px 8px",
    display: "grid",
    gap: spacing.lg,
  },
  userMessage: {
    maxWidth: "min(620px, 92%)",
    justifySelf: "end",
    margin: 0,
    padding: "10px 13px",
    borderRadius: "14px 14px 4px 14px",
    backgroundColor: colors.panelRaised,
    color: colors.ink,
    fontSize: "14px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    animationName: stylex.keyframes({
      from: { opacity: 0, transform: "translateY(4px)" },
      to: { opacity: 1, transform: "translateY(0)" },
    }),
    animationDuration: motion.standard,
    animationTimingFunction: motion.easeOut,
  },
  assistantMessage: {
    maxWidth: "68ch",
  },
  workingHeader: {
    display: "flex",
    alignItems: "center",
    gap: spacing.md,
  },
  workingLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.warning,
    fontSize: "12px",
    fontWeight: 650,
  },
  spin: {
    width: "13px",
    height: "13px",
    animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  thinking: {
    margin: 0,
    color: colors.quiet,
    fontSize: "12px",
    lineHeight: 1.55,
  },
  activity: {
    display: "grid",
    gap: "2px",
  },
  tool: {
    position: "relative",
    borderRadius: "7px",
    animationName: stylex.keyframes({
      from: { opacity: 0, transform: "translateY(3px)" },
      to: { opacity: 1, transform: "translateY(0)" },
    }),
    animationDuration: motion.fast,
    animationTimingFunction: motion.easeOut,
    backgroundColor: "transparent",
  },
  toolSummary: {
    minHeight: "42px",
    padding: "7px 8px",
    display: "grid",
    gridTemplateColumns: "14px minmax(0, 1fr)",
    alignItems: "center",
    gap: spacing.sm,
    cursor: "pointer",
    listStyle: "none",
    borderRadius: "7px",
    transitionProperty: "background-color",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.easeOut,
    ":hover": { backgroundColor: "rgb(255 255 255 / 0.035)" },
    "::-webkit-details-marker": { display: "none" },
  },
  toolIcon: { width: "14px", height: "14px", color: colors.quiet, strokeWidth: 1.8 },
  toolIconDone: { color: colors.quiet },
  toolIconRunning: { color: colors.quiet },
  toolIconFailed: { color: colors.danger },
  toolIdentity: { minWidth: 0, display: "grid", gap: "2px" },
  toolHeading: { minWidth: 0, display: "flex", alignItems: "baseline", gap: spacing.sm },
  toolLabel: {
    overflow: "hidden",
    color: colors.muted,
    fontSize: "12px",
    fontWeight: 620,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  toolInvocation: {
    overflow: "hidden",
    color: colors.quiet,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "10px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  toolState: {
    color: colors.quiet,
    fontSize: "10px",
    fontWeight: 650,
    textTransform: "capitalize",
  },
  toolStateRunning: { color: colors.quiet },
  toolStateFailed: { color: colors.danger },
  toolDetails: {
    margin: `0 8px ${spacing.sm} 30px`,
    display: "grid",
    gap: "4px",
  },
  toolDetailLabel: {
    marginTop: spacing.xs,
    color: colors.quiet,
    fontSize: "10px",
    fontWeight: 620,
  },
  toolInvocationFull: {
    margin: 0,
    padding: "4px 0",
    overflowX: "auto",
    overflowWrap: "anywhere",
    backgroundColor: "transparent",
    color: colors.muted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "10px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
  },
  toolOutput: {
    margin: 0,
    padding: "4px 0",
    overflowX: "auto",
    backgroundColor: "transparent",
    color: colors.muted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "10px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
  },
  evidenceOwner: { minWidth: 0 },
  evidence: {
    minWidth: 0,
    margin: `2px 8px ${spacing.sm}`,
    padding: spacing.md,
    display: "grid",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.lineSoft,
    borderRadius: "10px",
    backgroundColor: "rgb(255 255 255 / 0.02)",
  },
  evidenceHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  evidenceTitle: {
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.muted,
    fontSize: "12px",
    fontWeight: 650,
  },
  evidenceIcon: { width: "14px", height: "14px", color: colors.quiet, strokeWidth: 1.8 },
  evidenceLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    color: colors.muted,
    fontSize: "11px",
    textDecoration: "none",
    whiteSpace: "nowrap",
    ":hover": { color: colors.ink },
  },
  evidenceStatus: { margin: 0, color: colors.quiet, fontSize: "11px", lineHeight: 1.5 },
  evidenceError: { color: colors.danger },
  evidenceFrames: {
    minWidth: 0,
    display: "flex",
    gap: spacing.sm,
    overflowX: "auto",
    scrollSnapType: "x proximity",
  },
  evidenceFrameLink: {
    width: "min(240px, 82vw)",
    flex: "0 0 auto",
    overflow: "hidden",
    borderRadius: "7px",
    backgroundColor: colors.space,
    color: colors.muted,
    textDecoration: "none",
    scrollSnapAlign: "start",
  },
  evidenceFrameViewport: {
    height: "180px",
    position: "relative",
    display: "grid",
    placeItems: "center",
    backgroundColor: colors.space,
  },
  evidenceFrame: {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
  },
  evidenceFrameUnavailable: { opacity: 0 },
  evidenceFrameStatus: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    padding: spacing.md,
    color: colors.quiet,
    fontSize: "11px",
    textAlign: "center",
  },
  evidenceFrameLoaded: { display: "none" },
  evidenceCaption: {
    display: "block",
    padding: `${spacing.sm} ${spacing.md}`,
    overflow: "hidden",
    fontSize: "11px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  evidenceVideo: {
    width: "100%",
    maxHeight: "460px",
    display: "block",
    borderRadius: "7px",
    backgroundColor: colors.space,
  },
});

export type ConversationEvidenceState =
  | { readonly kind: "loading"; readonly sessionId: string }
  | {
      readonly kind: "ready";
      readonly sessionId: string;
      readonly evidence: ReadonlyArray<EvidenceSummary>;
    }
  | { readonly kind: "error"; readonly sessionId: string; readonly message: string };

const EVIDENCE_REFERENCE =
  /(?:^|[^A-Za-z0-9_-])scotty-evidence:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![A-Za-z0-9_-])/u;

export const evidenceJobIdFromTool = (tool: ToolActivity): string | undefined =>
  tool.output?.match(EVIDENCE_REFERENCE)?.[1];

const evidencePath = (sessionId: string, jobId: string): string =>
  `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(jobId)}`;

function EvidenceThumbnail({
  frameId,
  name,
  summaryPath,
}: {
  readonly frameId: string;
  readonly name: string;
  readonly summaryPath: string;
}) {
  const [imageState, setImageState] = useState<"loading" | "loaded" | "error">("loading");
  const framePath = `${summaryPath}/frames/${encodeURIComponent(frameId)}.png`;
  return (
    <a
      aria-label={`Open ${name} screenshot`}
      href={framePath}
      target="_blank"
      rel="noreferrer"
      {...stylex.props(styles.evidenceFrameLink)}
    >
      <span aria-busy={imageState === "loading"} {...stylex.props(styles.evidenceFrameViewport)}>
        <img
          alt={`${name} browser evidence`}
          decoding="async"
          loading="lazy"
          onError={() => setImageState("error")}
          onLoad={() => setImageState("loaded")}
          src={framePath}
          {...stylex.props(
            styles.evidenceFrame,
            imageState === "error" && styles.evidenceFrameUnavailable,
          )}
        />
        <span
          {...stylex.props(
            styles.evidenceFrameStatus,
            imageState === "loaded" && styles.evidenceFrameLoaded,
          )}
        >
          {imageState === "error" ? "Screenshot unavailable" : "Loading screenshot…"}
        </span>
      </span>
      <span {...stylex.props(styles.evidenceCaption)}>{name}</span>
    </a>
  );
}

function ToolEvidence({
  evidenceState,
  jobId,
  sessionId,
}: {
  readonly evidenceState: ConversationEvidenceState;
  readonly jobId: string;
  readonly sessionId: string;
}) {
  const summaryPath = evidencePath(sessionId, jobId);
  const state =
    evidenceState.sessionId === sessionId ? evidenceState : { kind: "loading" as const };
  const job =
    state.kind === "ready"
      ? state.evidence.find((candidate) => candidate.jobId === jobId)
      : undefined;
  const frames =
    job?.steps.filter(
      (step): step is typeof step & { readonly frameId: string } => step.frameId !== undefined,
    ) ?? [];
  return (
    <section aria-label="Browser evidence" {...stylex.props(styles.evidence)}>
      <header {...stylex.props(styles.evidenceHeader)}>
        <span {...stylex.props(styles.evidenceTitle)}>
          <Images aria-hidden {...stylex.props(styles.evidenceIcon)} />
          Browser evidence
        </span>
        <a
          aria-label="Open browser evidence details"
          href={summaryPath}
          target="_blank"
          rel="noreferrer"
          {...stylex.props(styles.evidenceLink)}
        >
          Details <ExternalLink aria-hidden {...stylex.props(styles.evidenceIcon)} />
        </a>
      </header>
      {state.kind === "loading" ? (
        <p role="status" {...stylex.props(styles.evidenceStatus)}>
          Loading screenshots…
        </p>
      ) : state.kind === "error" ? (
        <p role="alert" {...stylex.props(styles.evidenceStatus, styles.evidenceError)}>
          Screenshots could not be loaded. {state.message}
        </p>
      ) : job === undefined ? (
        <p {...stylex.props(styles.evidenceStatus)}>Evidence is not available for this session.</p>
      ) : frames.length === 0 ? (
        <p {...stylex.props(styles.evidenceStatus)}>
          {job.status === "accepted" ||
          job.status === "exposing" ||
          job.status === "running" ||
          job.status === "finalizing"
            ? "Screenshots are not available yet."
            : "No screenshots were captured for this run."}
        </p>
      ) : (
        <div aria-label="Evidence screenshots" {...stylex.props(styles.evidenceFrames)}>
          {frames.map((frame) => (
            <EvidenceThumbnail
              frameId={frame.frameId}
              key={frame.frameId}
              name={frame.name}
              summaryPath={summaryPath}
            />
          ))}
        </div>
      )}
      {job?.videoAvailable === true ? (
        <video
          aria-label="Browser evidence recording"
          controls
          playsInline
          preload="metadata"
          src={`${summaryPath}/video.webm`}
          {...stylex.props(styles.evidenceVideo)}
        />
      ) : null}
    </section>
  );
}

const toolIcon = (tool: ToolActivity) => {
  if (tool.state === "running")
    return (
      <LoaderCircle
        aria-hidden
        {...stylex.props(styles.toolIcon, styles.toolIconRunning, styles.spin)}
      />
    );
  if (tool.state === "failed")
    return <CircleAlert aria-hidden {...stylex.props(styles.toolIcon, styles.toolIconFailed)} />;
  return <Check aria-hidden {...stylex.props(styles.toolIcon, styles.toolIconDone)} />;
};

function ToolRow({
  evidenceState,
  sessionId,
  tool,
}: {
  readonly evidenceState: ConversationEvidenceState | undefined;
  readonly sessionId: string | undefined;
  readonly tool: ToolActivity;
}) {
  const [open, setOpen] = useState(tool.state === "running");
  const evidenceJobId = evidenceJobIdFromTool(tool);
  return (
    <div {...stylex.props(styles.evidenceOwner)}>
      <details
        onToggle={(event) => setOpen(event.currentTarget.open)}
        open={open}
        {...stylex.props(styles.tool)}
      >
        <summary {...stylex.props(styles.toolSummary)}>
          {toolIcon(tool)}
          <span {...stylex.props(styles.toolIdentity)}>
            <span {...stylex.props(styles.toolHeading)}>
              <span {...stylex.props(styles.toolLabel)}>{tool.label}</span>
              {tool.state === "running" || tool.state === "failed" ? (
                <span
                  {...stylex.props(
                    styles.toolState,
                    tool.state === "running" && styles.toolStateRunning,
                    tool.state === "failed" && styles.toolStateFailed,
                  )}
                >
                  {tool.state}
                </span>
              ) : null}
            </span>
            <span {...stylex.props(styles.toolInvocation)}>{tool.invocation}</span>
          </span>
        </summary>
        <div {...stylex.props(styles.toolDetails)}>
          <span {...stylex.props(styles.toolDetailLabel)}>Input</span>
          <pre aria-label="Complete tool invocation" {...stylex.props(styles.toolInvocationFull)}>
            {tool.invocation}
          </pre>
          {tool.output === undefined ? null : (
            <>
              <span {...stylex.props(styles.toolDetailLabel)}>Result</span>
              <pre aria-label="Tool result" {...stylex.props(styles.toolOutput)}>
                {tool.output}
              </pre>
            </>
          )}
        </div>
      </details>
      {evidenceJobId === undefined ||
      sessionId === undefined ||
      evidenceState === undefined ? null : (
        <ToolEvidence evidenceState={evidenceState} jobId={evidenceJobId} sessionId={sessionId} />
      )}
    </div>
  );
}

function TurnContent({
  turn,
  assistant,
  evidenceState,
  sessionId,
  showUser = true,
}: {
  readonly turn: ConversationTurn;
  readonly assistant: string;
  readonly evidenceState: ConversationEvidenceState | undefined;
  readonly sessionId: string | undefined;
  readonly showUser?: boolean;
}) {
  return (
    <>
      {!showUser || turn.user.trim().length === 0 ? null : (
        <p {...stylex.props(styles.userMessage)}>{turn.user}</p>
      )}
      {turn.activitySummary === undefined ? null : (
        <p {...stylex.props(styles.thinking)}>{turn.activitySummary}</p>
      )}
      {turn.tools.length === 0 ? null : (
        <div aria-label="Tool activity" {...stylex.props(styles.activity)}>
          {turn.tools.map((tool) => (
            <ToolRow
              evidenceState={evidenceState}
              key={tool.id}
              sessionId={sessionId}
              tool={tool}
            />
          ))}
        </div>
      )}
      {assistant.length === 0 ? null : (
        <div {...stylex.props(styles.assistantMessage)}>
          <Markdown source={assistant} />
        </div>
      )}
    </>
  );
}

function CompletedTurn({
  evidenceState,
  sessionId,
  turn,
}: {
  readonly evidenceState: ConversationEvidenceState | undefined;
  readonly sessionId: string | undefined;
  readonly turn: ConversationTurn;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-turn-disclosure="folded"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
      {...stylex.props(styles.completedTurn)}
    >
      <summary {...stylex.props(styles.completedSummary, open && styles.completedSummaryOpen)}>
        <span {...stylex.props(styles.summaryCopy)}>
          <span data-design="turn-summary-label" {...stylex.props(styles.summaryLabel)}>
            {turnPreview(turn)}
          </span>
        </span>
        <span {...stylex.props(styles.summaryMeta)}>
          {turnActivityLabel(turn)}
          {turn.elapsedSeconds === undefined ? "" : ` · ${turn.elapsedSeconds}s`}
        </span>
      </summary>
      <div {...stylex.props(styles.turnBody)}>
        <TurnContent
          assistant={turn.assistant}
          evidenceState={evidenceState}
          sessionId={sessionId}
          turn={turn}
        />
      </div>
    </details>
  );
}

export function Conversation({
  evidenceState,
  sessionId,
  turns,
}: {
  readonly evidenceState?: ConversationEvidenceState;
  readonly sessionId?: string;
  readonly turns: ReadonlyArray<ConversationTurn>;
}) {
  const active = turns.findLast((turn) => turn.state === "streaming");
  const activeHasRunningTool = active?.tools.some((tool) => tool.state === "running") ?? false;
  const completed = turns.filter((turn) => turn.state !== "streaming");
  const latestCompleted = active === undefined ? completed.at(-1) : undefined;
  const foldedCompleted = latestCompleted === undefined ? completed : completed.slice(0, -1);
  const [visibleCompleted, setVisibleCompleted] = useState(3);
  const viewport = useRef<HTMLDivElement | null>(null);
  const followTail = useRef(true);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null || !followTail.current) return;
    element.scrollTop = element.scrollHeight;
  }, [active?.assistant, completed.length, turns.length]);

  return (
    <div
      data-scrollbar="quiet"
      onScroll={(event) => {
        const element = event.currentTarget;
        followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
      ref={viewport}
      {...stylex.props(styles.viewport)}
    >
      <div aria-label="Conversation transcript" {...stylex.props(styles.feed)}>
        {foldedCompleted.length > visibleCompleted ? (
          <button
            type="button"
            onClick={() =>
              setVisibleCompleted((current) => Math.min(foldedCompleted.length, current + 5))
            }
            data-design="show-earlier"
            {...stylex.props(styles.showEarlier)}
          >
            Show {Math.min(5, foldedCompleted.length - visibleCompleted)} earlier{" "}
            {Math.min(5, foldedCompleted.length - visibleCompleted) === 1 ? "turn" : "turns"}
          </button>
        ) : null}
        {foldedCompleted.slice(-visibleCompleted).map((turn) => (
          <CompletedTurn
            evidenceState={evidenceState}
            key={turn.id}
            sessionId={sessionId}
            turn={turn}
          />
        ))}
        {latestCompleted === undefined ? null : (
          <article
            aria-label="Latest response"
            data-turn-disclosure="latest"
            {...stylex.props(styles.latestTurn)}
          >
            <TurnContent
              assistant={latestCompleted.assistant}
              evidenceState={evidenceState}
              sessionId={sessionId}
              turn={latestCompleted}
            />
          </article>
        )}
        {active === undefined ? null : (
          <article
            aria-label="Current turn"
            aria-busy="true"
            key={active.id}
            {...stylex.props(styles.activeTurn)}
          >
            {active.user.trim().length === 0 ? null : (
              <p {...stylex.props(styles.userMessage)}>{active.user}</p>
            )}
            <div {...stylex.props(styles.workingHeader)}>
              <span {...stylex.props(styles.workingLabel)}>
                {activeHasRunningTool ? null : (
                  <LoaderCircle aria-hidden {...stylex.props(styles.spin)} />
                )}
                Working
              </span>
            </div>
            <TurnContent
              assistant=""
              evidenceState={evidenceState}
              sessionId={sessionId}
              showUser={false}
              turn={active}
            />
            <div aria-live="polite" {...stylex.props(styles.assistantMessage)}>
              <Markdown source={active.assistant} />
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
