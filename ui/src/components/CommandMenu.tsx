import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessions } from "../data/sessions-store";
import { ago, statusOf } from "../data/status";
import { Icon } from "./Icon";
import { StatusMark } from "./Sidebar";

type Command = {
  id: string;
  label: string;
  detail: string;
  section: string;
  run: () => void;
  mark: React.ReactNode;
};

// Opened by keyboard many times a day, so it appears and leaves without animation.
export function CommandMenu({ onClose }: { onClose: () => void }) {
  const { list } = useSessions();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
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
    ];
    const sessions: Command[] = (list ?? []).map((session) => ({
      id: session.identity.id,
      label: session.display.title,
      detail: `${session.display.repository} · ${ago(session.display.createdAt)}`,
      section: "Sessions",
      mark: <StatusMark status={statusOf(session)} />,
      run: go(() => navigate({ to: "/s/$sessionId", params: { sessionId: session.identity.id } })),
    }));
    const needle = query.trim().toLowerCase();
    return [...actions, ...sessions].filter(
      (command) =>
        needle === "" || `${command.label} ${command.detail}`.toLowerCase().includes(needle),
    );
  }, [list, query, navigate, onClose]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
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
            placeholder="Search sessions and actions"
            aria-label="Search sessions and actions"
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
              } else if (event.key === "Escape") onClose();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-list" data-scroll ref={listRef} role="listbox">
          {commands.length === 0 ? (
            <div className="command-empty">Nothing matches “{query}”</div>
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
