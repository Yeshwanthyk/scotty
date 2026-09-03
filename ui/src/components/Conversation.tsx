import * as stylex from "@stylexjs/stylex";
import { Check, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  streamedTextAt,
  turnActivityLabel,
  turnPreview,
  type ConversationTurn,
  type ToolActivity,
} from "../domain/conversation";
import { colors, spacing } from "../theme/tokens.stylex";
import { Button } from "./Button";

const styles = stylex.create({
  viewport: {
    minHeight: 0,
    overflowY: "auto",
    padding: "0 clamp(16px, 5vw, 52px) 28px",
  },
  feed: {
    width: "min(760px, 100%)",
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
  },
  assistantMessage: {
    maxWidth: "68ch",
    margin: 0,
    color: colors.ink,
    fontSize: "14px",
    lineHeight: 1.7,
    whiteSpace: "pre-wrap",
  },
  workingHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
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
  replayIcon: { width: "13px", height: "13px" },
  thinking: {
    margin: 0,
    paddingLeft: spacing.md,
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderLeftColor: colors.lineHover,
    color: colors.quiet,
    fontSize: "12px",
    lineHeight: 1.55,
  },
  activity: {
    display: "grid",
    gap: "2px",
    paddingLeft: spacing.md,
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderLeftColor: colors.lineSoft,
  },
  tool: {
    position: "relative",
    borderRadius: "7px",
    backgroundColor: "transparent",
  },
  toolSummary: {
    minHeight: "42px",
    padding: "7px 8px",
    display: "grid",
    gridTemplateColumns: "18px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: spacing.sm,
    cursor: "pointer",
    listStyle: "none",
    borderRadius: "7px",
    ":hover": { backgroundColor: "rgb(255 255 255 / 0.035)" },
    "::-webkit-details-marker": { display: "none" },
  },
  toolIcon: { width: "14px", height: "14px", color: colors.quiet, strokeWidth: 1.8 },
  toolIconDone: { color: colors.success },
  toolIconRunning: { color: colors.warning },
  toolIconFailed: { color: colors.danger },
  toolIdentity: { minWidth: 0, display: "grid", gap: "2px" },
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
  toolStateRunning: { color: colors.warning },
  toolStateFailed: { color: colors.danger },
  toolOutput: {
    margin: "0 8px 9px 34px",
    padding: spacing.md,
    overflowX: "auto",
    borderRadius: "6px",
    backgroundColor: colors.space,
    color: colors.muted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "10px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
  },
  caret: {
    display: "inline-block",
    width: "2px",
    height: "1em",
    marginLeft: "2px",
    verticalAlign: "-0.12em",
    backgroundColor: colors.warning,
    animationName: stylex.keyframes({ "0%, 45%": { opacity: 1 }, "46%, 100%": { opacity: 0 } }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "steps(1, end)",
  },
});

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

function ToolRow({ tool }: { readonly tool: ToolActivity }) {
  const [open, setOpen] = useState(tool.state === "running");
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
      {...stylex.props(styles.tool)}
    >
      <summary {...stylex.props(styles.toolSummary)}>
        {toolIcon(tool)}
        <span {...stylex.props(styles.toolIdentity)}>
          <span {...stylex.props(styles.toolLabel)}>{tool.label}</span>
          <span {...stylex.props(styles.toolInvocation)}>{tool.invocation}</span>
        </span>
        <span
          {...stylex.props(
            styles.toolState,
            tool.state === "running" && styles.toolStateRunning,
            tool.state === "failed" && styles.toolStateFailed,
          )}
        >
          {tool.state}
        </span>
      </summary>
      {tool.output === undefined ? null : (
        <pre {...stylex.props(styles.toolOutput)}>{tool.output}</pre>
      )}
    </details>
  );
}

function TurnContent({
  turn,
  assistant,
}: {
  readonly turn: ConversationTurn;
  readonly assistant: string;
}) {
  return (
    <>
      <p {...stylex.props(styles.userMessage)}>{turn.user}</p>
      {turn.activitySummary === undefined ? null : (
        <p {...stylex.props(styles.thinking)}>{turn.activitySummary}</p>
      )}
      {turn.tools.length === 0 ? null : (
        <div aria-label="Tool activity" {...stylex.props(styles.activity)}>
          {turn.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      )}
      {assistant.length === 0 ? null : (
        <p {...stylex.props(styles.assistantMessage)}>{assistant}</p>
      )}
    </>
  );
}

function CompletedTurn({ turn }: { readonly turn: ConversationTurn }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
      {...stylex.props(styles.completedTurn)}
    >
      <summary {...stylex.props(styles.completedSummary, open && styles.completedSummaryOpen)}>
        <span {...stylex.props(styles.summaryCopy)}>
          <span {...stylex.props(styles.summaryLabel)}>{turnPreview(turn)}</span>
        </span>
        <span {...stylex.props(styles.summaryMeta)}>
          {turnActivityLabel(turn)}
          {turn.elapsedSeconds === undefined ? "" : ` · ${turn.elapsedSeconds}s`}
        </span>
      </summary>
      <div {...stylex.props(styles.turnBody)}>
        <TurnContent assistant={turn.assistant} turn={turn} />
      </div>
    </details>
  );
}

export function Conversation({ turns }: { readonly turns: ReadonlyArray<ConversationTurn> }) {
  const active = turns.findLast((turn) => turn.state === "streaming");
  const completed = turns.filter((turn) => turn.state !== "streaming");
  const [visibleCompleted, setVisibleCompleted] = useState(3);
  const [generation, setGeneration] = useState(0);
  const [visibleCharacters, setVisibleCharacters] = useState(0);

  useEffect(() => {
    if (active === undefined) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setVisibleCharacters(active.assistant.length);
      return;
    }
    setVisibleCharacters(0);
    const timer = window.setInterval(() => {
      setVisibleCharacters((current) => {
        if (current >= active.assistant.length) {
          window.clearInterval(timer);
          return current;
        }
        return Math.min(active.assistant.length, current + 2);
      });
    }, 28);
    return () => window.clearInterval(timer);
  }, [active, generation]);

  return (
    <div data-scrollbar="quiet" {...stylex.props(styles.viewport)}>
      <div aria-label="Conversation transcript" {...stylex.props(styles.feed)}>
        {completed.length > visibleCompleted ? (
          <button
            type="button"
            onClick={() =>
              setVisibleCompleted((current) => Math.min(completed.length, current + 5))
            }
            {...stylex.props(styles.showEarlier)}
          >
            Show {Math.min(5, completed.length - visibleCompleted)} earlier{" "}
            {Math.min(5, completed.length - visibleCompleted) === 1 ? "turn" : "turns"}
          </button>
        ) : null}
        {completed.slice(-visibleCompleted).map((turn) => (
          <CompletedTurn key={turn.id} turn={turn} />
        ))}
        {active === undefined ? null : (
          <article aria-label="Current turn" aria-busy="true" {...stylex.props(styles.activeTurn)}>
            <div {...stylex.props(styles.workingHeader)}>
              <span {...stylex.props(styles.workingLabel)}>
                <LoaderCircle aria-hidden {...stylex.props(styles.spin)} />
                Working
              </span>
              <Button
                aria-label="Replay streaming response"
                onClick={() => setGeneration((current) => current + 1)}
                variant="quiet"
              >
                <RotateCcw aria-hidden {...stylex.props(styles.replayIcon)} />
                Replay
              </Button>
            </div>
            <TurnContent assistant="" turn={active} />
            <p aria-live="polite" {...stylex.props(styles.assistantMessage)}>
              {streamedTextAt(active.assistant, visibleCharacters)}
              {visibleCharacters < active.assistant.length ? (
                <span aria-hidden {...stylex.props(styles.caret)} />
              ) : null}
            </p>
          </article>
        )}
      </div>
    </div>
  );
}
