import * as stylex from "@stylexjs/stylex";
import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Menu, Search, X } from "lucide-react";
import { Sidebar } from "./Sidebar";
import type { SessionRowProps } from "./SessionRow";
import { colors } from "../theme/tokens.stylex";
import { useSessionCatalog } from "../data/session-catalog";
import { buildSessionRail } from "../domain/session-rail";
import { SessionSwitcher, type SessionSwitcherHandle } from "./SessionSwitcher";

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
    borderWidth: 0,
    borderStyle: "solid",
    appearance: "none",
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "2px" },
  },
  mobileTitle: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    margin: 0,
    color: colors.ink,
    fontSize: "13px",
    fontWeight: 650,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  mobileIcon: { width: "18px", height: "18px", strokeWidth: 1.8 },
  mobileActions: { marginLeft: "auto", display: "flex", alignItems: "center" },
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
  children,
  mobileTitleHeading = false,
  mobileTitle,
}: {
  readonly children: ReactNode;
  readonly mobileTitleHeading?: boolean;
  readonly mobileTitle?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const catalog = useSessionCatalog();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const selectedId = /^\/s\/([^/]+)$/u.exec(pathname)?.[1];
  const selectedActor =
    selectedId === undefined ? undefined : catalog.verifiedActors.get(selectedId);
  const rail = buildSessionRail(catalog.sessions, { selectedActor });
  const main = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const menuOpener = useRef<HTMLButtonElement>(null);
  const switcher = useRef<SessionSwitcherHandle>(null);
  const selectRow = (row: SessionRowProps) => ({
    ...row,
    selected: row.session.id === selectedId,
  });
  const catalogRepositories = rail.repositories.map((repository) => ({
    ...repository,
    sessions: repository.sessions.map(selectRow),
  }));
  const catalogArchived = rail.archivedSessions.map(selectRow);
  const sessions = [
    ...catalogRepositories.flatMap((repository) => repository.sessions),
    ...catalogArchived,
  ];

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    main.current?.setAttribute("inert", "");
    navigation.current
      ?.querySelector<HTMLElement>('[aria-label="Close session navigation"]')
      ?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === "Escape") {
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(navigation.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      main.current?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
      menuOpener.current?.focus();
    };
  }, [mobileOpen]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 761px)");
    const closeAtDesktop = () => {
      if (media.matches) setMobileOpen(false);
    };
    media.addEventListener("change", closeAtDesktop);
    return () => media.removeEventListener("change", closeAtDesktop);
  }, []);

  const openSearch = (opener: HTMLElement): void => {
    if (!mobileOpen) {
      switcher.current?.open(opener);
      return;
    }
    setMobileOpen(false);
    window.requestAnimationFrame(() => switcher.current?.open(menuOpener.current));
  };

  return (
    <div {...stylex.props(styles.shell)}>
      <Sidebar
        archivedSessions={catalogArchived}
        navigationRef={navigation}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        onSearch={openSearch}
        repositories={catalogRepositories}
      />
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close session navigation"
          onClick={() => setMobileOpen(false)}
          {...stylex.props(styles.backdrop)}
        />
      ) : null}
      <main ref={main} data-scrollbar="quiet" {...stylex.props(styles.main)}>
        <div data-design="mobile-navigation" {...stylex.props(styles.mobileBar)}>
          <button
            ref={menuOpener}
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
          {mobileTitle ? (
            mobileTitleHeading ? (
              <h1 {...stylex.props(styles.mobileTitle)}>{mobileTitle}</h1>
            ) : (
              <span {...stylex.props(styles.mobileTitle)}>{mobileTitle}</span>
            )
          ) : null}
          <span {...stylex.props(styles.mobileActions)}>
            <button
              type="button"
              aria-label="Search sessions"
              onClick={(event) => openSearch(event.currentTarget)}
              {...stylex.props(styles.mobileMenu)}
            >
              <Search aria-hidden {...stylex.props(styles.mobileIcon)} />
            </button>
          </span>
        </div>
        {children}
      </main>
      <SessionSwitcher ref={switcher} onNavigate={() => setMobileOpen(false)} sessions={sessions} />
    </div>
  );
}
