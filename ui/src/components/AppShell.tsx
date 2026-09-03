import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Sidebar, type RepositoryGroup } from "./Sidebar";
import { colors } from "../theme/tokens.stylex";

const styles = stylex.create({
  shell: {
    minHeight: "100dvh",
    display: "flex",
    overflow: "hidden",
    backgroundColor: colors.space,
  },
  main: {
    minWidth: 0,
    minHeight: "100dvh",
    flex: 1,
    overflow: "auto",
  },
  mobileBar: {
    display: "none",
    "@media (max-width: 760px)": {
      minHeight: "52px",
      paddingInline: "12px",
      display: "flex",
      alignItems: "center",
      borderBottomWidth: "1px",
      borderBottomStyle: "solid",
      borderBottomColor: colors.line,
      backgroundColor: colors.shell,
    },
  },
  mobileMenu: {
    minWidth: "44px",
    minHeight: "44px",
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: 0,
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
  },
  mobileTitle: { color: colors.ink, fontSize: "13px", fontWeight: 650 },
  mobileIcon: { width: "18px", height: "18px", strokeWidth: 1.8 },
  backdrop: {
    display: "none",
    "@media (max-width: 760px)": {
      position: "fixed",
      zIndex: 30,
      inset: 0,
      display: "block",
      border: 0,
      backgroundColor: "rgb(0 0 0 / 0.56)",
    },
  },
});

export function AppShell({
  archivedSessions = [],
  children,
  repositories,
}: {
  readonly archivedSessions?: ReadonlyArray<RepositoryGroup["sessions"][number]>;
  readonly children: ReactNode;
  readonly repositories: ReadonlyArray<RepositoryGroup>;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return (
    <div {...stylex.props(styles.shell)}>
      <Sidebar
        archivedSessions={archivedSessions}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        onOpen={() => setMobileOpen(true)}
        repositories={repositories}
      />
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close session navigation"
          onClick={() => setMobileOpen(false)}
          {...stylex.props(styles.backdrop)}
        />
      ) : null}
      <main data-scrollbar="quiet" {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.mobileBar)}>
          <button
            type="button"
            aria-controls="session-navigation"
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? "Close session navigation" : "Open session navigation"}
            onClick={() => setMobileOpen((open) => !open)}
            {...stylex.props(styles.mobileMenu)}
          >
            {mobileOpen ? (
              <X aria-hidden {...stylex.props(styles.mobileIcon)} />
            ) : (
              <Menu aria-hidden {...stylex.props(styles.mobileIcon)} />
            )}
          </button>
          <span {...stylex.props(styles.mobileTitle)}>Sessions</span>
        </div>
        {children}
      </main>
    </div>
  );
}
