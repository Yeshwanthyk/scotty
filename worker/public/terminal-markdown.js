import { Marked } from "./vendor/marked.esm.js";

const markdown = new Marked({
  breaks: false,
  gfm: true,
  pedantic: false,
});

const DEFAULT_BASE_URL = "https://scotty.invalid/";
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function element(tag, children = [], attributes = {}) {
  return { tag, attributes, children: children.flat(Infinity) };
}

function tokenText(token) {
  if (typeof token?.text === "string") return token.text;
  if (typeof token?.raw === "string") return token.raw;
  return "";
}

function compactLinkTarget(href) {
  return Array.from(href)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint > 0x20 && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join("");
}

function safeLinkAttributes(href, title, baseUrl) {
  if (typeof href !== "string") return undefined;
  const compactHref = compactLinkTarget(href);
  const normalizedHref = compactHref.replace(/&(?:colon|#(?:0*58|x0*3a));/giu, ":");
  const scheme = normalizedHref.match(/^([a-z][a-z\d+.-]*):/iu)?.[1]?.toLowerCase();
  if (scheme && !SAFE_PROTOCOLS.has(`${scheme}:`)) return undefined;

  let destination;
  let base;
  try {
    base = new URL(baseUrl || DEFAULT_BASE_URL, DEFAULT_BASE_URL);
    destination = new URL(href, base);
  } catch {
    return undefined;
  }
  if (!SAFE_PROTOCOLS.has(destination.protocol)) return undefined;

  const attributes = { href };
  if (typeof title === "string" && title) attributes.title = title;
  if (
    (destination.protocol === "http:" || destination.protocol === "https:") &&
    destination.origin !== base.origin
  ) {
    attributes.rel = "noopener noreferrer";
    attributes.target = "_blank";
  }
  return attributes;
}

function inlineNodes(tokens, options) {
  return (tokens ?? []).flatMap((token) => {
    if (token.type === "text" || token.type === "escape") return tokenText(token);
    if (token.type === "strong") {
      return element("strong", inlineNodes(token.tokens, options));
    }
    if (token.type === "em") return element("em", inlineNodes(token.tokens, options));
    if (token.type === "del") return element("del", inlineNodes(token.tokens, options));
    if (token.type === "codespan") return element("code", [tokenText(token)]);
    if (token.type === "br") return element("br");
    if (token.type === "link") {
      const children = inlineNodes(token.tokens, options);
      const attributes = safeLinkAttributes(token.href, token.title, options.baseUrl);
      return attributes
        ? element("a", children, attributes)
        : element("span", children, { class: "markdown-link-blocked" });
    }
    if (token.type === "html" || token.type === "image") {
      return element("span", [token.raw ?? tokenText(token)], { class: "markdown-raw" });
    }
    return Array.isArray(token.tokens)
      ? inlineNodes(token.tokens, options)
      : (token.raw ?? tokenText(token));
  });
}

function listNode(token, options) {
  const attributes = {};
  if (token.ordered && Number.isSafeInteger(token.start) && token.start !== 1) {
    attributes.start = String(token.start);
  }
  const items = token.items.map((item) =>
    element("li", blockNodes(item.tokens, options, { tight: !item.loose })),
  );
  return element(token.ordered ? "ol" : "ul", items, attributes);
}

function tableNode(token, options) {
  const cells = (values, tag) =>
    values.map((cell) => {
      const attributes = ["left", "center", "right"].includes(cell.align)
        ? { align: cell.align }
        : {};
      return element(tag, inlineNodes(cell.tokens, options), attributes);
    });
  const head = element("thead", [element("tr", cells(token.header, "th"))]);
  const body = element(
    "tbody",
    token.rows.map((row) => element("tr", cells(row, "td"))),
  );
  return element("div", [element("table", [head, body])], { class: "markdown-table-wrap" });
}

function blockNodes(tokens, options, context = {}) {
  return (tokens ?? []).flatMap((token) => {
    if (token.type === "space" || token.type === "def") return [];
    if (token.type === "heading") {
      return element(
        `h${Math.min(6, Math.max(1, token.depth))}`,
        inlineNodes(token.tokens, options),
      );
    }
    if (token.type === "paragraph") {
      return element("p", inlineNodes(token.tokens, options));
    }
    if (token.type === "text") {
      const children = inlineNodes(token.tokens, options);
      return context.tight ? children : element("p", children);
    }
    if (token.type === "list") return listNode(token, options);
    if (token.type === "blockquote") {
      return element("blockquote", blockNodes(token.tokens, options));
    }
    if (token.type === "code") {
      return element("pre", [element("code", [tokenText(token)])]);
    }
    if (token.type === "table") return tableNode(token, options);
    if (token.type === "hr") return element("hr");
    if (token.type === "html") {
      return element("p", [token.raw ?? tokenText(token)], { class: "markdown-raw" });
    }
    return Array.isArray(token.tokens)
      ? blockNodes(token.tokens, options, context)
      : element("p", [token.raw ?? tokenText(token)], { class: "markdown-raw" });
  });
}

export function assistantMarkdownTree(source, { baseUrl = DEFAULT_BASE_URL } = {}) {
  if (typeof source !== "string" || source.length === 0) return [];
  return blockNodes(markdown.lexer(source), { baseUrl });
}

function appendNode(document, parent, descriptor) {
  if (typeof descriptor === "string") {
    parent.append(document.createTextNode(descriptor));
    return;
  }
  const child = document.createElement(descriptor.tag);
  for (const [name, value] of Object.entries(descriptor.attributes)) {
    child.setAttribute(name, value);
  }
  for (const nested of descriptor.children) appendNode(document, child, nested);
  parent.append(child);
}

export function assistantMarkdownFragment(document, source, { baseUrl } = {}) {
  const fragment = document.createDocumentFragment();
  for (const descriptor of assistantMarkdownTree(source, { baseUrl })) {
    appendNode(document, fragment, descriptor);
  }
  return fragment;
}
