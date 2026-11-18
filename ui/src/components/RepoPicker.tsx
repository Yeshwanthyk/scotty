import { useEffect, useId, useState } from "react";
import { message } from "../data/core";
import { repositoryCatalog, repoPattern } from "../data/settings";
import { Icon } from "./Icon";

export function RepoPicker({
  value,
  known,
  onChange,
}: {
  value: string;
  known: ReadonlyArray<string>;
  onChange: (repo: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!requested) return;
    const abort = new AbortController();
    setLoading(true);
    async function load() {
      try {
        let page: number | null = 1;
        while (page !== null) {
          const result = await repositoryCatalog(page, abort.signal);
          if (abort.signal.aborted) return;
          setRepos((previous) => [...previous, ...result.repos]);
          page = result.nextPage;
        }
      } catch (failure) {
        if (!abort.signal.aborted) setError(message(failure, "Could not load GitHub repositories"));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [requested]);
  const unique = new Map<string, string>();
  for (const repo of [...known, ...repos]) {
    if (repoPattern.test(repo) && !unique.has(repo.toLowerCase()))
      unique.set(repo.toLowerCase(), repo);
  }
  const choices = [...unique.values()].filter((repo) =>
    repo.toLowerCase().includes(query.trim().toLowerCase()),
  );
  useEffect(() => {
    if (open && active >= 0)
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id, open]);
  function show() {
    setOpen(true);
    setRequested(true);
  }
  function choose(repo: string) {
    onChange(repo);
    setOpen(false);
    setActive(-1);
  }
  return (
    <div
      className="repo-picker repository-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Icon name="repo" size={14} />
      <input
        role="combobox"
        aria-label="Repository"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={
          open && active >= 0 && choices[active] !== undefined ? `${id}-${active}` : undefined
        }
        aria-invalid={!open && value !== "" && !repoPattern.test(value.trim())}
        value={value}
        placeholder="Search or owner/repo"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{ width: `${Math.max(17, value.length + 1)}ch` }}
        onFocus={() => {
          setQuery("");
          setActive(-1);
          show();
        }}
        onClick={show}
        onChange={(event) => {
          onChange(event.target.value);
          setQuery(event.target.value);
          setActive(-1);
          show();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
            setActive((previous) =>
              choices.length === 0
                ? -1
                : previous < 0
                  ? event.key === "ArrowDown"
                    ? 0
                    : choices.length - 1
                  : (previous + (event.key === "ArrowDown" ? 1 : -1) + choices.length) %
                    choices.length,
            );
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            event.stopPropagation();
            const choice = choices[active];
            if (choice !== undefined) choose(choice);
            else setOpen(false);
          }
        }}
      />
      <Icon name="chevronDown" size={12} />
      {open ? (
        <div className="repository-options">
          <div className="repository-status" role="status">
            {loading
              ? "Loading GitHub repositories…"
              : error
                ? `${error}. Enter owner/repo manually.`
                : choices.length === 0
                  ? "No matching repositories. Enter owner/repo or paste a GitHub URL."
                  : "Recent, configured and GitHub repositories"}
          </div>
          <div role="listbox" id={id} aria-label="Repositories">
            {choices.map((repo, index) => (
              <div
                key={repo.toLowerCase()}
                id={`${id}-${index}`}
                role="option"
                aria-selected={index === active}
                className="menu-item"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(repo)}
                onPointerMove={() => setActive(index)}
              >
                <span className="menu-text">{repo}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
