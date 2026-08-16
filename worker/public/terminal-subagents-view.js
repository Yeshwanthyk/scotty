export function encodeSubagentSteerArguments(child, revision, message) {
  return JSON.stringify({
    version: 1,
    action: "steer",
    childId: child.id,
    revision,
    message,
  });
}

import {
  selectedSubagent,
  subagentCountLabel,
  subagentElapsed,
  subagentModelLabel,
  subagentTranscriptTail,
} from "./terminal-subagents-projection.js";

function copy(document, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value ?? "";
  return node;
}

function section(document, title, value, className = "subagent-detail-section") {
  const node = document.createElement("section");
  node.className = className;
  node.append(copy(document, "h3", "subagent-detail-label", title));
  node.append(copy(document, "div", "subagent-detail-copy", value || "No update yet."));
  return node;
}

export function renderSubagentList(document, snapshot, onSelect) {
  const wrapper = document.createElement("section");
  wrapper.className = "subagent-browser-list";
  const count = snapshot?.children?.length ?? 0;
  wrapper.append(copy(document, "h2", "subagent-browser-heading", subagentCountLabel(count)));
  if (count === 0) {
    wrapper.append(copy(document, "p", "activity-empty", "No subagents are currently working."));
    return wrapper;
  }
  const list = document.createElement("div");
  list.className = "subagent-browser-items";
  for (const child of snapshot.children) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "subagent-browser-item";
    button.dataset.subagentId = child.id;
    button.addEventListener("click", () => onSelect(child.id));
    const heading = document.createElement("span");
    heading.className = "subagent-browser-item-heading";
    heading.append(
      copy(document, "strong", "", child.title || child.id),
      copy(document, "span", "subagent-browser-status", "Working"),
    );
    button.append(
      heading,
      copy(
        document,
        "span",
        "subagent-browser-item-meta",
        `${subagentModelLabel(child)} · ${subagentElapsed(child)}`,
      ),
    );
    list.append(button);
  }
  wrapper.append(list);
  return wrapper;
}

export function renderSubagentDetail(document, child, onBack, onSteer = () => {}) {
  const article = document.createElement("article");
  article.className = "subagent-browser-detail";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "subagent-back-button";
  back.textContent = "Back to parent";
  back.addEventListener("click", onBack);
  const header = document.createElement("header");
  header.className = "subagent-detail-header";
  header.append(
    back,
    copy(document, "h2", "subagent-detail-title", child.title || child.id),
    copy(
      document,
      "p",
      "subagent-detail-meta",
      `${child.id} · ${child.status === "running" ? "Working" : child.status} · ${subagentModelLabel(child)} · elapsed ${subagentElapsed(child)}`,
    ),
  );
  article.append(header);
  if (child.status === "running") {
    const form = document.createElement("form");
    form.className = "subagent-steer-composer";
    const input = document.createElement("textarea");
    input.rows = 2;
    input.placeholder = "Send a steer to this subagent…";
    input.setAttribute("aria-label", "Steer subagent");
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "send-button";
    send.textContent = "Steer";
    form.append(input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      input.value = "";
      onSteer(message);
    });
    article.append(form);
  }
  article.append(section(document, "Prompt", child.prompt));
  const transcript = subagentTranscriptTail(child);
  if (transcript) article.append(section(document, "Transcript tail", transcript));
  if (child.tools?.length)
    article.append(
      section(
        document,
        "Current tools",
        child.tools
          .map((tool) => `${tool.name || "tool"}${tool.output ? ` — ${tool.output}` : ""}`)
          .join("\n"),
      ),
    );
  if (child.queued?.length)
    article.append(
      section(
        document,
        "Queued",
        child.queued.map((item) => `${item.kind}: ${item.text}`).join("\n"),
      ),
    );
  if (child.output)
    article.append(
      section(document, child.status === "running" ? "Live output" : "Final output", child.output),
    );
  if (child.failure) article.append(section(document, "Failure", child.failure));
  const reasoning = (child.transcript || [])
    .filter((item) => item.kind === "thinking")
    .map((item) => item.text)
    .join("\n\n");
  if (reasoning) {
    const details = document.createElement("details");
    details.className = "subagent-reasoning";
    details.append(
      copy(document, "summary", "", "Reasoning"),
      copy(document, "div", "subagent-detail-copy", reasoning),
    );
    article.append(details);
  }
  return article;
}

export function renderSelectedSubagent(document, snapshot, selectedId, onBack, onSteer) {
  const child = selectedSubagent(snapshot, selectedId);
  return child
    ? renderSubagentDetail(document, child, onBack, onSteer)
    : renderSubagentList(document, snapshot, () => {});
}
