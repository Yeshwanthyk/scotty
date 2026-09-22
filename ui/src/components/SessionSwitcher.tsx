import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  CircleAlert,
  LoaderCircle,
  MessageSquareText,
  Moon,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { colors, spacing } from "../theme/tokens.stylex";
import type { SessionRowProps } from "./SessionRow";

export interface SessionSwitcherHandle {
  readonly open: (opener: HTMLElement | null) => void;
}

const styles = stylex.create({
  dialog: {
    width: "min(600px, calc(100vw - 24px))",
    maxHeight: "min(640px, calc(100dvh - 24px))",
    marginBlock: "clamp(12px, 10vh, 96px) auto",
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
  top: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
  },
  inputRow: {
    minHeight: "52px",
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
    "@media (max-width: 760px)": { fontSize: "16px" },
  },
  icon: { width: "15px", height: "15px", color: colors.quiet, strokeWidth: 1.8 },
  close: {
    width: "44px",
    height: "44px",
    display: "none",
    placeItems: "center",
    padding: 0,
    borderWidth: 0,
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    "@media (max-width: 760px)": { display: "grid" },
  },
  results: {
    maxHeight: "min(460px, calc(100dvh - 170px))",
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
    gridTemplateColumns: "18px minmax(0, 1fr)",
    alignItems: "center",
    gap: spacing.md,
    borderWidth: 0,
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    textAlign: "left",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
  },
  optionActive: { backgroundColor: colors.panelRaised, color: colors.ink },
  copy: { minWidth: 0, display: "grid", gap: "3px" },
  title: {
    overflow: "hidden",
    fontSize: "13px",
    fontWeight: 650,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  context: {
    overflow: "hidden",
    color: colors.quiet,
    fontSize: "11px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  empty: {
    margin: 0,
    padding: spacing.xl,
    color: colors.quiet,
    fontSize: "12px",
    textAlign: "center",
  },
  footer: {
    minHeight: "38px",
    paddingInline: spacing.lg,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.lineSoft,
    color: colors.quiet,
    fontSize: "10px",
  },
  hints: { "@media (max-width: 760px)": { display: "none" } },
});

const normalize = (value: string): string => value.trim().toLocaleLowerCase("en-US");
const termsFor = (query: string): ReadonlyArray<string> =>
  normalize(query).split(/\s+/u).filter(Boolean);
const fieldScore = (field: string | null, term: string, weight: number): number => {
  if (field === null) return 0;
  const value = normalize(field);
  if (value === term) return weight + 30;
  if (value.split(/[^a-z0-9]+/u).some((part) => part.startsWith(term))) return weight + 15;
  return value.includes(term) ? weight : 0;
};
export const scoreSessionQuery = (session: SessionRowProps["session"], query: string): number => {
  const terms = termsFor(query);
  if (terms.length === 0) return 1;
  let total = 0;
  for (const term of terms) {
    const score = Math.max(
      fieldScore(session.display.title, term, 60),
      fieldScore(session.display.repository, term, 35),
      fieldScore(session.display.branch, term, 25),
    );
    if (score === 0) return 0;
    total += score;
  }
  return total;
};
export const matchesSessionQuery = (session: SessionRowProps["session"], query: string): boolean =>
  scoreSessionQuery(session, query) > 0;
export const matchesCreateQuery = (query: string): boolean => {
  const terms = termsFor(query);
  return terms.every((term) => ["new", "create", "start", "session", "task"].includes(term));
};
export const moveSessionIndex = (current: number, length: number, delta: -1 | 1): number =>
  length === 0 ? 0 : (current + delta + length) % length;

type Result =
  | { readonly kind: "create" }
  | { readonly kind: "session"; readonly row: SessionRowProps };

function SessionResultIcon({ row }: { readonly row: SessionRowProps }) {
  if (row.placement === "archived") return <Archive aria-hidden {...stylex.props(styles.icon)} />;
  if (row.presentation.operation !== null || row.presentation.destructiveProgress)
    return <LoaderCircle aria-hidden {...stylex.props(styles.icon)} />;
  if (
    row.presentation.authority.kind === "stable" &&
    row.presentation.authority.lifecycle === "failed"
  )
    return <CircleAlert aria-hidden {...stylex.props(styles.icon)} />;
  if (
    row.presentation.authority.kind === "stable" &&
    row.presentation.authority.lifecycle === "sleeping"
  )
    return <Moon aria-hidden {...stylex.props(styles.icon)} />;
  return <MessageSquareText aria-hidden {...stylex.props(styles.icon)} />;
}

export function SessionSwitcher({
  onNavigate,
  ref,
  sessions,
}: {
  readonly onNavigate?: () => void;
  readonly ref?: Ref<SessionSwitcherHandle>;
  readonly sessions: ReadonlyArray<SessionRowProps>;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pathnameRef = useRef(pathname);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const keyboardNavigation = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [requestedIndex, setRequestedIndex] = useState(0);
  const results = useMemo<ReadonlyArray<Result>>(() => {
    if (!open) return [];
    const ranked = sessions
      .map((row, order) => ({ row, order, score: scoreSessionQuery(row.session, query) }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || Number(b.row.selected) - Number(a.row.selected) || a.order - b.order,
      );
    return [
      ...(matchesCreateQuery(query) ? [{ kind: "create" } as const] : []),
      ...ranked.map(({ row }) => ({ kind: "session" as const, row })),
    ];
  }, [open, query, sessions]);
  const activeIndex = Math.min(requestedIndex, Math.max(0, results.length - 1));
  const active = results[activeIndex];
  const openSwitcher = useCallback((opener: HTMLElement | null) => {
    openerRef.current = opener;
    openingRef.current = true;
    setQuery("");
    setRequestedIndex(0);
    setOpen(true);
  }, []);
  useImperativeHandle(ref, () => ({ open: openSwitcher }), [openSwitcher]);
  const close = useCallback(() => dialogRef.current?.close(), []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !open || dialog.open) return;
    dialog.showModal();
    inputRef.current?.focus();
    openingRef.current = false;
  }, [open]);
  useEffect(() => {
    if (pathnameRef.current === pathname) return;
    pathnameRef.current = pathname;
    close();
  }, [close, pathname]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.isComposing ||
        event.key.toLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey)
      )
        return;
      if (event.target instanceof HTMLElement && event.target.closest(".xterm") !== null) return;
      event.preventDefault();
      if (open) inputRef.current?.focus();
      else openSwitcher(event.target instanceof HTMLElement ? event.target : null);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [open, openSwitcher]);
  useEffect(() => {
    if (!open || !keyboardNavigation.current) return;
    keyboardNavigation.current = false;
    const id = active?.kind === "session" ? active.row.session.id : active?.kind;
    if (id) optionRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
  }, [active, activeIndex, open]);
  const choose = (result: Result | undefined): void => {
    if (!result) return;
    close();
    onNavigate?.();
    if (result.kind === "create") void navigate({ to: "/sessions/create" });
    else void navigate({ to: "/s/$sessionId", params: { sessionId: result.row.session.id } });
  };
  return (
    <dialog
      ref={dialogRef}
      aria-label="Search sessions"
      onCancel={() => setOpen(false)}
      onClose={() => {
        queueMicrotask(() => {
          if (openingRef.current) return;
          setOpen(false);
          openerRef.current?.focus();
        });
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      {...stylex.props(styles.dialog)}
    >
      {open ? (
        <>
          <div {...stylex.props(styles.top)}>
            <div {...stylex.props(styles.inputRow)}>
              <Search aria-hidden {...stylex.props(styles.icon)} />
              <input
                ref={inputRef}
                aria-activedescendant={
                  active
                    ? `session-switcher-${active.kind === "create" ? "create" : active.row.session.id}`
                    : undefined
                }
                aria-autocomplete="list"
                aria-controls="session-switcher-results"
                aria-expanded="true"
                aria-label="Search sessions"
                autoComplete="off"
                placeholder="Search title, repository, or branch…"
                role="combobox"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setRequestedIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    keyboardNavigation.current = true;
                    setRequestedIndex(
                      moveSessionIndex(
                        activeIndex,
                        results.length,
                        event.key === "ArrowDown" ? 1 : -1,
                      ),
                    );
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    keyboardNavigation.current = true;
                    setRequestedIndex(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    keyboardNavigation.current = true;
                    setRequestedIndex(Math.max(0, results.length - 1));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    choose(active);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    close();
                  }
                }}
                {...stylex.props(styles.input)}
              />
            </div>
            <button
              aria-label="Close search"
              onClick={close}
              type="button"
              {...stylex.props(styles.close)}
            >
              <X aria-hidden {...stylex.props(styles.icon)} />
            </button>
          </div>
          <ul
            id="session-switcher-results"
            role="listbox"
            aria-label="Session search results"
            data-scrollbar="quiet"
            {...stylex.props(styles.results)}
          >
            {results.map((result, index) => {
              const id = result.kind === "create" ? "create" : result.row.session.id;
              return (
                <li key={id} role="presentation">
                  <button
                    ref={(element) => {
                      if (element) optionRefs.current.set(id, element);
                      else optionRefs.current.delete(id);
                    }}
                    id={`session-switcher-${id}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === activeIndex}
                    onClick={() => choose(result)}
                    {...stylex.props(styles.option, index === activeIndex && styles.optionActive)}
                  >
                    {result.kind === "create" ? (
                      <Plus aria-hidden {...stylex.props(styles.icon)} />
                    ) : (
                      <SessionResultIcon row={result.row} />
                    )}
                    <span {...stylex.props(styles.copy)}>
                      <span {...stylex.props(styles.title)}>
                        {result.kind === "create"
                          ? "Create new session"
                          : result.row.session.display.title}
                      </span>
                      <span {...stylex.props(styles.context)}>
                        {result.kind === "create"
                          ? "Choose a repository and start a task"
                          : `${result.row.session.display.repository}${result.row.session.display.branch ? ` / ${result.row.session.display.branch}` : ""} · ${result.row.selected ? "Current" : result.row.presentation.railLabel}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {results.length === 0 ? (
            <p role="status" {...stylex.props(styles.empty)}>
              No sessions match “{query.trim()}”.
            </p>
          ) : null}
          <footer {...stylex.props(styles.footer)}>
            <span aria-live="polite">
              {results.length} result{results.length === 1 ? "" : "s"}
            </span>
            <span {...stylex.props(styles.hints)}>↑↓ navigate · ↵ open · esc close</span>
          </footer>
        </>
      ) : null}
    </dialog>
  );
}
