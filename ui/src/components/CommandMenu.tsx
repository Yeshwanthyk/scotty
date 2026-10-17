import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { sessions as searchSessions } from "../data/core";
import { useSessions } from "../data/sessions-store";
import { ago, type Filter, matchesFilter, matchesText, statusOf } from "../data/status";
import { Icon } from "./Icon";
import { useLayout } from "./Layout";
import { sections } from "./Settings";
import { filters, StatusMark } from "./Sidebar";

type Command = {
  id: string;
  label: string;
  detail: string;
  section: string;
  run: () => void;
  mark: React.ReactNode;
};

// Opened by keyboard many times a day, so it appears and leaves without animation. Inside, one
// highlight glides between rows as the active row changes.
export function CommandMenu({ onClose }: { onClose: () => void }) {
  const { list, setRepo } = useSessions();
  const { sidebar, toggleSidebar } = useLayout();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [active, setActive] = useState(0);
  // The server also matches the whole first prompt; its hits join the ones the list shows,
  // but only while they answer the text in the box.
  const [hits, setHits] = useState<{ query: string; ids: ReadonlySet<string> }>();
  const text = query.trim();
  const found = hits?.query === text ? hits.ids : undefined;
  useEffect(() => {
    if (text === "") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchSessions(controller.signal, text.slice(0, 200)).then(
        (sessions) =>
          setHits({ query: text, ids: new Set(sessions.map((hit) => hit.identity.id)) }),
        () => undefined,
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);
  const listRef = useRef<HTMLDivElement>(null);
  const commands = useMemo(() => {
    const go = (run: () => Promise<void>) => () => {
      onClose();
      void run();
    };
    const actions: Command[] = [
      {
        id: "new",
        label: "New session",
        detail: "",
        section: "Actions",
        mark: <Icon name="plus" />,
        run: go(() => navigate({ to: "/sessions/create" })),
      },
      // A phone has no sidebar to hide.
      ...(window.matchMedia("(min-width: 768px)").matches
        ? [
            {
              id: "sidebar",
              label: sidebar ? "Hide sidebar" : "Show sidebar",
              detail: "⌘\\",
              section: "Actions",
              mark: <Icon name="sidebar" />,
              run: go(async () => toggleSidebar()),
            },
          ]
        : []),
      {
        id: "stats",
        label: "Stats",
        detail: "Hours, turns and failures per repository",
        section: "Actions",
        mark: <Icon name="gauge" />,
        run: go(() => navigate({ to: "/stats" })),
      },
      ...sections.map((item) => ({
        id: `settings-${item.id}`,
        label: `Settings: ${item.label}`,
        detail: item.detail,
        section: "Actions",
        mark: <Icon name={item.icon} />,
        run: go(() => navigate({ to: "/settings/$section", params: { section: item.id } })),
      })),
    ];
    const needle = query.trim().toLowerCase();
    // Sessions match on title, repository, branch and first prompt, then the status filter;
    // running ones come first. A repository sets the sidebar's repository filter.
    const matching = (list ?? []).filter(
      (session) =>
        (matchesText(session, needle) || found?.has(session.identity.id) === true) &&
        matchesFilter(session, filter),
    );
    const sessions: Command[] = [
      ...matching.filter((session) => matchesFilter(session, "running")),
      ...matching.filter((session) => !matchesFilter(session, "running")),
    ].map((session) => ({
      id: session.identity.id,
      label: session.display.title,
      detail: `${session.display.repository} · ${ago(session.display.activeAt)}`,
      section: matchesFilter(session, "running") ? "Running" : "Sessions",
      mark: <StatusMark status={statusOf(session)} />,
      run: go(() => navigate({ to: "/s/$sessionId", params: { sessionId: session.identity.id } })),
    }));
    const repos: Command[] = [...new Set((list ?? []).map((session) => session.display.repository))]
      .filter((repo) => repo !== "" && needle !== "" && repo.toLowerCase().includes(needle))
      .map((repo) => ({
        id: `repo-${repo}`,
        label: repo,
        detail: "Show its sessions",
        section: "Repositories",
        mark: <Icon name="branch" />,
        run: go(async () => {
          setRepo(repo);
          await navigate({ to: "/sessions" });
        }),
      }));
    // Running sessions lead; a status filter narrows the menu to sessions.
    return [
      ...sessions.filter((command) => command.section === "Running"),
      ...(filter === "all"
        ? [
            ...actions.filter(
              (command) =>
                needle === "" ||
                `${command.label} ${command.detail}`.toLowerCase().includes(needle),
            ),
            ...repos,
          ]
        : []),
      ...sessions.filter((command) => command.section !== "Running"),
    ];
  }, [list, query, filter, found, navigate, onClose, setRepo, sidebar, toggleSidebar]);
  // The first row is active whenever the rows change; live updates to the same rows keep it.
  const rows = commands.map((command) => command.id).join("\n");
  useEffect(() => setActive(0), [rows]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const [highlight, setHighlight] = useState<{ top: number; height: number }>();
  useLayoutEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    setHighlight(item ? { top: item.offsetTop, height: item.offsetHeight } : undefined);
  }, [active, rows]);
  let section = "";
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command" role="dialog" aria-label="Command menu">
        <div className="command-input">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            placeholder="Search sessions, repos and actions"
            aria-label="Search sessions, repos and actions"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(commands.length - 1, index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                commands[active]?.run();
              } else if (event.key === "Tab") {
                // Tab and Shift+Tab step through the status filters.
                event.preventDefault();
                const step = event.shiftKey ? filters.length - 1 : 1;
                const index = filters.findIndex((item) => item.id === filter);
                const next = filters[(index + step) % filters.length];
                if (next) setFilter(next.id);
              } else if (event.key === "Escape") onClose();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-filters" role="radiogroup" aria-label="Filter sessions">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              className="command-filter pressable"
              role="radio"
              aria-checked={filter === item.id}
              // Keeps focus in the search box.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="command-list" data-scroll ref={listRef} role="listbox">
          {highlight ? (
            <div
              className="command-highlight"
              aria-hidden="true"
              style={{ height: highlight.height, transform: `translateY(${highlight.top}px)` }}
            />
          ) : null}
          {commands.length === 0 ? (
            <div className="command-empty">
              {text === "" ? "No sessions here" : `Nothing matches “${query}”`}
            </div>
          ) : null}
          {commands.map((command, index) => {
            const heading = command.section !== section ? command.section : undefined;
            section = command.section;
            return (
              <div key={command.id}>
                {heading ? <div className="command-label">{heading}</div> : null}
                <button
                  type="button"
                  className="command-item"
                  role="option"
                  data-index={index}
                  aria-selected={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={command.run}
                >
                  {command.mark}
                  <span className="text">{command.label}</span>
                  <span className="detail">{command.detail}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
