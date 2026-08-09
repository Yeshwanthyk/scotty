import { Marked } from "./vendor/marked.esm.js";
import { browserEvidenceAttachment } from "./terminal-evidence-attachment.js";
import { browserHatchReference } from "./terminal-hatch-reference.js";
import { conversationItems } from "./terminal-timeline.js";

const markdown = new Marked({
  breaks: false,
  gfm: true,
  pedantic: false,
});

const IDENTIFIER_SOURCE = "([A-Za-z0-9][A-Za-z0-9_-]{0,127})";
const REFERENCE_RULES = {
  evidence: {
    exact: new RegExp(`^scotty-evidence:${IDENTIFIER_SOURCE}$`, "u"),
    text: new RegExp(
      `(^|[\\s([{"'])scotty-evidence:${IDENTIFIER_SOURCE}(?=$|[\\s)\\]}"'.,!;])`,
      "gu",
    ),
  },
  hatch: {
    exact: new RegExp(`^scotty-hatch:${IDENTIFIER_SOURCE}$`, "u"),
    text: new RegExp(`(^|[\\s([{"'])scotty-hatch:${IDENTIFIER_SOURCE}(?=$|[\\s)\\]}"'.,!;])`, "gu"),
  },
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function messageText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : firstString(item?.text, item?.content, "")))
      .filter(Boolean)
      .join("\n");
  }
  if (isObject(value)) return firstString(value.text, value.content, value.message, "") ?? "";
  return "";
}

function assistantUpdate(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    const text = message.content
      .flatMap((part) => {
        if (typeof part === "string") return part ? [part] : [];
        if (part?.type !== "text") return [];
        const value = messageText(part);
        return value ? [value] : [];
      })
      .join("\n\n");
    if (text) return text;
  }
  return messageText(message?.text ?? message?.message);
}

function pushExactReference(value, references, rule) {
  if (typeof value !== "string") return;
  const match = value.match(rule.exact);
  if (match) references.push(match[1]);
}

function pushTextReferences(value, references, rule) {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(rule.text)) references.push(match[2]);
}

function visitTokens(tokens, references, rule) {
  for (const token of tokens ?? []) {
    if (!token || typeof token !== "object") continue;
    if (token.type === "code" || token.type === "html") continue;
    if (token.type === "codespan") {
      pushExactReference(token.text, references, rule);
      continue;
    }
    if (token.type === "image") continue;
    if (token.type === "link") {
      pushExactReference(token.href, references, rule);
      visitTokens(token.tokens, references, rule);
      continue;
    }
    if (token.type === "text" || token.type === "escape") {
      pushTextReferences(token.text, references, rule);
      if (Array.isArray(token.tokens)) visitTokens(token.tokens, references, rule);
      continue;
    }
    if (token.type === "list") {
      for (const item of token.items ?? []) visitTokens(item.tokens, references, rule);
      continue;
    }
    if (token.type === "table") {
      for (const cell of token.header ?? []) visitTokens(cell.tokens, references, rule);
      for (const row of token.rows ?? []) {
        for (const cell of row) visitTokens(cell.tokens, references, rule);
      }
      continue;
    }
    if (Array.isArray(token.tokens)) visitTokens(token.tokens, references, rule);
  }
}

function assistantReferences(source, rule) {
  if (typeof source !== "string" || source.length === 0) return [];
  const references = [];
  visitTokens(markdown.lexer(source), references, rule);
  return [...new Set(references)];
}

export function assistantEvidenceReferences(source) {
  return assistantReferences(source, REFERENCE_RULES.evidence);
}

export function assistantHatchReferences(source) {
  return assistantReferences(source, REFERENCE_RULES.hatch);
}

function conversationTools(conversation, tools) {
  return [
    ...conversation.toolIds.map((id) => tools?.get?.(id)).filter(Boolean),
    ...conversation.inlineTools,
  ];
}

function evidenceProjection(jobId, tools, sessionId) {
  const attachment = tools
    .map((tool) => browserEvidenceAttachment(tool, sessionId))
    .find((candidate) => candidate?.kind === "evidence" && candidate.jobId === jobId);
  return attachment ?? { kind: "unavailable", jobId };
}

function hatchProjection(hatchId, tools, sessionId) {
  const reference = tools
    .map((tool) => browserHatchReference(tool, sessionId))
    .find((candidate) => candidate?.kind === "hatch" && candidate.hatchId === hatchId);
  return reference ?? { kind: "unavailable", hatchId };
}

function conversationReferences(conversation, selectReferences) {
  return [
    ...new Set(
      conversation.assistants.flatMap((assistant) => selectReferences(assistantUpdate(assistant))),
    ),
  ];
}

export function projectSessionSummary(messages, tools, sessionId) {
  const { items } = conversationItems(Array.isArray(messages) ? messages : []);
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const conversation = items[itemIndex];
    if (conversation.kind !== "conversation") continue;
    for (
      let assistantIndex = conversation.assistants.length - 1;
      assistantIndex >= 0;
      assistantIndex -= 1
    ) {
      const update = assistantUpdate(conversation.assistants[assistantIndex]);
      if (!update) continue;
      const provenance = conversationTools(conversation, tools);
      const evidence = conversationReferences(conversation, assistantEvidenceReferences).map(
        (jobId) => evidenceProjection(jobId, provenance, sessionId),
      );
      const passed = evidence.filter(
        (item) => item.kind === "evidence" && item.status === "succeeded",
      );
      const before = passed.find((item) => item.video === false);
      const after = passed.find((item) => item.video === true);
      return {
        kind: "summary",
        conversationKey: conversation.key,
        update,
        hatches: conversationReferences(conversation, assistantHatchReferences).map((hatchId) =>
          hatchProjection(hatchId, provenance, sessionId),
        ),
        evidence,
        ...(before === undefined || after === undefined
          ? {}
          : {
              showcase: {
                beforeJobId: before.jobId,
                afterJobId: after.jobId,
                path: `/s/${encodeURIComponent(sessionId)}/showcase/${encodeURIComponent(before.jobId)}/${encodeURIComponent(after.jobId)}`,
              },
            }),
      };
    }
  }
  return { kind: "empty", hatches: [], evidence: [] };
}
