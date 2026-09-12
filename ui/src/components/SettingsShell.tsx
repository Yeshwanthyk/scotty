import * as stylex from "@stylexjs/stylex";
import {
  ArrowLeft,
  Check,
  KeyRound,
  Package,
  Settings2,
  SlidersHorizontal,
  Boxes,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { colors, spacing } from "../theme/tokens.stylex";

const items = [
  { id: "agents", label: "Agents", icon: SlidersHorizontal },
  { id: "repositories", label: "Repositories", icon: Boxes },
  { id: "environment", label: "Environment", icon: KeyRound },
  { id: "resources", label: "Skills & resources", icon: Package },
  { id: "connections", label: "Connections", icon: Settings2 },
] as const;
export type SettingsPane = (typeof items)[number]["id"];

const styles = stylex.create({
  shell: {
    minHeight: "100dvh",
    display: "grid",
    gridTemplateColumns: "220px minmax(0, 1fr)",
    backgroundColor: colors.space,
    "@media (max-width: 760px)": { display: "block" },
  },
  rail: {
    minHeight: "100dvh",
    padding: spacing.lg,
    display: "flex",
    flexDirection: "column",
    gap: spacing.xl,
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderRightColor: colors.line,
    backgroundColor: colors.shell,
    "@media (max-width: 760px)": {
      minHeight: "auto",
      padding: `${spacing.sm} ${spacing.md}`,
      borderRight: 0,
      borderBottomWidth: "1px",
      borderBottomStyle: "solid",
      borderBottomColor: colors.line,
      gap: spacing.sm,
    },
  },
  back: {
    minHeight: "36px",
    paddingInline: spacing.xs,
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.quiet,
    fontSize: "13px",
    textDecoration: "none",
    ":hover": { color: colors.ink },
  },
  backIcon: { width: "14px", height: "14px", strokeWidth: 1.8 },
  heading: {
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.ink,
    fontSize: "16px",
    fontWeight: 680,
  },
  headingIcon: { width: "17px", height: "17px", color: colors.accent, strokeWidth: 1.8 },
  nav: {
    display: "grid",
    gap: "2px",
    "@media (max-width: 760px)": {
      display: "flex",
      overflowX: "auto",
      gap: spacing.xs,
      paddingBottom: spacing.xs,
    },
  },
  navLink: {
    minHeight: "40px",
    paddingInline: spacing.sm,
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: "6px",
    color: colors.muted,
    fontSize: "13px",
    textDecoration: "none",
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "transparent",
    textAlign: "left",
    backgroundColor: "transparent",
    cursor: "pointer",
    appearance: "none",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: colors.focus,
      outlineOffset: "2px",
    },
    "@media (max-width: 760px)": { minHeight: "34px", paddingInline: spacing.md },
  },
  navLinkActive: { backgroundColor: colors.panelRaised, color: colors.ink, fontWeight: 650 },
  navIcon: { width: "15px", height: "15px", strokeWidth: 1.8 },
  main: { minWidth: 0, minHeight: "100dvh", overflow: "auto" },
  status: {
    position: "fixed",
    right: spacing.xl,
    bottom: spacing.xl,
    zIndex: 5,
    minHeight: "30px",
    paddingInline: spacing.md,
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "7px",
    backgroundColor: colors.panelRaised,
    color: colors.success,
    fontSize: "11px",
    "@media (max-width: 760px)": { right: spacing.md, bottom: spacing.md },
  },
  statusIcon: { width: "14px", height: "14px", strokeWidth: 2 },
});

export function SettingsShell({
  children,
  status,
  active,
  onSelect,
}: {
  readonly children: ReactNode;
  readonly status?: string;
  readonly active: SettingsPane;
  readonly onSelect: (pane: SettingsPane) => void;
}) {
  return (
    <div {...stylex.props(styles.shell)}>
      <aside aria-label="Settings navigation" {...stylex.props(styles.rail)}>
        <Link to="/sessions" {...stylex.props(styles.back)}>
          <ArrowLeft aria-hidden {...stylex.props(styles.backIcon)} />
          Back to sessions
        </Link>
        <div {...stylex.props(styles.heading)}>
          <Settings2 aria-hidden {...stylex.props(styles.headingIcon)} />
          Settings
        </div>
        <nav aria-label="Settings sections" {...stylex.props(styles.nav)}>
          {items.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              aria-current={active === id ? "page" : undefined}
              onClick={() => onSelect(id)}
              {...stylex.props(styles.navLink, active === id && styles.navLinkActive)}
            >
              <Icon aria-hidden {...stylex.props(styles.navIcon)} />
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main data-scrollbar="quiet" {...stylex.props(styles.main)}>
        {children}
      </main>
      {status === undefined ? null : (
        <output aria-live="polite" {...stylex.props(styles.status)}>
          <Check aria-hidden {...stylex.props(styles.statusIcon)} />
          {status}
        </output>
      )}
    </div>
  );
}
