import { Marked } from "./vendor/marked.esm.js";
import { browserEvidenceAttachment } from "./terminal-evidence-attachment.js";
import { conversationItems } from "./terminal-timeline.js";

const markdown = new Marked({
  breaks: false,
  gfm: true,
  pedantic: false,
});

const EVIDENCE_REFERENCE = /^scotty-evidence:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u;
const EVIDENCE_REFERENCE_IN_TEXT =
  /(^|[\s([{"'])scotty-evidence:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?=$|[\s)\]}"'.,!;])/gu;

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

function pushExactReference(value, references) {
  if (typeof value !== "string") return;
  const match = value.match(EVIDENCE_REFERENCE);
  if (match) references.push(match[1]);
}

function pushTextReferences(value, references) {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(EVIDENCE_REFERENCE_IN_TEXT)) references.push(match[2]);
}

function visitTokens(tokens, references) {
  for (const token of tokens ?? []) {
    if (!token || typeof token !== "object") continue;
    if (token.type === "code" || token.type === "codespan" || token.type === "html") continue;
    if (token.type === "image") continue;
    if (token.type === "link") {
      pushExactReference(token.href, references);
      visitTokens(token.tokens, references);
      continue;
    }
    if (token.type === "text" || token.type === "escape") {
      pushTextReferences(token.text, references);
      if (Array.isArray(token.tokens)) visitTokens(token.tokens, references);
      continue;
    }
    if (token.type === "list") {
      for (const item of token.items ?? []) visitTokens(item.tokens, references);
      continue;
    }
    if (token.type === "table") {
      for (const cell of token.header ?? []) visitTokens(cell.tokens, references);
      for (const row of token.rows ?? []) {
        for (const cell of row) visitTokens(cell.tokens, references);
      }
      continue;
    }
    if (Array.isArray(token.tokens)) visitTokens(token.tokens, references);
  }
}

export function assistantEvidenceReferences(source) {
  if (typeof source !== "string" || source.length === 0) return [];
  const references = [];
  visitTokens(markdown.lexer(source), references);
  return [...new Set(references)];
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
      return {
        kind: "summary",
        conversationKey: conversation.key,
        update,
        evidence: assistantEvidenceReferences(update).map((jobId) =>
          evidenceProjection(jobId, provenance, sessionId),
        ),
      };
    }
  }
  return { kind: "empty", evidence: [] };
}
