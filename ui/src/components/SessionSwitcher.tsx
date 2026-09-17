import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRowProps } from "./SessionRow";
import { colors, motion, spacing } from "../theme/tokens.stylex";

const styles = stylex.create({
  trigger: {
    width: "100%",
    height: "40px",
    paddingInline: spacing.sm,
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    fontSize: "13px",
    textAlign: "left",
    transitionProperty: "background-color, color",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.easeOut,
    ":hover": { backgroundColor: colors.panel, color: colors.ink },
    "@media (max-width: 760px)": { height: "44px" },
  },
  searchIcon: { width: "14px", height: "14px", color: colors.quiet, strokeWidth: 1.8 },
  shortcut: { color: colors.quiet, fontSize: "10px", fontVariantNumeric: "tabular-nums" },
  dialog: {
    width: "min(560px, calc(100vw - 32px))",
    maxHeight: "min(620px, calc(100dvh - 48px))",
    marginBlock: "clamp(24px, 12vh, 120px) auto",
    padding: 0,
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.lineHover,
    borderRadius: "12px",
    backgroundColor: colors.shell,
    color: colors.ink,
    boxShadow: "0 24px 72px rgb(0 0 0 / 55%)",
    "::backdrop": { backgroundColor: "rgb(0 0 0 / 62%)" },
  },
  heading: {
    margin: 0,
    padding: `${spacing.md} ${spacing.lg} 0`,
    color: colors.quiet,
    fontSize: "11px",
    fontWeight: 650,
  },
  inputRow: {
    minHeight: "52px",
    margin: spacing.sm,
    paddingInline: spacing.md,
    display: "grid",
    gridTemplateColumns: "18px minmax(0, 1fr)",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "8px",
    backgroundColor: colors.control,
    ":focus-within": { borderColor: colors.focus },
  },
  input: {
    width: "100%",
    minWidth: 0,
    height: "44px",
    padding: 0,
    borderWidth: 0,
    outline: 0,
    backgroundColor: "transparent",
    color: colors.ink,
    fontSize: "14px",
    "::placeholder": { color: colors.muted },
  },
  results: {
    maxHeight: "min(460px, calc(100dvh - 180px))",
    margin: 0,
    padding: spacing.sm,
    overflowY: "auto",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.lineSoft,
    listStyle: "none",
  },
  option: {
    width: "100%",
    minHeight: "58px",
    padding: `9px ${spacing.md}`,
    display: "grid",
    gap: "3px",
    borderWidth: 0,
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    textAlign: "left",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
  },
  optionActive: { backgroundColor: colors.panelRaised, color: colors.ink },
  optionTitle: {
    overflow: "hidden",
    fontSize: "13px",
    fontWeight: 650,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  optionContext: {
    overflow: "hidden",
    color: colors.quiet,
    fontSize: "11px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  empty: { margin: 0, padding: spacing.xl, color: colors.quiet, fontSize: "12px" },
});

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.matches("input, textarea, select"));

export const matchesSessionQuery = (
  session: SessionRowProps["session"],
  normalizedQuery: string,
): boolean =>
  [session.display.title, session.display.repository, session.display.branch]
    .filter((part): part is string => part !== null)
    .join(" ")
    .toLocaleLowerCase("en-US")
    .includes(normalizedQuery);

export const moveSessionIndex = (current: number, length: number, delta: -1 | 1): number =>
  length === 0 ? 0 : (current + delta + length) % length;

export function SessionSwitcher({
  onNavigate,
  sessions,
}: {
  readonly onNavigate?: () => void;
  readonly sessions: ReadonlyArray<SessionRowProps>;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pathnameRef = useRef(pathname);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const filteredSessions = useMemo(
    () =>
      normalizedQuery.length === 0
        ? sessions
        : sessions.filter((session) => matchesSessionQuery(session.session, normalizedQuery)),
    [normalizedQuery, sessions],
  );

  const resultCount = filteredSessions.length + 1;

  const openSwitcher = useCallback((opener: HTMLElement | null) => {
    openerRef.current = opener;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, []);

  const closeSwitcher = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !open || dialog.open) return;
    dialog.showModal();
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, resultCount - 1));
  }, [resultCount]);

  useEffect(() => {
    if (!open) return;
    const active = filteredSessions[activeIndex - 1];
    optionRefs.current
      .get(activeIndex === 0 ? "create" : (active?.session.id ?? ""))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filteredSessions, open]);

  useEffect(() => {
    if (pathnameRef.current === pathname) return;
    pathnameRef.current = pathname;
    closeSwitcher();
  }, [closeSwitcher, pathname]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.isComposing ||
        event.key.toLocaleLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey)
      )
        return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".xterm") !== null) return;
      if (event.ctrlKey && !event.metaKey && isEditable(target)) return;
      event.preventDefault();
      if (open) inputRef.current?.focus();
      else openSwitcher(target instanceof HTMLElement ? target : null);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [open, openSwitcher]);

  const selectSession = (session: SessionRowProps): void => {
    closeSwitcher();
    onNavigate?.();
    void navigate({ to: "/s/$sessionId", params: { sessionId: session.session.id } });
  };

  const selectCreate = () => {
    closeSwitcher();
    onNavigate?.();
    void navigate({ to: "/sessions/create" });
  };

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={(event) => openSwitcher(event.currentTarget)}
        {...stylex.props(styles.trigger)}
      >
        <Search aria-hidden {...stylex.props(styles.searchIcon)} />
        <span>Search sessions</span>
        <kbd {...stylex.props(styles.shortcut)}>⌘K</kbd>
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="session-switcher-title"
        onCancel={() => setOpen(false)}
        onClose={() => {
          setOpen(false);
          openerRef.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSwitcher();
        }}
        {...stylex.props(styles.dialog)}
      >
        <h2 id="session-switcher-title" {...stylex.props(styles.heading)}>
          Sessions & actions
        </h2>
        <div {...stylex.props(styles.inputRow)}>
          <Search aria-hidden {...stylex.props(styles.searchIcon)} />
          <input
            ref={inputRef}
            aria-activedescendant={
              activeIndex === 0
                ? "session-switcher-create"
                : `session-switcher-option-${filteredSessions[activeIndex - 1]?.session.id}`
            }
            aria-controls="session-switcher-results"
            aria-expanded="true"
            aria-label="Search sessions"
            autoComplete="off"
            placeholder="Search sessions or start a new one…"
            role="combobox"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              const nextQuery = event.currentTarget.value.trim().toLocaleLowerCase("en-US");
              setActiveIndex(
                nextQuery &&
                  !"new session create start".includes(nextQuery) &&
                  sessions.some(({ session }) => matchesSessionQuery(session, nextQuery))
                  ? 1
                  : 0,
              );
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) => moveSessionIndex(current, resultCount, 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => moveSessionIndex(current, resultCount, -1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (activeIndex === 0) selectCreate();
                else {
                  const session = filteredSessions[activeIndex - 1];
                  if (session) selectSession(session);
                }
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSwitcher();
              }
            }}
            {...stylex.props(styles.input)}
          />
        </div>
        <ul
          id="session-switcher-results"
          role="listbox"
          aria-label="Sessions and actions"
          {...stylex.props(styles.results)}
        >
          <li role="presentation">
            <button
              ref={(element) => {
                if (element) optionRefs.current.set("create", element);
                else optionRefs.current.delete("create");
              }}
              id="session-switcher-create"
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={activeIndex === 0}
              onClick={selectCreate}
              onMouseEnter={() => setActiveIndex(0)}
              {...stylex.props(styles.option, activeIndex === 0 && styles.optionActive)}
            >
              <span {...stylex.props(styles.optionTitle)}>＋ New session</span>
              <span {...stylex.props(styles.optionContext)}>
                Choose a repository and start a task
              </span>
            </button>
          </li>
          {filteredSessions.map((session, index) => (
            <li key={session.session.id} role="presentation">
              <button
                ref={(element) => {
                  if (element === null) optionRefs.current.delete(session.session.id);
                  else optionRefs.current.set(session.session.id, element);
                }}
                id={`session-switcher-option-${session.session.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index + 1 === activeIndex}
                onClick={() => selectSession(session)}
                onMouseEnter={() => setActiveIndex(index + 1)}
                {...stylex.props(styles.option, index + 1 === activeIndex && styles.optionActive)}
              >
                <span {...stylex.props(styles.optionTitle)}>{session.session.display.title}</span>
                <span {...stylex.props(styles.optionContext)}>
                  {session.session.display.repository}
                  {session.session.display.branch === null
                    ? ""
                    : ` / ${session.session.display.branch}`}
                  {` · ${session.selected ? "Current" : session.presentation.railLabel}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {filteredSessions.length === 0 && normalizedQuery ? (
          <p {...stylex.props(styles.empty)}>No matching sessions. Start a new one above.</p>
        ) : null}
      </dialog>
    </>
  );
}
