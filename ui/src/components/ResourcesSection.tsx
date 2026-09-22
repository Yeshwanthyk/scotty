import * as stylex from "@stylexjs/stylex";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { ChevronRight, FileCode2, MoreHorizontal, Plus, Upload } from "lucide-react";
import type {
  CloudResourceFile,
  CloudResourceKind,
} from "../../../protocol/resources/cloud-resources";
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
  section: { display: "grid", gap: spacing.xxl },
  intro: { maxWidth: "65ch", margin: 0, color: colors.muted, fontSize: "13px", lineHeight: 1.55 },
  help: { margin: 0, color: colors.muted, fontSize: "12px", lineHeight: 1.5 },
  form: { display: "grid", gap: spacing.xl },
  row: { display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "center" },
  field: { minWidth: 0, display: "grid", gap: spacing.sm },
  fields: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: spacing.lg,
    "@media (max-width: 600px)": { gridTemplateColumns: "1fr" },
  },
  resourceList: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: colors.line },
  resourceItem: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: "72px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
  },
  resourceOpen: {
    minWidth: 0,
    minHeight: "71px",
    padding: `${spacing.md} ${spacing.sm}`,
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: spacing.md,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: "transparent",
    color: colors.ink,
    cursor: "pointer",
    textAlign: "left",
    ":hover": { backgroundColor: colors.panelRaised },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "-2px" },
  },
  resourceIcon: {
    width: "34px",
    height: "34px",
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    borderRadius: "7px",
    backgroundColor: colors.control,
    color: colors.muted,
  },
  resourceIconGlyph: { width: "16px", height: "16px", strokeWidth: 1.7 },
  resourceCopy: { minWidth: 0, flex: 1, display: "grid", gap: "3px" },
  resourceName: {
    overflow: "hidden",
    fontSize: "14px",
    fontWeight: 650,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  resourceMeta: { color: colors.muted, fontSize: "12px", lineHeight: 1.4 },
  chevron: { width: "15px", height: "15px", flexShrink: 0, color: colors.quiet },
  menu: { position: "relative", flexShrink: 0 },
  menuSummary: {
    width: "40px",
    height: "40px",
    display: "grid",
    placeItems: "center",
    borderRadius: "6px",
    color: colors.muted,
    cursor: "pointer",
    listStyle: "none",
    "::-webkit-details-marker": { display: "none" },
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "2px" },
    "@media (max-width: 760px)": { width: "44px", height: "44px" },
  },
  menuIcon: { width: "17px", height: "17px", strokeWidth: 1.8 },
  menuPanel: {
    position: "absolute",
    zIndex: 8,
    top: "calc(100% + 4px)",
    right: 0,
    width: "240px",
    padding: spacing.sm,
    display: "grid",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "8px",
    backgroundColor: colors.panelRaised,
    boxShadow: "0 4px 8px rgb(0 0 0 / 35%)",
  },
  menuPanelAbove: { top: "auto", bottom: "calc(100% + 4px)" },
  confirmCopy: { margin: 0, color: colors.muted, fontSize: "12px", lineHeight: 1.45 },
  danger: { color: colors.danger },
  empty: {
    minHeight: "128px",
    display: "grid",
    placeItems: "center",
    textAlign: "center",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.line,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  editorHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  editorTitle: { margin: 0, color: colors.ink, fontSize: "18px", fontWeight: 680 },
  editorMeta: { margin: `${spacing.xs} 0 0`, color: colors.muted, fontSize: "12px" },
  step: {
    display: "grid",
    gap: spacing.lg,
    paddingBottom: spacing.xl,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
  },
  stepHeading: { display: "grid", gap: spacing.xs },
  stepTitle: { margin: 0, color: colors.ink, fontSize: "14px", fontWeight: 650 },
  fileWorkbench: {
    display: "grid",
    gridTemplateColumns: "minmax(170px, 0.36fr) minmax(0, 1fr)",
    gap: spacing.md,
    "@media (max-width: 660px)": { gridTemplateColumns: "1fr" },
  },
  fileList: { display: "grid", alignContent: "start", gap: spacing.xs },
  fileChoice: {
    minHeight: "40px",
    paddingInline: spacing.sm,
    overflow: "hidden",
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "12px",
    textAlign: "left",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
    "@media (max-width: 760px)": { minHeight: "44px" },
  },
  fileChoiceActive: { backgroundColor: colors.panelRaised, color: colors.ink },
  editorPane: { minWidth: 0, display: "grid", gap: spacing.sm },
  input: {
    minHeight: "44px",
    minWidth: "130px",
    paddingInline: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    backgroundColor: colors.control,
    color: colors.ink,
    fontSize: "14px",
    "@media (max-width: 760px)": { fontSize: "16px" },
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
    "@media (max-width: 760px)": { fontSize: "16px" },
  },
  digest: { color: colors.quiet, fontSize: "11px", wordBreak: "break-all" },
  label: { color: colors.ink, fontSize: "13px", fontWeight: 620 },
  fileInput: { position: "absolute", width: "1px", height: "1px", opacity: 0, overflow: "hidden" },
  uploadButton: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "44px",
    paddingInline: spacing.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    backgroundColor: colors.control,
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
    justifyContent: "flex-end",
  },
  review: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: spacing.md,
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
  },
  reviewItem: { display: "grid", gap: "3px" },
  reviewLabel: { color: colors.quiet, fontSize: "11px" },
  reviewValue: { color: colors.ink, fontSize: "13px", overflowWrap: "anywhere" },
  bundleDetails: {
    paddingTop: spacing.md,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.lineSoft,
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
const resourceLabels = {
  skill: "Skill",
  package: "Pi package",
  tool: "Pi tool",
  extension: "Pi extension",
} satisfies Record<CloudResourceKind, string>;
const compatibilityLabels = {
  skill: "Pi + Codex",
  package: "Pi",
  tool: "Pi",
  extension: "Pi",
} satisfies Record<CloudResourceKind, string>;

export interface ResourcesSectionHandle {
  readonly startNew: () => void;
}

interface ResourcesSectionProps {
  readonly owner: boolean;
  readonly preview?: boolean;
  readonly snapshot: ResourceSnapshot | null;
  readonly onChange: (snapshot: ResourceSnapshot) => void;
  readonly onError: (message: string | null) => void;
  readonly onReload: () => void;
  readonly onEditingChange?: (editing: boolean) => void;
}

export const ResourcesSection = forwardRef<ResourcesSectionHandle, ResourcesSectionProps>(
  // oxlint-disable-next-line eslint/complexity -- this compact editor owns the browse, upload, edit, and remove states
  function ResourcesSection(
    { owner, preview = false, snapshot, onChange, onError, onReload, onEditingChange },
    ref,
  ) {
    const [kind, setKind] = useState<CloudResourceKind>("skill");
    const [name, setName] = useState("");
    const [shape, setShape] = useState<"file" | "directory">("directory");
    const [files, setFiles] = useState<ReadonlyArray<CloudResourceFile>>([]);
    const [selectedPath, setSelectedPath] = useState("SKILL.md");
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);
    const previewFiles = useRef(new Map<string, ReadonlyArray<CloudResourceFile>>());
    const currentFile = files.find((file) => file.path === selectedPath);
    const text = currentFile === undefined ? undefined : fromBase64(currentFile.contentBase64);
    const setEditorOpen = (next: boolean): void => {
      setEditing(next);
      onEditingChange?.(next);
    };

    const select = (nextKind: CloudResourceKind, nextName: string): void => {
      setBusy(true);
      onError(null);
      if (preview) {
        const item = snapshot?.items.find(
          (candidate) => candidate.kind === nextKind && candidate.name === nextName,
        );
        if (item !== undefined) {
          const key = `${nextKind}:${nextName}`;
          const filePath = item.files[0]?.path ?? (nextKind === "skill" ? "SKILL.md" : nextName);
          const localFiles = previewFiles.current.get(key) ?? [
            {
              path: filePath,
              contentBase64: btoa(`# ${nextName}\n\nLocal preview resource.\n`),
              modeClass: item.files[0]?.modeClass ?? "regular",
            },
          ];
          setKind(nextKind);
          setName(nextName);
          setShape(item.shape);
          setFiles(localFiles);
          setSelectedPath(localFiles[0]?.path ?? filePath);
          setEditorOpen(true);
        }
        setBusy(false);
        return;
      }
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
          setEditorOpen(true);
        })
        .finally(() => setBusy(false));
    };
    const startNew = (): void => {
      if (!owner || busy || editing) return;
      setEditorOpen(true);
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
    useImperativeHandle(ref, () => ({ startNew }), [busy, editing, onEditingChange, owner]);
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
          setSelectedPath(
            next.find((file) => file.path === "SKILL.md")?.path ?? next[0]?.path ?? "",
          );
        })
        .catch(() => onError("Files could not be read."))
        .finally(() => setBusy(false));
    };
    const save = (): void => {
      if (!owner || busy || snapshot === null || name.trim() === "" || files.length === 0) return;
      setBusy(true);
      onError(null);
      if (preview) {
        const digest = snapshot.activeDigest ?? "0".repeat(64);
        previewFiles.current.set(`${kind}:${name.trim()}`, files);
        onChange({
          ...snapshot,
          revision: snapshot.revision + 1,
          items: [
            ...snapshot.items.filter((item) => item.kind !== kind || item.name !== name.trim()),
            {
              kind,
              name: name.trim(),
              shape,
              digest,
              files: files.map((file) => ({
                path: file.path,
                size: Math.floor((file.contentBase64.length * 3) / 4),
                modeClass: file.modeClass,
                digest,
              })),
            },
          ],
        });
        setEditorOpen(false);
        setBusy(false);
        return;
      }
      void saveResource(kind, name.trim(), { expectedRevision: snapshot.revision, shape, files })
        .then((result) => {
          if (!result.ok) {
            onError(result.failure.message);
            return;
          }
          onChange(result.value);
          setRemoving(null);
          setEditorOpen(false);
        })
        .finally(() => setBusy(false));
    };
    const remove = (resourceKind: CloudResourceKind, resourceName: string): void => {
      if (!owner || busy || snapshot === null || resourceName === "") return;
      setBusy(true);
      onError(null);
      if (preview) {
        previewFiles.current.delete(`${resourceKind}:${resourceName}`);
        onChange({
          ...snapshot,
          revision: snapshot.revision + 1,
          items: snapshot.items.filter(
            (item) => item.kind !== resourceKind || item.name !== resourceName,
          ),
        });
        setRemoving(null);
        setEditorOpen(false);
        setBusy(false);
        return;
      }
      void removeResource(resourceKind, resourceName, snapshot.revision)
        .then((result) => {
          if (!result.ok) {
            onError(result.failure.message);
            return;
          }
          onChange(result.value);
          setRemoving(null);
          setEditorOpen(false);
        })
        .finally(() => setBusy(false));
    };

    const existing =
      snapshot?.items.some((item) => item.kind === kind && item.name === name) === true;
    return (
      <section id="settings-resources" {...stylex.props(styles.section)}>
        {!editing ? (
          <>
            <p {...stylex.props(styles.intro)}>
              Skills extend both agents. Pi packages, tools, and extensions customize Pi. Changes
              apply when a new session starts.
            </p>
            {snapshot === null ? (
              <p {...stylex.props(styles.help)}>Resources could not be loaded.</p>
            ) : snapshot.items.length === 0 ? (
              <div {...stylex.props(styles.empty)}>
                <div>
                  <p {...stylex.props(styles.label)}>No resources installed</p>
                  <p {...stylex.props(styles.help)}>
                    Add a skill or upload prepared runtime files for new sessions.
                  </p>
                </div>
              </div>
            ) : (
              <div {...stylex.props(styles.resourceList)}>
                {snapshot.items.map((item) => {
                  const key = `${item.kind}:${item.name}`;
                  return (
                    <div key={key} {...stylex.props(styles.resourceItem)}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => select(item.kind, item.name)}
                        {...stylex.props(styles.resourceOpen)}
                      >
                        <span aria-hidden {...stylex.props(styles.resourceIcon)}>
                          <FileCode2 {...stylex.props(styles.resourceIconGlyph)} />
                        </span>
                        <span {...stylex.props(styles.resourceCopy)}>
                          <span {...stylex.props(styles.resourceName)}>{item.name}</span>
                          <span {...stylex.props(styles.resourceMeta)}>
                            {resourceLabels[item.kind]} · {compatibilityLabels[item.kind]} ·{" "}
                            {item.files.length} file{item.files.length === 1 ? "" : "s"}
                          </span>
                        </span>
                        <ChevronRight aria-hidden {...stylex.props(styles.chevron)} />
                      </button>
                      {owner ? (
                        <details {...stylex.props(styles.menu)}>
                          <summary
                            aria-label={`More actions for ${item.name}`}
                            {...stylex.props(styles.menuSummary)}
                          >
                            <MoreHorizontal aria-hidden {...stylex.props(styles.menuIcon)} />
                          </summary>
                          <div {...stylex.props(styles.menuPanel)}>
                            {removing === key ? (
                              <>
                                <p {...stylex.props(styles.confirmCopy)}>
                                  Remove <strong>{item.name}</strong> from new sessions?
                                </p>
                                <div {...stylex.props(styles.row)}>
                                  <Button
                                    disabled={busy}
                                    onClick={() => remove(item.kind, item.name)}
                                    {...stylex.props(styles.danger)}
                                  >
                                    Confirm remove
                                  </Button>
                                  <Button
                                    variant="quiet"
                                    disabled={busy}
                                    onClick={() => setRemoving(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </>
                            ) : (
                              <Button
                                variant="quiet"
                                disabled={busy}
                                onClick={() => setRemoving(key)}
                                {...stylex.props(styles.danger)}
                              >
                                Remove resource
                              </Button>
                            )}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            <details {...stylex.props(styles.bundleDetails)}>
              <summary {...stylex.props(styles.help)}>Technical bundle details</summary>
              <p {...stylex.props(styles.digest)}>{snapshot?.activeDigest ?? "No active bundle"}</p>
              <Button variant="quiet" onClick={onReload}>
                Reload resources
              </Button>
            </details>
          </>
        ) : (
          <div {...stylex.props(styles.form)}>
            <header {...stylex.props(styles.editorHeader)}>
              <div>
                <h2 {...stylex.props(styles.editorTitle)}>{existing ? name : "New resource"}</h2>
                <p {...stylex.props(styles.editorMeta)}>
                  {resourceLabels[kind]} · {compatibilityLabels[kind]}
                </p>
              </div>
              <Button variant="quiet" disabled={busy} onClick={() => setEditorOpen(false)}>
                Back to resources
              </Button>
            </header>

            <section aria-labelledby="resource-identity" {...stylex.props(styles.step)}>
              <div {...stylex.props(styles.stepHeading)}>
                <h3 id="resource-identity" {...stylex.props(styles.stepTitle)}>
                  1. Choose a type
                </h3>
                <p {...stylex.props(styles.help)}>
                  Skills work with Pi and Codex. The other resource types are loaded by Pi.
                </p>
              </div>
              <div {...stylex.props(styles.fields)}>
                <div {...stylex.props(styles.field)}>
                  <label htmlFor="resource-kind" {...stylex.props(styles.label)}>
                    Type
                  </label>
                  <select
                    id="resource-kind"
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
                    <option value="skill">Skill · Pi + Codex</option>
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
                    disabled={!owner || busy}
                    value={name}
                    placeholder={kind === "skill" ? "release-check" : "resource name"}
                    onChange={(event) => setName(event.target.value)}
                    {...stylex.props(styles.input)}
                  />
                </div>
              </div>
            </section>

            <section aria-labelledby="resource-files" {...stylex.props(styles.step)}>
              <div {...stylex.props(styles.stepHeading)}>
                <h3 id="resource-files" {...stylex.props(styles.stepTitle)}>
                  2. Add or edit files
                </h3>
                <p {...stylex.props(styles.help)}>
                  Upload a directory for skills and packages. Prepared packages must include their
                  lockfile and dependencies.
                </p>
              </div>
              <div {...stylex.props(styles.row)}>
                <label {...stylex.props(styles.uploadButton)}>
                  <Upload aria-hidden {...stylex.props(styles.resourceIconGlyph)} />
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
                  <Plus aria-hidden {...stylex.props(styles.resourceIconGlyph)} />
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
                  {files.length} file{files.length === 1 ? "" : "s"}
                </span>
              </div>
              {files.length === 0 ? (
                <p {...stylex.props(styles.help)}>Choose a file or directory to continue.</p>
              ) : (
                <div {...stylex.props(styles.fileWorkbench)}>
                  <div aria-label="Resource files" {...stylex.props(styles.fileList)}>
                    {files.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        disabled={busy}
                        onClick={() => setSelectedPath(file.path)}
                        {...stylex.props(
                          styles.fileChoice,
                          selectedPath === file.path && styles.fileChoiceActive,
                        )}
                      >
                        {file.path}
                      </button>
                    ))}
                  </div>
                  <div {...stylex.props(styles.editorPane)}>
                    <span {...stylex.props(styles.label)}>{selectedPath}</span>
                    {currentFile !== undefined ? (
                      <label {...stylex.props(styles.row, styles.help)}>
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
                        Executable
                      </label>
                    ) : null}
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
                                    contentBase64: toBase64(
                                      new TextEncoder().encode(event.target.value),
                                    ),
                                  }
                                : file,
                            ),
                          )
                        }
                        {...stylex.props(styles.textarea)}
                      />
                    )}
                  </div>
                </div>
              )}
            </section>

            <section aria-labelledby="resource-review" {...stylex.props(styles.step)}>
              <div {...stylex.props(styles.stepHeading)}>
                <h3 id="resource-review" {...stylex.props(styles.stepTitle)}>
                  3. Review and save
                </h3>
                <p {...stylex.props(styles.help)}>
                  Saving updates the installation bundle for new sessions.
                </p>
              </div>
              <div {...stylex.props(styles.review)}>
                <div {...stylex.props(styles.reviewItem)}>
                  <span {...stylex.props(styles.reviewLabel)}>Resource</span>
                  <span {...stylex.props(styles.reviewValue)}>
                    {name.trim() || "Name required"}
                  </span>
                </div>
                <div {...stylex.props(styles.reviewItem)}>
                  <span {...stylex.props(styles.reviewLabel)}>Compatibility</span>
                  <span {...stylex.props(styles.reviewValue)}>{compatibilityLabels[kind]}</span>
                </div>
                <div {...stylex.props(styles.reviewItem)}>
                  <span {...stylex.props(styles.reviewLabel)}>Files</span>
                  <span {...stylex.props(styles.reviewValue)}>
                    {files.length} · {shape}
                  </span>
                </div>
              </div>
            </section>

            <div {...stylex.props(styles.footer)}>
              {existing ? (
                <details {...stylex.props(styles.menu)}>
                  <summary
                    aria-label={`More actions for ${name}`}
                    {...stylex.props(styles.menuSummary)}
                  >
                    <MoreHorizontal aria-hidden {...stylex.props(styles.menuIcon)} />
                  </summary>
                  <div {...stylex.props(styles.menuPanel, styles.menuPanelAbove)}>
                    {removing === `${kind}:${name}` ? (
                      <>
                        <p {...stylex.props(styles.confirmCopy)}>Remove this resource?</p>
                        <Button
                          disabled={!owner || busy}
                          onClick={() => remove(kind, name)}
                          {...stylex.props(styles.danger)}
                        >
                          Confirm remove
                        </Button>
                        <Button variant="quiet" onClick={() => setRemoving(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="quiet"
                        disabled={!owner || busy}
                        onClick={() => setRemoving(`${kind}:${name}`)}
                        {...stylex.props(styles.danger)}
                      >
                        Remove resource
                      </Button>
                    )}
                  </div>
                </details>
              ) : null}
              <Button variant="quiet" disabled={busy} onClick={() => setEditorOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!owner || busy || name.trim() === "" || files.length === 0}
                onClick={save}
              >
                {busy ? "Saving…" : existing ? "Save changes" : "Add resource"}
              </Button>
            </div>
          </div>
        )}
      </section>
    );
  },
);
