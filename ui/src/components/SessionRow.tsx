import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import {
  CircleAlert,
  FolderClosed,
  LoaderCircle,
  MessageSquare,
  Moon,
  Radio,
  Trash2,
} from "lucide-react";
import type { SessionModel } from "../data/session-reader";
import type { SessionPresentation } from "../domain/session-presentation";
import { colors, motion, spacing } from "../theme/tokens.stylex";

export type SessionRailSession = Pick<SessionModel, "id"> & {
  readonly display: Pick<SessionModel["display"], "branch" | "repository" | "title">;
};

export interface SessionRowProps {
  readonly actorCorrected?: boolean;
  readonly onNavigate?: () => void;
  readonly placement?: "active" | "archived";
  readonly presentation: SessionPresentation;
  readonly projectedFreshness?: SessionPresentation["freshness"];
  readonly selected?: boolean;
  readonly session: SessionRailSession;
}

const styles = stylex.create({
  link: {
    minHeight: "64px",
    paddingBlock: "7px",
    paddingInline: spacing.sm,
    display: "grid",
    gridTemplateColumns: "18px minmax(0, 1fr)",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: "7px",
    color: colors.muted,
    textDecoration: "none",
    transitionProperty: "background-color, border-color, color, transform",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.easeOut,
    ":hover": {
      backgroundColor: colors.panelRaised,
      color: colors.ink,
    },
    ":active": {
      transform: "scale(0.96)",
    },
  },
  selected: {
    borderColor: colors.line,
    backgroundColor: colors.panelRaised,
    color: colors.ink,
  },
  archivedLink: {
    minHeight: "44px",
    paddingBlock: "6px",
    color: colors.quiet,
    opacity: 0.68,
    ":hover": { opacity: 1 },
  },
  icon: {
    width: "15px",
    height: "15px",
    color: colors.quiet,
    strokeWidth: 1.8,
  },
  warm: { color: colors.success },
  sleeping: { color: colors.quiet },
  failed: { color: colors.danger },
  gone: { color: colors.quiet },
  operation: { color: colors.warning },
  text: {
    minWidth: 0,
    display: "grid",
    gap: "3px",
  },
  repository: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "5px",
    overflow: "hidden",
    color: colors.quiet,
    fontSize: "10px",
    lineHeight: 1.2,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  repositoryIcon: { width: "12px", height: "12px", flexShrink: 0, strokeWidth: 1.7 },
  title: {
    overflow: "hidden",
    color: "inherit",
    fontSize: "12px",
    fontWeight: 620,
    lineHeight: 1.25,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  metadata: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "5px",
    overflow: "hidden",
    color: colors.quiet,
    fontSize: "10px",
    lineHeight: 1.25,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  branch: {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  separator: { opacity: 0.55 },
  status: { overflow: "hidden", textOverflow: "ellipsis" },
  operationDetails: { color: colors.warning },
  provenance: { color: colors.focus },
  stale: { color: colors.warning },
  spin: {
    animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
});

type StatusIconProps = Pick<SessionRowProps, "presentation">;

function StatusIcon({ presentation }: StatusIconProps) {
  const operation = presentation.operation;

  if (operation?.action === "vaporize" || presentation.destructiveProgress)
    return <Trash2 aria-hidden {...stylex.props(styles.icon, styles.failed)} />;
  if (operation !== null)
    return (
      <LoaderCircle aria-hidden {...stylex.props(styles.icon, styles.operation, styles.spin)} />
    );
  if (presentation.authority.lifecycle === "sleeping")
    return <Moon aria-hidden {...stylex.props(styles.icon, styles.sleeping)} />;
  if (presentation.authority.lifecycle === "failed")
    return <CircleAlert aria-hidden {...stylex.props(styles.icon, styles.failed)} />;
  if (presentation.authority.lifecycle === "gone")
    return <Trash2 aria-hidden {...stylex.props(styles.icon, styles.gone)} />;
  return <Radio aria-hidden {...stylex.props(styles.icon, styles.warm)} />;
}

const ArchivedIcon = () => (
  <MessageSquare aria-hidden {...stylex.props(styles.icon, styles.sleeping)} />
);

const operationDetailsFor = (presentation: SessionPresentation): string | undefined => {
  const operation = presentation.operation;
  if (operation === null) return undefined;
  return `${operation.action} · ${operation.mode} · ${operation.phase}`;
};

const operationSummaryFor = (presentation: SessionPresentation): string | undefined => {
  const operation = presentation.operation;
  if (operation === null) return undefined;
  return `${operation.label} · ${operation.phase}`;
};

const provenanceFor = (
  presentation: SessionPresentation,
  actorCorrected: boolean,
): string | undefined => {
  if (actorCorrected) return "Actor-corrected";
  if (presentation.freshness === "stale") return "Stale projection";
  return undefined;
};

function SessionMetadata({
  actorCorrected,
  presentation,
  projectedFreshness,
  session,
}: Pick<SessionRowProps, "actorCorrected" | "presentation" | "projectedFreshness" | "session">) {
  const operationDetails = operationDetailsFor(presentation);
  const operationSummary = operationSummaryFor(presentation);
  const provenance = provenanceFor(presentation, actorCorrected ?? false);
  return (
    <span {...stylex.props(styles.metadata)}>
      <span title={session.display.branch ?? undefined} {...stylex.props(styles.branch)}>
        {session.display.branch}
      </span>
      <span aria-hidden {...stylex.props(styles.separator)}>
        ·
      </span>
      <span title={presentation.railLabel} {...stylex.props(styles.status)}>
        {presentation.railLabel}
      </span>
      {operationSummary ? (
        <span title={operationDetails} {...stylex.props(styles.operationDetails)}>
          {operationSummary}
        </span>
      ) : null}
      {provenance ? (
        <span
          title={
            actorCorrected && projectedFreshness === "stale"
              ? "Actor read corrected a stale rail projection"
              : provenance
          }
          {...stylex.props(actorCorrected ? styles.provenance : styles.stale)}
        >
          {provenance}
        </span>
      ) : null}
    </span>
  );
}

const rowAriaLabel = (session: SessionRowProps["session"], presentation: SessionPresentation) => {
  const operationDetails = operationDetailsFor(presentation);
  return `${session.display.title}, ${presentation.railLabel}${operationDetails ? `, operation ${operationDetails}` : ""}`;
};

const repositoryName = (repository: string): string => repository.split("/").at(-1) ?? repository;

export function SessionRow({
  actorCorrected = false,
  onNavigate,
  placement = "active",
  presentation,
  projectedFreshness,
  selected = false,
  session,
}: SessionRowProps) {
  const operation = presentation.operation;

  return (
    <Link
      to="/s/$sessionId"
      params={{ sessionId: session.id }}
      onClick={onNavigate}
      aria-current={selected ? "page" : undefined}
      aria-label={rowAriaLabel(session, presentation)}
      data-actor-corrected={actorCorrected ? "true" : undefined}
      data-authority-kind={presentation.authority.kind}
      data-operation={operation?.action}
      data-operation-action={operation?.action}
      data-operation-mode={operation?.mode}
      data-operation-phase={operation?.phase ?? undefined}
      data-session-freshness={presentation.freshness}
      data-session-source={presentation.source}
      data-rail-placement={placement}
      data-session-state={
        presentation.authority.kind === "stable" ? presentation.authority.lifecycle : undefined
      }
      {...stylex.props(
        styles.link,
        placement === "archived" && styles.archivedLink,
        selected && styles.selected,
      )}
    >
      {placement === "archived" ? <ArchivedIcon /> : <StatusIcon presentation={presentation} />}
      <span {...stylex.props(styles.text)}>
        {placement === "active" ? (
          <span title={session.display.repository} {...stylex.props(styles.repository)}>
            <FolderClosed aria-hidden {...stylex.props(styles.repositoryIcon)} />
            {session.display.repository}
          </span>
        ) : null}
        <span title={session.display.title} {...stylex.props(styles.title)}>
          {session.display.title}
        </span>
        {placement === "archived" ? (
          <span {...stylex.props(styles.metadata)}>
            <span>{repositoryName(session.display.repository)}</span>
            <span aria-hidden {...stylex.props(styles.separator)}>
              ·
            </span>
            <span>{presentation.railLabel}</span>
          </span>
        ) : (
          <SessionMetadata
            actorCorrected={actorCorrected}
            presentation={presentation}
            projectedFreshness={projectedFreshness}
            session={session}
          />
        )}
      </span>
    </Link>
  );
}
