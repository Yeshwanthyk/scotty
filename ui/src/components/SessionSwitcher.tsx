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

  const openSwitcher = useCallback(
    (opener: HTMLElement | null) => {
      openerRef.current = opener;
      setQuery("");
      setActiveIndex(
        Math.max(
          0,
          sessions.findIndex((session) => session.selected),
        ),
      );
      setOpen(true);
    },
    [sessions],
  );

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
    setActiveIndex((current) => Math.min(current, Math.max(0, filteredSessions.length - 1)));
  }, [filteredSessions.length]);

  useEffect(() => {
    const active = filteredSessions[activeIndex];
    if (!open || active === undefined) return;
    optionRefs.current.get(active.session.id)?.scrollIntoView({ block: "nearest" });
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
          Switch session
        </h2>
        <div {...stylex.props(styles.inputRow)}>
          <Search aria-hidden {...stylex.props(styles.searchIcon)} />
          <input
            ref={inputRef}
            aria-activedescendant={
              filteredSessions.length === 0
                ? undefined
                : `session-switcher-option-${filteredSessions[activeIndex]?.session.id}`
            }
            aria-controls={filteredSessions.length === 0 ? undefined : "session-switcher-results"}
            aria-expanded="true"
            aria-label="Search sessions"
            autoComplete="off"
            placeholder="Search by title, repository, or branch"
            role="combobox"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" && filteredSessions.length > 0) {
                event.preventDefault();
                setActiveIndex((current) => moveSessionIndex(current, filteredSessions.length, 1));
              } else if (event.key === "ArrowUp" && filteredSessions.length > 0) {
                event.preventDefault();
                setActiveIndex((current) => moveSessionIndex(current, filteredSessions.length, -1));
              } else if (event.key === "Enter" && filteredSessions[activeIndex] !== undefined) {
                event.preventDefault();
                selectSession(filteredSessions[activeIndex]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSwitcher();
              }
            }}
            {...stylex.props(styles.input)}
          />
        </div>
        {filteredSessions.length === 0 ? (
          <p {...stylex.props(styles.empty)}>No matching sessions</p>
        ) : (
          <ul id="session-switcher-results" role="listbox" {...stylex.props(styles.results)}>
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
                  aria-selected={index === activeIndex}
                  onClick={() => selectSession(session)}
                  onMouseEnter={() => setActiveIndex(index)}
                  {...stylex.props(styles.option, index === activeIndex && styles.optionActive)}
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
        )}
      </dialog>
    </>
  );
}
