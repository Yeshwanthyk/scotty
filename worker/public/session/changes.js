const STATUS_LABELS = {
  added: "Added",
  copied: "Copied",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
  type_changed: "Type changed",
  unmerged: "Unmerged",
  untracked: "Untracked",
};
const PATCH_LINE_LIMIT = 4_000;

const element = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const stateMessage = (document, className, text) => element(document, "p", className, text);

const patchLineContent = (line) =>
  line.kind === "addition" || line.kind === "deletion" || line.kind === "context"
    ? line.text.slice(1)
    : line.text;

export function parsePatchLines(patch) {
  if (typeof patch !== "string") return [];
  return patch.split("\n").map((text) => ({
    text,
    kind: text.startsWith("@@")
      ? "hunk"
      : text.startsWith("+") && !text.startsWith("+++ ")
        ? "addition"
        : text.startsWith("-") && !text.startsWith("--- ")
          ? "deletion"
          : text.startsWith("diff ") ||
              text.startsWith("index ") ||
              text.startsWith("--- ") ||
              text.startsWith("+++ ")
            ? "meta"
            : "context",
  }));
}

export function splitPatchRows(lines) {
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.kind !== "deletion" && line.kind !== "addition") {
      rows.push(
        line.kind === "context"
          ? { kind: "pair", old: line, next: line }
          : { kind: line.kind, line },
      );
      continue;
    }
    const deletions = [];
    const additions = [];
    while (lines[index]?.kind === "deletion") {
      deletions.push(lines[index]);
      index += 1;
    }
    while (lines[index]?.kind === "addition") {
      additions.push(lines[index]);
      index += 1;
    }
    index -= 1;
    const length = Math.max(deletions.length, additions.length);
    for (let pair = 0; pair < length; pair += 1)
      rows.push({ kind: "pair", old: deletions[pair], next: additions[pair] });
  }
  return rows;
}

const errorMessage = async (response, fallback) => {
  const payload = await response.json().catch(() => undefined);
  return payload?.error?.message || fallback;
};

const fileMeta = (file) => {
  const stage =
    file.staged && file.unstaged ? "staged + unstaged" : file.staged ? "staged" : "unstaged";
  const totals =
    Number.isInteger(file.additions) && Number.isInteger(file.deletions)
      ? ` · +${file.additions} −${file.deletions}`
      : "";
  return `${STATUS_LABELS[file.status] || "Changed"} · ${stage}${totals}`;
};

const appendUnifiedLine = (document, root, line) => {
  const row = element(document, "div", `changes-diff-line is-${line.kind}`);
  const prefix = line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " ";
  row.append(element(document, "span", "changes-diff-sign", prefix));
  row.append(element(document, "code", "changes-diff-code", patchLineContent(line)));
  root.append(row);
};

const appendSplitCell = (document, row, side, line) => {
  const cell = element(document, "div", `changes-split-cell is-${line?.kind || "empty"}`);
  cell.dataset.side = side;
  cell.append(element(document, "code", "changes-diff-code", line ? patchLineContent(line) : ""));
  row.append(cell);
};

const renderPatch = (document, root, patch) => {
  const allLines = parsePatchLines(patch);
  const lines = allLines.slice(0, PATCH_LINE_LIMIT);
  const unified = element(document, "div", "changes-unified");
  unified.setAttribute("aria-label", "Unified patch");
  for (const line of lines) appendUnifiedLine(document, unified, line);

  const split = element(document, "div", "changes-split");
  split.setAttribute("aria-label", "Split patch with old and new columns");
  const heading = element(document, "div", "changes-split-heading");
  heading.append(element(document, "span", "", "Old"), element(document, "span", "", "New"));
  split.append(heading);
  for (const item of splitPatchRows(lines)) {
    if (item.kind !== "pair") {
      const row = element(document, "div", `changes-split-wide is-${item.kind}`, item.line.text);
      split.append(row);
      continue;
    }
    const row = element(document, "div", "changes-split-row");
    appendSplitCell(document, row, "old", item.old);
    appendSplitCell(document, row, "new", item.next);
    split.append(row);
  }
  const notice =
    allLines.length > PATCH_LINE_LIMIT
      ? stateMessage(document, "changes-state", "Display limited to the first 4,000 patch lines.")
      : undefined;
  root.replaceChildren(...[split, unified, notice].filter(Boolean));
};

export function createChangesViewer({ document, fetch, headerActions }) {
  const trigger = element(document, "button", "changes-toggle", "Changes");
  trigger.type = "button";
  trigger.setAttribute("aria-controls", "changes-viewer");
  trigger.setAttribute("aria-expanded", "false");
  headerActions.prepend(trigger);

  const dialog = element(document, "dialog", "changes-viewer");
  dialog.id = "changes-viewer";
  dialog.setAttribute("aria-labelledby", "changes-title");
  const shell = element(document, "div", "changes-shell");
  const header = element(document, "header", "changes-header");
  const heading = element(document, "div", "changes-heading");
  const title = element(document, "h2", "", "Working changes");
  title.id = "changes-title";
  const summary = element(document, "p", "changes-summary", "Open to read the live worktree.");
  heading.append(title, summary);
  const close = element(document, "button", "changes-close", "Close");
  close.type = "button";
  header.append(heading, close);

  const body = element(document, "div", "changes-body");
  const directory = element(document, "nav", "changes-directory");
  directory.setAttribute("aria-label", "Changed files");
  const list = element(document, "div", "changes-file-list");
  directory.append(list);
  const patchPanel = element(document, "section", "changes-patch-panel");
  patchPanel.setAttribute("aria-label", "Selected file patch");
  const patchHeader = element(document, "header", "changes-patch-header");
  const patchTitle = element(document, "h3", "", "Select a changed file");
  const patchMeta = element(document, "p", "", "Patches load only when selected.");
  patchHeader.append(patchTitle, patchMeta);
  const patchBody = element(document, "div", "changes-patch-body");
  patchBody.append(stateMessage(document, "changes-state", "Choose a textual file from the list."));
  patchPanel.append(patchHeader, patchBody);
  body.append(directory, patchPanel);
  shell.append(header, body);
  dialog.append(shell);
  document.body.append(dialog);

  let sessionId;
  let generation = 0;
  let controller;
  let selectedPath;

  const resetPatch = () => {
    selectedPath = undefined;
    patchTitle.textContent = "Select a changed file";
    patchMeta.textContent = "Patches load only when selected.";
    patchBody.removeAttribute("aria-busy");
    patchBody.replaceChildren(
      stateMessage(document, "changes-state", "Choose a textual file from the list."),
    );
  };

  const request = async (path, currentGeneration) => {
    controller?.abort();
    controller = new AbortController();
    const response = await fetch(path, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (currentGeneration !== generation) return undefined;
    if (!response.ok) throw new Error(await errorMessage(response, "Changes are unavailable"));
    const payload = await response.json();
    return currentGeneration === generation ? payload : undefined;
  };

  const loadPatch = async (file, button) => {
    const currentGeneration = generation;
    selectedPath = file.path;
    for (const candidate of list.querySelectorAll("button"))
      candidate.setAttribute("aria-current", String(candidate === button));
    patchTitle.textContent = file.path;
    patchMeta.textContent = fileMeta(file);
    patchBody.setAttribute("aria-busy", "true");
    patchBody.replaceChildren(stateMessage(document, "changes-state", "Loading patch…"));
    if (!file.patchable) {
      patchBody.removeAttribute("aria-busy");
      patchBody.replaceChildren(
        stateMessage(
          document,
          "changes-state",
          file.binary ? "Binary file — no textual patch." : "This change has no textual patch.",
        ),
      );
      return;
    }
    try {
      const payload = await request(
        `/api/sessions/${encodeURIComponent(sessionId)}/changes/patch?path=${encodeURIComponent(file.path)}`,
        currentGeneration,
      );
      if (!payload || selectedPath !== file.path) return;
      patchBody.removeAttribute("aria-busy");
      patchMeta.textContent = `${fileMeta(payload)}${payload.truncated ? " · Patch truncated at 256 KiB" : ""}`;
      if (typeof payload.patch !== "string" || payload.patch.length === 0)
        patchBody.replaceChildren(
          stateMessage(document, "changes-state", "No textual patch is available."),
        );
      else renderPatch(document, patchBody, payload.patch);
    } catch (error) {
      if (error?.name === "AbortError" || currentGeneration !== generation) return;
      patchBody.removeAttribute("aria-busy");
      patchBody.replaceChildren(
        stateMessage(
          document,
          "changes-state is-error",
          error instanceof Error ? error.message : "Patch could not be loaded.",
        ),
      );
    }
  };

  const renderFiles = (payload) => {
    list.replaceChildren();
    const files = Array.isArray(payload?.files) ? payload.files : [];
    summary.textContent =
      files.length === 0
        ? "No changed files"
        : `${files.length} changed file${files.length === 1 ? "" : "s"}${payload.truncated ? " · Showing first 100" : ""}`;
    if (files.length === 0) {
      list.append(stateMessage(document, "changes-state", "The live worktree has no changes."));
      return;
    }
    for (const file of files) {
      const button = element(document, "button", "changes-file");
      button.type = "button";
      const path = element(document, "span", "changes-file-path", file.path);
      const meta = element(document, "span", "changes-file-meta", fileMeta(file));
      if (file.oldPath) meta.textContent = `${file.oldPath} → ${fileMeta(file)}`;
      if (file.binary) meta.textContent += " · Binary";
      button.append(path, meta);
      button.addEventListener("click", () => void loadPatch(file, button));
      list.append(button);
    }
  };

  const loadList = async () => {
    const currentGeneration = generation;
    list.replaceChildren(stateMessage(document, "changes-state", "Reading live worktree…"));
    try {
      const payload = await request(
        `/api/sessions/${encodeURIComponent(sessionId)}/changes`,
        currentGeneration,
      );
      if (payload) renderFiles(payload);
    } catch (error) {
      if (error?.name === "AbortError" || currentGeneration !== generation) return;
      summary.textContent = "Changes unavailable";
      list.replaceChildren(
        stateMessage(
          document,
          "changes-state is-error",
          error instanceof Error ? error.message : "Changed files could not be loaded.",
        ),
      );
    }
  };

  const open = () => {
    if (!sessionId) return;
    trigger.setAttribute("aria-expanded", "true");
    dialog.showModal();
    void loadList();
  };
  const closeViewer = () => {
    controller?.abort();
    resetPatch();
    trigger.setAttribute("aria-expanded", "false");
    if (dialog.open) dialog.close();
    trigger.focus({ preventScroll: true });
  };

  trigger.addEventListener("click", open);
  close.addEventListener("click", closeViewer);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeViewer();
  });
  dialog.addEventListener("close", () => trigger.setAttribute("aria-expanded", "false"));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeViewer();
  });

  return {
    setSessionId(nextSessionId) {
      if (nextSessionId === sessionId) return;
      sessionId = nextSessionId;
      generation += 1;
      controller?.abort();
      resetPatch();
      list.replaceChildren(stateMessage(document, "changes-state", "Reading live worktree…"));
      summary.textContent = "Reading live worktree";
      if (dialog.open) void loadList();
    },
    dispose() {
      controller?.abort();
      dialog.remove();
      trigger.remove();
    },
  };
}
