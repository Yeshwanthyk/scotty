import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileDiff } from "../data/diff";
import {
  DiffFile,
  DiffLines,
  DiffPath,
  DiffStat,
  fileIcon,
  narrowFold,
  wideFold,
} from "./DiffLines";
import { Icon } from "./Icon";
import { Viewer } from "./Viewer";

const narrowQuery = "(max-width: 767px)";
const isNarrow = () => typeof window !== "undefined" && window.matchMedia(narrowQuery).matches;

function useNarrow() {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const query = window.matchMedia(narrowQuery);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

// Long lines wrap on a phone and scroll sideways on a desktop, until the owner picks otherwise.
const wrapKey = "scotty.diffWrap";
const storedWrap = () => {
  try {
    const value = localStorage.getItem(wrapKey);
    return value === null ? isNarrow() : value === "1";
  } catch {
    return false;
  }
};

// On a phone, more than three files start collapsed, so the list reads as a table of contents.
const initiallyOpen = (changes: ReadonlyArray<FileDiff>) =>
  new Set(
    (isNarrow() ? changes.length <= 3 : changes.length <= 6)
      ? changes.map((file) => file.path)
      : [],
  );

export function Changes({ changes }: { changes: ReadonlyArray<FileDiff> }) {
  const narrow = useNarrow();
  const fold = narrow ? narrowFold : wideFold;
  const [wrap, setWrap] = useState(storedWrap);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => initiallyOpen(changes));
  const [sheet, setSheet] = useState(false);
  const [viewing, setViewing] = useState<number>();
  const root = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  // A file to bring under the toolbar once it has rendered open.
  const [target, setTarget] = useState<string>();

  const scroller = () => root.current?.closest<HTMLElement>("[data-scroll]") ?? null;
  const sections = () => [...(root.current?.querySelectorAll<HTMLElement>(".diff-file") ?? [])];
  // Where a file header sits when it is stuck under the toolbar.
  const anchor = () => {
    const box = scroller()?.getBoundingClientRect();
    return (box?.top ?? 0) + (summary.current?.offsetHeight ?? 0);
  };
  const scrollTo = (section: HTMLElement) => {
    const box = scroller();
    if (box === null) return;
    box.scrollTop += section.getBoundingClientRect().top - anchor();
  };
  useLayoutEffect(() => {
    if (target === undefined) return;
    const section = sections().find((item) => item.dataset["path"] === target);
    if (section) scrollTo(section);
    setTarget(undefined);
  });
  const jump = (path: string) => {
    setOpen((set) => new Set(set).add(path));
    setTarget(path);
  };
  // The next file header below the toolbar, or the previous one above it.
  const step = (by: 1 | -1) => {
    const line = anchor();
    const list = sections();
    const next =
      by === 1
        ? list.find((item) => item.getBoundingClientRect().top > line + 1)
        : list.findLast((item) => item.getBoundingClientRect().top < line - 1);
    if (next) scrollTo(next);
  };

  const added = changes.reduce((sum, file) => sum + file.added, 0);
  const removed = changes.reduce((sum, file) => sum + file.removed, 0);
  const shown = viewing === undefined ? undefined : changes[viewing];
  return (
    <div ref={root} className="changes">
      <div className="diff-summary" ref={summary}>
        <span>
          {changes.length} {changes.length === 1 ? "file" : "files"}
          <span className="desktop-only"> changed</span>
        </span>
        <DiffStat added={added} removed={removed} />
        <span className="diff-tools">
          <button type="button" className="button pressable" onClick={() => setSheet(true)}>
            <Icon name="list" size={14} />
            Files
          </button>
          <button
            type="button"
            className="icon-button pressable"
            aria-label="Wrap lines"
            aria-pressed={wrap}
            onClick={() => {
              setWrap(!wrap);
              try {
                localStorage.setItem(wrapKey, wrap ? "0" : "1");
              } catch {
                // Storage can be refused; the choice then lasts for this page only.
              }
            }}
          >
            <Icon name="wrap" size={13} />
          </button>
        </span>
      </div>
      {changes.map((file, index) => (
        <DiffFile
          key={file.path}
          file={file}
          open={open.has(file.path)}
          onToggle={() =>
            setOpen((set) => {
              const next = new Set(set);
              if (!next.delete(file.path)) next.add(file.path);
              return next;
            })
          }
          onView={() => setViewing(index)}
          wrap={wrap}
          fold={fold}
        />
      ))}
      <div className="diff-jump">
        <button
          type="button"
          className="viewer-button pressable"
          aria-label="Previous file"
          onClick={() => step(-1)}
        >
          <Icon name="arrowUp" />
        </button>
        <button
          type="button"
          className="viewer-button pressable"
          aria-label="Next file"
          onClick={() => step(1)}
        >
          <Icon name="arrowDown" />
        </button>
      </div>
      {sheet ? (
        <FileSheet
          changes={changes}
          onPick={(path) => {
            setSheet(false);
            jump(path);
          }}
          onAll={(expand) => setOpen(new Set(expand ? changes.map((file) => file.path) : []))}
          onClose={() => setSheet(false)}
        />
      ) : null}
      {viewing !== undefined && shown !== undefined ? (
        <Viewer
          label="File changes"
          className="file-view"
          index={viewing}
          count={changes.length}
          onIndex={setViewing}
          onClose={() => setViewing(undefined)}
          title={
            <span className="file-view-title">
              <Icon name={fileIcon(shown)} size={14} />
              <DiffPath path={shown.path} />
              <DiffStat added={shown.added} removed={shown.removed} />
            </span>
          }
        >
          <div className="file-view-body" data-scroll>
            <DiffLines key={shown.path} file={shown} wrap={wrap} fold={fold} />
          </div>
        </Viewer>
      ) : null}
    </div>
  );
}

// Every changed file, to jump to one; a sheet from the bottom on a phone.
function FileSheet({
  changes,
  onPick,
  onAll,
  onClose,
}: {
  changes: ReadonlyArray<FileDiff>;
  onPick: (path: string) => void;
  onAll: (expand: boolean) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-label="Changed files"
      // Escape and a tap on the backdrop; the dialog's own close event also fires when an effect
      // is set up twice, so it decides nothing.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The dialog itself is only hit on its backdrop.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet-head">
        <span>
          {changes.length} {changes.length === 1 ? "file" : "files"}
        </span>
        <button type="button" className="button pressable" onClick={() => onAll(true)}>
          Expand all
        </button>
        <button type="button" className="button pressable" onClick={() => onAll(false)}>
          Collapse all
        </button>
      </div>
      <div className="sheet-list" data-scroll>
        {changes.map((file) => (
          <button
            key={file.path}
            type="button"
            className="sheet-file pressable"
            onClick={() => onPick(file.path)}
          >
            <Icon name={fileIcon(file)} size={14} />
            <DiffPath path={file.path} />
            <DiffStat added={file.added} removed={file.removed} />
          </button>
        ))}
      </div>
    </dialog>
  );
}
