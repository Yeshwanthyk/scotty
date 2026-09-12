import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { CloudResourceFile, CloudResourceKind } from "../../../protocol/cloud-resources";
import {
  readResource,
  removeResource,
  saveResource,
  type ResourceSnapshot,
} from "../data/settings";
import { Button } from "./Button";
import { colors, spacing } from "../theme/tokens.stylex";
import { bytesToBase64 as toBase64, prepareBrowserResourceFiles } from "../data/resource-files";

const styles = stylex.create({
  section: { display: "grid", gap: spacing.xl },
  help: { margin: 0, color: colors.muted, fontSize: "13px", lineHeight: 1.5 },
  form: {
    display: "grid",
    gap: spacing.xl,
  },
  row: { display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "center" },
  field: { display: "grid", gap: spacing.sm },
  fields: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: spacing.md,
    "@media (max-width: 600px)": { gridTemplateColumns: "1fr" },
  },
  item: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: "52px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
  },
  input: {
    minHeight: "42px",
    minWidth: "130px",
    paddingInline: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    backgroundColor: colors.control,
    color: colors.ink,
    fontSize: "14px",
  },
  textarea: {
    width: "100%",
    minHeight: "240px",
    padding: spacing.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    backgroundColor: colors.control,
    color: colors.ink,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "13px",
  },
  digest: { color: colors.quiet, fontSize: "11px", wordBreak: "break-all" },
  label: { color: colors.ink, fontSize: "13px", fontWeight: 620 },
  fileInput: { position: "absolute", width: "1px", height: "1px", opacity: 0, overflow: "hidden" },
  uploadButton: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "40px",
    paddingInline: spacing.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    backgroundColor: colors.panelRaised,
    color: colors.ink,
    fontSize: "13px",
    cursor: "pointer",
    ":hover": { borderColor: colors.lineHover },
    ":focus-within": { outlineWidth: "2px", outlineStyle: "solid", outlineColor: colors.focus },
  },
  footer: {
    display: "flex",
    gap: spacing.sm,
    alignItems: "center",
    paddingTop: spacing.lg,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.line,
  },
});

const fromBase64 = (value: string): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
};
const selectedLabel = (kind: CloudResourceKind, name: string): string => `${kind} · ${name}`;

// oxlint-disable-next-line eslint/complexity -- this compact editor owns the browse, upload, edit, and remove states
export function ResourcesSection({
  owner,
  snapshot,
  onChange,
  onError,
  onReload,
}: {
  readonly owner: boolean;
  readonly snapshot: ResourceSnapshot | null;
  readonly onChange: (snapshot: ResourceSnapshot) => void;
  readonly onError: (message: string | null) => void;
  readonly onReload: () => void;
}) {
  const [kind, setKind] = useState<CloudResourceKind>("skill");
  const [name, setName] = useState("");
  const [shape, setShape] = useState<"file" | "directory">("directory");
  const [files, setFiles] = useState<ReadonlyArray<CloudResourceFile>>([]);
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const currentFile = files.find((file) => file.path === selectedPath);
  const text = currentFile === undefined ? undefined : fromBase64(currentFile.contentBase64);

  const select = (nextKind: CloudResourceKind, nextName: string): void => {
    setBusy(true);
    onError(null);
    void readResource(nextKind, nextName)
      .then((result) => {
        if (!result.ok) {
          onError(result.failure.message);
          return;
        }
        setKind(nextKind);
        setName(nextName);
        setShape(result.value.shape);
        setFiles(result.value.files);
        setSelectedPath(
          result.value.files.find((file) => file.path === "SKILL.md")?.path ??
            result.value.files[0]?.path ??
            "",
        );
        setEditing(true);
      })
      .finally(() => setBusy(false));
  };
  const startNew = (): void => {
    setEditing(true);
    setName("");
    setKind("skill");
    setShape("directory");
    setSelectedPath("SKILL.md");
    setFiles([
      {
        path: "SKILL.md",
        contentBase64: toBase64(new TextEncoder().encode("# New skill\n")),
        modeClass: "regular",
      },
    ]);
  };
  const upload = (selected: FileList | null, directory: boolean): void => {
    if (selected === null || selected.length === 0) return;
    setBusy(true);
    onError(null);
    void prepareBrowserResourceFiles(Array.from(selected), kind, directory)
      .then((next) => {
        const first = next[0];
        const isSingleFile =
          !directory &&
          first !== undefined &&
          next.length === 1 &&
          kind !== "skill" &&
          kind !== "package";
        if (isSingleFile && first !== undefined && name.trim() === "") setName(first.path);
        setFiles(
          isSingleFile && first !== undefined && name.trim() !== ""
            ? [{ ...first, path: name.trim() }]
            : next,
        );
        setShape(directory ? "directory" : isSingleFile ? "file" : "directory");
        setSelectedPath(next.find((file) => file.path === "SKILL.md")?.path ?? next[0]?.path ?? "");
      })
      .catch(() => onError("Files could not be read."))
      .finally(() => setBusy(false));
  };
  const save = (): void => {
    if (!owner || busy || snapshot === null || name.trim() === "" || files.length === 0) return;
    setBusy(true);
    onError(null);
    void saveResource(kind, name.trim(), { expectedRevision: snapshot.revision, shape, files })
      .then((result) => {
        if (!result.ok) {
          onError(result.failure.message);
          return;
        }
        onChange(result.value);
        setEditing(false);
      })
      .finally(() => setBusy(false));
  };
  const remove = (): void => {
    if (!owner || busy || snapshot === null || name === "") return;
    setBusy(true);
    onError(null);
    void removeResource(kind, name, snapshot.revision)
      .then((result) => {
        if (!result.ok) {
          onError(result.failure.message);
          return;
        }
        onChange(result.value);
        setEditing(false);
      })
      .finally(() => setBusy(false));
  };

  return (
    <section id="resources" {...stylex.props(styles.section)}>
      <p {...stylex.props(styles.help)}>
        Skills work with Pi and Codex. Packages, tools, and extensions are for Pi. Changes apply to
        new sessions.
      </p>
      {!editing && (
        <div {...stylex.props(styles.form)}>
          {snapshot === null ? (
            <p {...stylex.props(styles.help)}>Resources could not be loaded.</p>
          ) : (
            <>
              {snapshot.items.length === 0 ? (
                <p {...stylex.props(styles.help)}>
                  Add a skill or upload a prepared runtime directory to get started.
                </p>
              ) : (
                snapshot.items.map((item) => (
                  <div key={`${item.kind}:${item.name}`} {...stylex.props(styles.item)}>
                    <span {...stylex.props(styles.label)}>
                      {selectedLabel(item.kind, item.name)}
                    </span>
                    <Button
                      variant="quiet"
                      disabled={busy}
                      onClick={() => select(item.kind, item.name)}
                    >
                      Open
                    </Button>
                  </div>
                ))
              )}
              <div>
                <Button disabled={!owner || busy} onClick={startNew}>
                  Add resource
                </Button>
              </div>
            </>
          )}
          <details>
            <summary {...stylex.props(styles.help)}>Bundle details</summary>
            <p {...stylex.props(styles.digest)}>{snapshot?.activeDigest ?? "No active bundle"}</p>
            <Button variant="quiet" onClick={onReload}>
              Reload
            </Button>
          </details>
        </div>
      )}
      {editing && (
        <div {...stylex.props(styles.form)}>
          <div {...stylex.props(styles.fields)}>
            <div {...stylex.props(styles.field)}>
              <label htmlFor="resource-kind" {...stylex.props(styles.label)}>
                Type
              </label>
              <select
                id="resource-kind"
                aria-label="Resource kind"
                disabled={!owner || busy}
                value={kind}
                onChange={(event) => {
                  const next = event.target.value as CloudResourceKind;
                  setKind(next);
                  setShape(next === "skill" || next === "package" ? "directory" : "file");
                  setFiles([]);
                }}
                {...stylex.props(styles.input)}
              >
                <option value="skill">Skill · Pi / Codex</option>
                <option value="package">Prepared Pi package</option>
                <option value="tool">Pi tool</option>
                <option value="extension">Pi extension</option>
              </select>
            </div>
            <div {...stylex.props(styles.field)}>
              <label htmlFor="resource-name" {...stylex.props(styles.label)}>
                Name
              </label>
              <input
                id="resource-name"
                aria-label="Resource name"
                disabled={!owner || busy}
                value={name}
                placeholder="Resource name"
                onChange={(event) => setName(event.target.value)}
                {...stylex.props(styles.input)}
              />
            </div>
          </div>
          <p {...stylex.props(styles.help)}>
            Upload a directory for a skill or a prepared Pi package. Packages with dependencies must
            include their lockfile and node_modules.
          </p>
          <div {...stylex.props(styles.row)}>
            <label {...stylex.props(styles.uploadButton)}>
              Choose file
              <input
                aria-label="Upload resource file"
                type="file"
                disabled={!owner || busy}
                {...stylex.props(styles.fileInput)}
                onChange={(event) => upload(event.target.files, false)}
              />
            </label>
            <label {...stylex.props(styles.uploadButton)}>
              Choose directory
              <input
                aria-label="Upload resource directory"
                type="file"
                disabled={!owner || busy}
                {...{ webkitdirectory: "" }}
                {...stylex.props(styles.fileInput)}
                onChange={(event) => upload(event.target.files, true)}
              />
            </label>
            <span {...stylex.props(styles.help)}>
              {files.length} file{files.length === 1 ? "" : "s"} selected
            </span>
          </div>
          {files.length > 0 && (
            <>
              <label htmlFor="resource-file" {...stylex.props(styles.label)}>
                File
              </label>
              <select
                id="resource-file"
                aria-label="Edit resource file"
                disabled={!owner || busy}
                value={selectedPath}
                onChange={(event) => setSelectedPath(event.target.value)}
                {...stylex.props(styles.input)}
              >
                {files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path}
                  </option>
                ))}
              </select>
              {currentFile !== undefined && (
                <label {...stylex.props(styles.row, styles.label)}>
                  <input
                    type="checkbox"
                    disabled={!owner || busy}
                    checked={currentFile.modeClass === "executable"}
                    onChange={(event) =>
                      setFiles(
                        files.map((file) =>
                          file.path === selectedPath
                            ? {
                                ...file,
                                modeClass: event.target.checked ? "executable" : "regular",
                              }
                            : file,
                        ),
                      )
                    }
                  />
                  Executable file
                </label>
              )}
              {text === undefined ? (
                <p {...stylex.props(styles.help)}>
                  Binary file · upload a replacement to change it.
                </p>
              ) : (
                <textarea
                  aria-label="Resource file content"
                  disabled={!owner || busy}
                  value={text}
                  onChange={(event) =>
                    setFiles(
                      files.map((file) =>
                        file.path === selectedPath
                          ? {
                              ...file,
                              contentBase64: toBase64(new TextEncoder().encode(event.target.value)),
                            }
                          : file,
                      ),
                    )
                  }
                  {...stylex.props(styles.textarea)}
                />
              )}
            </>
          )}
          <div {...stylex.props(styles.footer)}>
            {snapshot?.items.some((item) => item.kind === kind && item.name === name) && (
              <Button variant="quiet" disabled={!owner || busy} onClick={remove}>
                Remove
              </Button>
            )}
            <span style={{ flex: 1 }} />
            <Button variant="quiet" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!owner || busy || name.trim() === "" || files.length === 0}
              onClick={save}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
