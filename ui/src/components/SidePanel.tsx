import { useState } from "react";
import { hatch, message } from "../data/core";
import type { FileDiff } from "../data/diff";
import type { Turn } from "../protocol/session/conversation";
import { DiffFile, DiffStat } from "./DiffLines";
import { Icon, Spinner, type IconName } from "./Icon";

export type PanelTab = "changes" | "preview" | "files";

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

function Changes({ changes }: { changes: ReadonlyArray<FileDiff> }) {
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
      </div>
      {changes.map((file) => (
        <DiffFile key={file.path} file={file} open={changes.length <= 6} />
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
        const href = `/api/sessions/${encodeURIComponent(sessionId)}/files/${file.id}`;
        return (
          <a key={file.id} className="file-item" href={href} target="_blank" rel="noreferrer">
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
    </div>
  );
}
