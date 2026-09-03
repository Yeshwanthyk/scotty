import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  ChevronDown,
  Ellipsis,
  MonitorSmartphone,
  Plus,
  Search,
  Server,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readCurrentPrincipal } from "../data/admin";
import { Button } from "./Button";
import { SessionRow, type SessionRowProps } from "./SessionRow";
import { colors, spacing } from "../theme/tokens.stylex";
import scottyMark from "../../../worker/public/brand/scotty-mark-128.png?url";

export interface RepositoryGroup {
  readonly name: string;
  readonly sessions: ReadonlyArray<SessionRowProps>;
}

const styles = stylex.create({
  sidebar: {
    width: "264px",
    height: "100dvh",
    minWidth: "264px",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderRightColor: colors.line,
    backgroundColor: colors.shell,
    "@media (max-width: 760px)": {
      position: "fixed",
      zIndex: 40,
      insetBlock: 0,
      insetInlineStart: 0,
      width: "min(88vw, 320px)",
      minWidth: 0,
      transform: "translateX(-105%)",
      boxShadow: "22px 0 60px rgb(0 0 0 / 0.45)",
      transitionProperty: "transform",
      transitionDuration: "180ms",
      transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  },
  sidebarOpen: {
    "@media (max-width: 760px)": {
      transform: "translateX(0)",
    },
  },
  header: {
    paddingBlock: spacing.md,
    paddingInline: spacing.sm,
    display: "grid",
    gap: spacing.xs,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  brand: {
    minHeight: "38px",
    paddingInline: spacing.sm,
    display: "grid",
    gridTemplateColumns: "22px minmax(0, 1fr)",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: "7px",
    color: colors.ink,
    fontSize: "13px",
    fontWeight: 700,
    textDecoration: "none",
    ":hover": { backgroundColor: colors.panelRaised },
    "@media (max-width: 760px)": { minHeight: "44px" },
  },
  brandRow: {
    minHeight: "38px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: spacing.xs,
  },
  brandActions: { position: "relative", display: "flex", alignItems: "center", gap: spacing.xs },
  menu: { position: "relative" },
  menuSummary: {
    width: "36px",
    height: "36px",
    display: "grid",
    placeItems: "center",
    borderRadius: "7px",
    color: colors.quiet,
    cursor: "pointer",
    listStyle: "none",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
    "::-webkit-details-marker": { display: "none" },
  },
  menuPanel: {
    position: "absolute",
    zIndex: 20,
    top: "calc(100% + 6px)",
    right: 0,
    width: "224px",
    padding: spacing.sm,
    display: "grid",
    gap: "2px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "8px",
    backgroundColor: colors.panelRaised,
    boxShadow: "0 4px 8px rgb(0 0 0 / 35%)",
  },
  menuItem: {
    minHeight: "40px",
    paddingInline: spacing.sm,
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr)",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: "6px",
    color: colors.muted,
    fontSize: "12px",
    textDecoration: "none",
    ":hover": { backgroundColor: colors.control, color: colors.ink },
    "@media (max-width: 760px)": { minHeight: "44px" },
  },
  menuItemAction: { color: colors.ink, fontWeight: 650 },
  menuItemLocked: {
    color: colors.quiet,
    cursor: "not-allowed",
    ":hover": { backgroundColor: "transparent", color: colors.quiet },
  },
  menuLabel: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  menuHint: { color: colors.quiet, fontSize: "10px" },
  menuIcon: { width: "15px", height: "15px", strokeWidth: 1.8 },
  mark: {
    width: "22px",
    height: "22px",
    display: "block",
    borderRadius: "6px",
    objectFit: "cover",
  },
  search: {
    height: "40px",
    paddingInline: spacing.sm,
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: "6px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    cursor: "text",
    transitionProperty: "background-color, border-color",
    transitionDuration: "120ms",
    transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
    ":hover": { backgroundColor: colors.panel },
    ":focus-within": {
      borderBottomColor: colors.focus,
      backgroundColor: colors.panelRaised,
    },
    "@media (max-width: 760px)": { height: "44px" },
  },
  searchIcon: { width: "14px", height: "14px", color: colors.quiet, strokeWidth: 1.8 },
  searchInput: {
    width: "100%",
    minWidth: 0,
    height: "28px",
    padding: 0,
    appearance: "none",
    borderWidth: "0px",
    outline: 0,
    backgroundColor: "transparent",
    color: colors.ink,
    fontSize: "13px",
    ":focus-visible": { outline: "none" },
    "::placeholder": { color: colors.muted },
    "::-webkit-search-cancel-button": { display: "none" },
  },
  shortcut: { color: colors.quiet, fontSize: "10px", fontVariantNumeric: "tabular-nums" },
  navigation: {
    minHeight: 0,
    paddingBlock: spacing.sm,
    paddingInline: spacing.sm,
    overflowY: "auto",
  },
  repository: { marginBottom: spacing.md },
  archive: {
    marginTop: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.line,
  },
  summary: {
    minHeight: "34px",
    paddingInline: spacing.xs,
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: "6px",
    color: colors.quiet,
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 650,
    listStyle: "none",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.muted },
    "::-webkit-details-marker": { display: "none" },
    "@media (max-width: 760px)": { minHeight: "44px" },
  },
  chevron: { width: "13px", height: "13px", strokeWidth: 1.8 },
  repoName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  count: {
    marginLeft: "auto",
    color: colors.quiet,
    fontSize: "10px",
    fontVariantNumeric: "tabular-nums",
  },
  list: { display: "grid", gap: "2px" },
  empty: { margin: `${spacing.xs} ${spacing.xs}`, color: colors.quiet, fontSize: "11px" },
  showMore: {
    minHeight: "40px",
    marginTop: spacing.xs,
    paddingInline: spacing.sm,
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.quiet,
    cursor: "pointer",
    fontSize: "11px",
    ":hover": { color: colors.muted },
  },
  close: {
    display: "none",
    "@media (max-width: 760px)": { display: "inline-flex" },
  },
  icon: { width: "14px", height: "14px", strokeWidth: 1.8 },
});

const searchableText = (row: SessionRowProps): string =>
  [
    row.session.display.title,
    row.session.display.repository,
    row.session.display.branch,
    row.session.id,
    row.presentation.railLabel,
  ]
    .join(" ")
    .toLocaleLowerCase("en-US");

const filterGroups = (
  repositories: ReadonlyArray<RepositoryGroup>,
  query: string,
): ReadonlyArray<RepositoryGroup> => {
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  if (normalizedQuery.length === 0) return repositories;

  return repositories
    .map((repository) => ({
      ...repository,
      sessions: repository.sessions.filter((session) =>
        searchableText(session).includes(normalizedQuery),
      ),
    }))
    .filter((repository) => repository.sessions.length > 0);
};

export function Sidebar({
  archivedSessions = [],
  onClose,
  onOpen,
  open = false,
  repositories,
}: {
  readonly archivedSessions?: ReadonlyArray<SessionRowProps>;
  readonly onClose?: () => void;
  readonly onOpen?: () => void;
  readonly open?: boolean;
  readonly repositories: ReadonlyArray<RepositoryGroup>;
}) {
  const [query, setQuery] = useState("");
  const [showAllArchived, setShowAllArchived] = useState(false);
  const [owner, setOwner] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const visibleRepositories = filterGroups(repositories, query);
  const visibleActiveSessions = visibleRepositories.flatMap((repository) => repository.sessions);
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const visibleArchivedSessions = archivedSessions.filter(
    (session) => normalizedQuery.length === 0 || searchableText(session).includes(normalizedQuery),
  );
  const shownArchivedSessions =
    showAllArchived || normalizedQuery.length > 0
      ? visibleArchivedSessions
      : visibleArchivedSessions.slice(0, 10);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      onOpen?.();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [onOpen]);

  useEffect(() => {
    let active = true;
    void readCurrentPrincipal().then((result) => {
      if (active && result.ok) setOwner(result.value.role === "owner");
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <aside
      id="session-navigation"
      aria-label="Session navigation"
      {...stylex.props(styles.sidebar, open && styles.sidebarOpen)}
    >
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.brandRow)}>
          <Link
            to="/sessions"
            aria-label="Scotty sessions"
            onClick={onClose}
            {...stylex.props(styles.brand)}
          >
            <img src={scottyMark} alt="" width={22} height={22} {...stylex.props(styles.mark)} />
            <span>Scotty</span>
          </Link>
          <div {...stylex.props(styles.brandActions)}>
            <details {...stylex.props(styles.menu)}>
              <summary aria-label="Open Scotty menu" {...stylex.props(styles.menuSummary)}>
                <Ellipsis aria-hidden {...stylex.props(styles.menuIcon)} />
              </summary>
              <nav aria-label="Scotty menu" {...stylex.props(styles.menuPanel)}>
                <Link
                  to="/sessions/create"
                  onClick={onClose}
                  {...stylex.props(styles.menuItem, styles.menuItemAction)}
                >
                  <Plus aria-hidden {...stylex.props(styles.menuIcon)} />
                  <span {...stylex.props(styles.menuLabel)}>Create session</span>
                </Link>
                <Link to="/stats" onClick={onClose} {...stylex.props(styles.menuItem)}>
                  <BarChart3 aria-hidden {...stylex.props(styles.menuIcon)} />
                  <span {...stylex.props(styles.menuLabel)}>Stats</span>
                </Link>
                {owner ? (
                  <Link to="/providers" onClick={onClose} {...stylex.props(styles.menuItem)}>
                    <Server aria-hidden {...stylex.props(styles.menuIcon)} />
                    <span {...stylex.props(styles.menuLabel)}>Providers &amp; runners</span>
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    {...stylex.props(styles.menuItem, styles.menuItemLocked)}
                  >
                    <Server aria-hidden {...stylex.props(styles.menuIcon)} />
                    <span {...stylex.props(styles.menuLabel)}>
                      Providers &amp; runners
                      <span {...stylex.props(styles.menuHint)}>Primary</span>
                    </span>
                  </span>
                )}
                {owner ? (
                  <Link to="/devices" onClick={onClose} {...stylex.props(styles.menuItem)}>
                    <MonitorSmartphone aria-hidden {...stylex.props(styles.menuIcon)} />
                    <span {...stylex.props(styles.menuLabel)}>Devices</span>
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    {...stylex.props(styles.menuItem, styles.menuItemLocked)}
                  >
                    <MonitorSmartphone aria-hidden {...stylex.props(styles.menuIcon)} />
                    <span {...stylex.props(styles.menuLabel)}>
                      Devices
                      <span {...stylex.props(styles.menuHint)}>Primary</span>
                    </span>
                  </span>
                )}
              </nav>
            </details>
            <span {...stylex.props(styles.close)}>
              <Button
                aria-label="Close session navigation"
                iconOnly
                variant="quiet"
                onClick={onClose}
              >
                <X aria-hidden {...stylex.props(styles.icon)} />
              </Button>
            </span>
          </div>
        </div>
        <label {...stylex.props(styles.search)}>
          <Search aria-hidden {...stylex.props(styles.searchIcon)} />
          <input
            ref={searchInputRef}
            aria-label="Search sessions"
            type="search"
            placeholder="Search sessions"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            {...stylex.props(styles.searchInput)}
          />
          <kbd {...stylex.props(styles.shortcut)}>⌘K</kbd>
        </label>
      </header>
      <nav aria-label="Repositories" data-scrollbar="quiet" {...stylex.props(styles.navigation)}>
        {visibleActiveSessions.length === 0 && visibleArchivedSessions.length === 0 ? (
          <p {...stylex.props(styles.empty)}>
            {query.trim().length > 0 ? "No matching sessions" : "No sessions yet"}
          </p>
        ) : (
          <>
            <div {...stylex.props(styles.list)}>
              {visibleActiveSessions.map((session) => (
                <SessionRow key={session.session.id} {...session} onNavigate={onClose} />
              ))}
            </div>
            {visibleArchivedSessions.length > 0 ? (
              <details open {...stylex.props(styles.repository, styles.archive)}>
                <summary {...stylex.props(styles.summary)}>
                  <ChevronDown aria-hidden {...stylex.props(styles.chevron)} />
                  <span {...stylex.props(styles.repoName)}>Archived</span>
                  <span {...stylex.props(styles.count)}>{visibleArchivedSessions.length}</span>
                </summary>
                <div {...stylex.props(styles.list)}>
                  {shownArchivedSessions.map((session) => (
                    <SessionRow key={session.session.id} {...session} onNavigate={onClose} />
                  ))}
                  {visibleArchivedSessions.length > shownArchivedSessions.length ? (
                    <button
                      type="button"
                      onClick={() => setShowAllArchived(true)}
                      {...stylex.props(styles.showMore)}
                    >
                      <Plus aria-hidden {...stylex.props(styles.chevron)} />
                      Show {visibleArchivedSessions.length - shownArchivedSessions.length} more
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </>
        )}
      </nav>
    </aside>
  );
}
