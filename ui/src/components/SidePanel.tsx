import { lazy, Suspense, useState } from "react";
import { fileHref, hatch, message } from "../data/core";
import type { FileDiff } from "../data/diff";
import type { Turn } from "../protocol/session/conversation";
import { DiffFile, DiffStat } from "./DiffLines";
import { Icon, Spinner, type IconName } from "./Icon";
import { useLightbox } from "./Lightbox";

// xterm loads only when the terminal tab opens.
const Terminal = lazy(() => import("./Terminal"));

export type PanelTab = "changes" | "preview" | "terminal" | "files";

export function SidePanel({
  sessionId,
  turns,
  changes,
  running,
  tab,
  onTab,
}: {
  sessionId: string;
  turns: ReadonlyArray<Turn>;
  changes: ReadonlyArray<FileDiff>;
  running: boolean;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
}) {
  const files = turns.flatMap((turn) => turn.files);
  const tabs: { id: PanelTab; label: string; count?: number }[] = [
    { id: "changes", label: "Changes", count: changes.length },
    { id: "preview", label: "Preview" },
    { id: "terminal", label: "Terminal" },
    { id: "files", label: "Files", count: files.length },
  ];
  return (
    <aside className="panel" aria-label="Session details">
      <div className="panel-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="tab pressable"
            aria-selected={tab === item.id}
            onClick={() => onTab(item.id)}
          >
            {item.label}
            {item.count ? <span className="count tabular">{item.count}</span> : null}
          </button>
        ))}
      </div>
      <div className="panel-body" data-scroll>
        {tab === "changes" ? <Changes changes={changes} /> : null}
        {tab === "preview" ? <Preview sessionId={sessionId} running={running} /> : null}
        {tab === "terminal" ? (
          running ? (
            <Suspense fallback={null}>
              <Terminal sessionId={sessionId} />
            </Suspense>
          ) : (
            <Empty
              icon="terminal"
              title="Start the session to use the terminal"
              detail="Send a message to resume it; the shell opens in the repository."
            />
          )
        ) : null}
        {tab === "files" ? <FileList sessionId={sessionId} files={files} /> : null}
      </div>
    </aside>
  );
}

function Empty({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <div className="panel-empty">
      <Icon name={icon} size={20} />
      <div style={{ color: "var(--muted)" }}>{title}</div>
      <div>{detail}</div>
    </div>
  );
}

// Long lines wrap on a phone and scroll sideways on a desktop, until the owner picks otherwise.
const wrapKey = "scotty.diffWrap";
const storedWrap = () => {
  try {
    const value = localStorage.getItem(wrapKey);
    return value === null ? window.matchMedia("(max-width: 767px)").matches : value === "1";
  } catch {
    return false;
  }
};

function Changes({ changes }: { changes: ReadonlyArray<FileDiff> }) {
  const [wrap, setWrap] = useState(storedWrap);
  if (changes.length === 0)
    return (
      <Empty icon="diff" title="No changes yet" detail="Files the agent edits show up here." />
    );
  const added = changes.reduce((sum, file) => sum + file.added, 0);
  const removed = changes.reduce((sum, file) => sum + file.removed, 0);
  return (
    <>
      <div className="diff-summary">
        <span>
          {changes.length} {changes.length === 1 ? "file" : "files"} changed
        </span>
        <DiffStat added={added} removed={removed} />
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
      </div>
      {changes.map((file) => (
        <DiffFile key={file.path} file={file} open={changes.length <= 6} wrap={wrap} />
      ))}
    </>
  );
}

function Preview({ sessionId, running }: { sessionId: string; running: boolean }) {
  const [port, setPort] = useState("5173");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!running)
    return (
      <Empty
        icon="eye"
        title="Preview needs a running session"
        detail="Send a message to resume it, then open the port the dev server uses."
      />
    );
  async function open() {
    setBusy(true);
    setError("");
    try {
      setUrl(await hatch(sessionId, Number(port)));
    } catch (failure) {
      setError(message(failure, "Could not open the preview"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <form
        className="preview-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void open();
        }}
      >
        <span className="quiet" style={{ fontSize: 12 }}>
          Port
        </span>
        <input
          className="field tabular"
          style={{ width: 80 }}
          inputMode="numeric"
          value={port}
          aria-label="Port"
          onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))}
        />
        <button type="submit" className="button pressable" disabled={busy || port === ""}>
          {busy ? <Spinner size={12} /> : null}
          Open
        </button>
        {url ? (
          <a
            className="icon-button pressable"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in a new tab"
            style={{ marginLeft: "auto" }}
          >
            <Icon name="external" />
          </a>
        ) : null}
      </form>
      {error ? (
        <p className="alert" style={{ padding: "8px 12px", margin: 0 }}>
          {error}
        </p>
      ) : null}
      {url ? (
        <iframe className="preview-frame" src={url} title="Preview" style={{ flex: 1 }} />
      ) : (
        <Empty
          icon="eye"
          title="Open a port"
          detail="The agent prints Ready: <URL> when its dev server answers."
        />
      )}
    </div>
  );
}

function FileList({ sessionId, files }: { sessionId: string; files: Turn["files"] }) {
  const images = files
    .filter((file) => file.type.startsWith("image/"))
    .map((file) => ({
      id: file.id,
      href: fileHref(sessionId, file.id),
      label: file.caption ?? file.name,
    }));
  const lightbox = useLightbox(images);
  if (files.length === 0)
    return (
      <Empty
        icon="image"
        title="No files"
        detail="Screenshots and videos the agent shares land here."
      />
    );
  return (
    <div className="file-list">
      {files.map((file) => {
        const href = fileHref(sessionId, file.id);
        const image = images.findIndex((item) => item.id === file.id);
        return (
          <a
            key={file.id}
            className="file-item"
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={image === -1 ? undefined : lightbox.open(image)}
          >
            {file.type.startsWith("image/") ? (
              <img className="thumb" src={href} alt="" loading="lazy" />
            ) : (
              <span className="thumb">
                <Icon name={file.type.startsWith("video/") ? "play" : "file"} size={14} />
              </span>
            )}
            <span style={{ minWidth: 0 }}>
              <div className="name">{file.caption ?? file.name}</div>
              <div className="quiet tabular" style={{ fontSize: 11.5 }}>
                {file.type} · {Math.max(1, Math.round(file.size / 1024))} KB
              </div>
            </span>
          </a>
        );
      })}
      {lightbox.view}
    </div>
  );
}
