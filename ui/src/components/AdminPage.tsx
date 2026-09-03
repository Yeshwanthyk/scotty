import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import type { SessionListReadResult } from "../data/session-list-reader";
import { buildSessionRail } from "../domain/session-rail";
import { colors, spacing } from "../theme/tokens.stylex";
import { AppShell } from "./AppShell";

const styles = stylex.create({
  page: {
    width: "min(920px, 100%)",
    marginInline: "auto",
    padding: "48px clamp(20px, 5vw, 56px) 72px",
    display: "grid",
    gap: spacing.xxl,
    "@media (max-width: 760px)": { paddingBlock: spacing.xl, paddingInline: spacing.lg },
  },
  heading: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.xl,
    "@media (max-width: 600px)": { flexDirection: "column", gap: spacing.md },
  },
  headingCopy: { minWidth: 0, display: "grid", gap: spacing.sm },
  title: {
    margin: 0,
    color: colors.ink,
    fontSize: "28px",
    fontWeight: 680,
    lineHeight: 1.1,
    letterSpacing: "-0.025em",
    textWrap: "balance",
  },
  description: {
    maxWidth: "68ch",
    margin: 0,
    color: colors.muted,
    fontSize: "14px",
    lineHeight: 1.55,
    textWrap: "pretty",
  },
  section: { display: "grid", gap: spacing.md },
  sectionHeading: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: spacing.lg,
    "@media (max-width: 600px)": { alignItems: "flex-start", flexDirection: "column" },
  },
  sectionCopy: { minWidth: 0, display: "grid", gap: spacing.xs },
  sectionTitle: { margin: 0, color: colors.ink, fontSize: "14px", fontWeight: 650 },
  sectionDescription: {
    maxWidth: "68ch",
    margin: 0,
    color: colors.quiet,
    fontSize: "12px",
    lineHeight: 1.5,
  },
  rows: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: colors.line },
  row: {
    minHeight: "68px",
    paddingBlock: spacing.md,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.xl,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
    "@media (max-width: 600px)": {
      minHeight: "auto",
      alignItems: "flex-start",
      flexDirection: "column",
      gap: spacing.md,
    },
  },
  rowCopy: { minWidth: 0, display: "grid", gap: spacing.xs },
  rowTitle: {
    margin: 0,
    overflow: "hidden",
    color: colors.ink,
    fontSize: "13px",
    fontWeight: 620,
    textOverflow: "ellipsis",
  },
  rowDescription: {
    margin: 0,
    color: colors.quiet,
    fontSize: "11px",
    lineHeight: 1.45,
  },
  rowAside: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: spacing.sm,
    "@media (max-width: 600px)": { width: "100%", justifyContent: "flex-start" },
  },
  status: {
    minHeight: "24px",
    paddingInline: spacing.sm,
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "6px",
    backgroundColor: colors.panelRaised,
    color: colors.muted,
    fontSize: "11px",
    fontWeight: 620,
  },
  statusGood: { color: colors.success },
  statusWarning: { color: colors.warning },
  statusDanger: { color: colors.danger },
  empty: {
    minHeight: "88px",
    paddingBlock: spacing.xl,
    color: colors.quiet,
    fontSize: "13px",
    lineHeight: 1.5,
  },
  error: {
    margin: 0,
    padding: spacing.md,
    borderRadius: "8px",
    backgroundColor: "color-mix(in srgb, #ff8278 10%, transparent)",
    color: colors.danger,
    fontSize: "12px",
    lineHeight: 1.5,
  },
});

export function AdminPage({
  action,
  children,
  description,
  title,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.heading)}>
        <div {...stylex.props(styles.headingCopy)}>
          <h1 {...stylex.props(styles.title)}>{title}</h1>
          <p {...stylex.props(styles.description)}>{description}</p>
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}

export function AdminAppShell({
  children,
  sessions,
  title,
}: {
  readonly children: ReactNode;
  readonly sessions: SessionListReadResult;
  readonly title: string;
}) {
  const rail = buildSessionRail(
    sessions.ok ? sessions.projections.map(({ session }) => session) : [],
  );
  return (
    <AppShell
      archivedSessions={rail.archivedSessions}
      mobileTitle={title}
      repositories={rail.repositories}
    >
      {children}
    </AppShell>
  );
}

export function AdminSection({
  action,
  children,
  description,
  title,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly description?: string;
  readonly title: string;
}) {
  return (
    <section {...stylex.props(styles.section)}>
      <header {...stylex.props(styles.sectionHeading)}>
        <div {...stylex.props(styles.sectionCopy)}>
          <h2 {...stylex.props(styles.sectionTitle)}>{title}</h2>
          {description === undefined ? null : (
            <p {...stylex.props(styles.sectionDescription)}>{description}</p>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function AdminRows({ children }: { readonly children: ReactNode }) {
  return <div {...stylex.props(styles.rows)}>{children}</div>;
}

export function AdminRow({
  aside,
  description,
  title,
}: {
  readonly aside?: ReactNode;
  readonly description?: ReactNode;
  readonly title: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowCopy)}>
        <p {...stylex.props(styles.rowTitle)}>{title}</p>
        {description === undefined ? null : (
          <p {...stylex.props(styles.rowDescription)}>{description}</p>
        )}
      </div>
      {aside === undefined ? null : <div {...stylex.props(styles.rowAside)}>{aside}</div>}
    </div>
  );
}

export function AdminStatus({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: "danger" | "good" | "neutral" | "warning";
}) {
  return (
    <span
      {...stylex.props(
        styles.status,
        tone === "good" && styles.statusGood,
        tone === "warning" && styles.statusWarning,
        tone === "danger" && styles.statusDanger,
      )}
    >
      {children}
    </span>
  );
}

export function AdminEmpty({ children }: { readonly children: ReactNode }) {
  return <div {...stylex.props(styles.empty)}>{children}</div>;
}

export function AdminError({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" {...stylex.props(styles.error)}>
      {children}
    </p>
  );
}
