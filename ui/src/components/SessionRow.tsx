import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { CircleAlert, FolderClosed } from "lucide-react";
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
    gridTemplateColumns: "8px minmax(0, 1fr)",
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
  stateSlot: { width: "8px", display: "grid", placeItems: "center" },
  stateDot: { width: "5px", height: "5px", borderRadius: "50%", backgroundColor: colors.quiet },
  sleeping: { backgroundColor: colors.quiet },
  operation: { backgroundColor: colors.warning },
  failedIcon: { width: "13px", height: "13px", color: colors.danger, strokeWidth: 1.8 },
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
  separator: { opacity: 0.55 },
  status: { overflow: "hidden", textOverflow: "ellipsis" },
  provenance: { color: colors.focus },
  stale: { color: colors.warning },
});

type StatusIconProps = Pick<SessionRowProps, "presentation">;

function StatusIcon({ presentation }: StatusIconProps) {
  const operation = presentation.operation;
  if (presentation.authority.kind === "stable" && presentation.authority.lifecycle === "failed")
    return (
      <span {...stylex.props(styles.stateSlot)}>
        <CircleAlert aria-hidden {...stylex.props(styles.failedIcon)} />
      </span>
    );
  if (operation !== null || presentation.destructiveProgress)
    return (
      <span {...stylex.props(styles.stateSlot)}>
        <span aria-hidden {...stylex.props(styles.stateDot, styles.operation)} />
      </span>
    );
  if (presentation.authority.kind === "stable" && presentation.authority.lifecycle === "sleeping")
    return (
      <span {...stylex.props(styles.stateSlot)}>
        <span aria-hidden {...stylex.props(styles.stateDot, styles.sleeping)} />
      </span>
    );
  return <span aria-hidden {...stylex.props(styles.stateSlot)} />;
}

const provenanceFor = (
  presentation: SessionPresentation,
  actorCorrected: boolean,
): string | undefined => {
  if (actorCorrected) return "Updated";
  if (presentation.freshness === "stale") return "May be outdated";
  return undefined;
};

function SessionMetadata({
  actorCorrected,
  presentation,
  projectedFreshness,
}: Pick<SessionRowProps, "actorCorrected" | "presentation" | "projectedFreshness">) {
  const provenance = provenanceFor(presentation, actorCorrected ?? false);
  const stateLabel = presentation.railLabel === "Awake" ? undefined : presentation.railLabel;
  if (stateLabel === undefined && provenance === undefined) return null;
  return (
    <span data-design="row-metadata" {...stylex.props(styles.metadata)}>
      {stateLabel ? (
        <span title={presentation.railLabel} {...stylex.props(styles.status)}>
          {stateLabel}
        </span>
      ) : null}
      {provenance ? (
        <>
          {stateLabel ? (
            <span aria-hidden {...stylex.props(styles.separator)}>
              ·
            </span>
          ) : null}
          <span
            title={
              actorCorrected && projectedFreshness === "stale"
                ? "Showing the latest session state"
                : provenance
            }
            {...stylex.props(actorCorrected ? styles.provenance : styles.stale)}
          >
            {provenance}
          </span>
        </>
      ) : null}
    </span>
  );
}

const rowAriaLabel = (session: SessionRowProps["session"], presentation: SessionPresentation) =>
  `${session.display.title}, ${presentation.railLabel}`;

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
      {placement === "archived" ? (
        <span aria-hidden {...stylex.props(styles.stateSlot)} />
      ) : (
        <StatusIcon presentation={presentation} />
      )}
      <span data-design="row-text" {...stylex.props(styles.text)}>
        {placement === "active" ? (
          <span
            title={session.display.repository}
            data-design="row-repository"
            {...stylex.props(styles.repository)}
          >
            <FolderClosed aria-hidden {...stylex.props(styles.repositoryIcon)} />
            {session.display.repository}
          </span>
        ) : null}
        <span title={session.display.title} data-design="row-title" {...stylex.props(styles.title)}>
          {session.display.title}
        </span>
        {placement === "archived" ? (
          <span data-design="row-metadata" {...stylex.props(styles.metadata)}>
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
          />
        )}
      </span>
    </Link>
  );
}
