import assert from "node:assert/strict";
import test from "node:test";

import { replaceTimelineMessage } from "../worker/public/terminal-timeline.js";
import { assistantMarkdownTree } from "../worker/public/terminal-markdown.js";

const BASE_URL = "https://scotty.example/s/session-1";

function descendants(nodes) {
  const values = Array.isArray(nodes) ? nodes : [nodes];
  return values.flatMap((node) => {
    if (typeof node === "string") return [];
    return [node, ...descendants(node.children ?? [])];
  });
}

function renderedText(nodes) {
  const values = Array.isArray(nodes) ? nodes : [nodes];
  return values
    .map((node) => (typeof node === "string" ? node : renderedText(node.children ?? [])))
    .join("");
}

function findByText(nodes, tag, text) {
  return descendants(nodes).find(
    (node) => node.tag === tag && renderedText(node.children ?? []) === text,
  );
}

test("Pi assistant Markdown renders as structured CommonMark and GFM content", () => {
  const markdown = `### Result

A **strong** and *careful* paragraph with \`inline()\` and [docs](https://example.com/docs).

- first
- second

2. next
3. last

> quoted **context**

\`\`\`js
const answer = 42;
\`\`\`

| Name | Value |
| :--- | ---: |
| Scotty | **ready** |`;
  const tree = assistantMarkdownTree(markdown, { baseUrl: BASE_URL });
  const tags = new Set(descendants(tree).map((node) => node.tag));

  for (const tag of [
    "h3",
    "p",
    "strong",
    "em",
    "code",
    "a",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ]) {
    assert.ok(tags.has(tag), `expected structured <${tag}> output`);
  }
  assert.notEqual(renderedText(tree), markdown, "the raw Markdown source must not remain visible");
  assert.doesNotMatch(renderedText(tree), /\*\*strong\*\*|\| :--- \| ---: \||```/u);
});

test("streaming assistant Markdown is replaced by the structured final message", () => {
  const messages = [];
  replaceTimelineMessage(messages, {
    role: "assistant",
    content: [{ type: "text", text: "### Streaming\n\n**in progress**" }],
  });

  const partialText = messages[0].content[0].text;
  assert.equal(
    renderedText(assistantMarkdownTree(partialText, { baseUrl: BASE_URL })),
    "Streamingin progress",
  );

  replaceTimelineMessage(messages, {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "### Complete\n\n**finished** with [results](/sessions).",
      },
    ],
  });

  assert.equal(
    messages.length,
    1,
    "message_end must replace the streaming message instead of appending",
  );
  const finalTree = assistantMarkdownTree(messages[0].content[0].text, { baseUrl: BASE_URL });
  assert.ok(findByText(finalTree, "h3", "Complete"));
  assert.ok(findByText(finalTree, "strong", "finished"));
  assert.equal(findByText(finalTree, "a", "results")?.attributes.href, "/sessions");
  assert.doesNotMatch(renderedText(finalTree), /###|\*\*|\[results\]/u);
});

test("duplicate Markdown links keep stable focus identities as streaming continues", () => {
  const focusKeyPrefix = "markdown:session-1:conversation-7:0";
  const partialLinks = descendants(
    assistantMarkdownTree("[docs](/docs) and [docs](/docs)", {
      baseUrl: BASE_URL,
      focusKeyPrefix,
    }),
  ).filter((node) => node.tag === "a");
  const continuedLinks = descendants(
    assistantMarkdownTree("[docs](/docs) and [docs](/docs)\n\nStill working.", {
      baseUrl: BASE_URL,
      focusKeyPrefix,
    }),
  ).filter((node) => node.tag === "a");
  const partialKeys = partialLinks.map((link) => link.attributes["data-worklog-focus-key"]);
  const continuedKeys = continuedLinks.map((link) => link.attributes["data-worklog-focus-key"]);

  assert.equal(new Set(partialKeys).size, 2, "duplicate links need distinct focus identities");
  assert.deepEqual(
    continuedKeys,
    partialKeys,
    "continuing the same response must preserve existing link identities",
  );
});

test("assistant Markdown keeps raw HTML inert and rejects dangerous link schemes", () => {
  const tree = assistantMarkdownTree(
    `<script>alert("script")</script>

<img src=x onerror="alert('image')">

[safe](https://example.com/path) [local](/sessions) [mail](mailto:team@example.com) [script](javascript:alert(1)) [entity](javascript&colon;alert(1)) [data](data:text/html,pwned)`,
    { baseUrl: BASE_URL },
  );
  const nodes = descendants(tree);

  assert.ok(!nodes.some((node) => ["script", "img"].includes(node.tag)));
  assert.match(renderedText(tree), /<script>alert\("script"\)<\/script>/u);
  assert.match(renderedText(tree), /<img src=x onerror="alert\('image'\)">/u);

  assert.deepEqual(findByText(tree, "a", "safe")?.attributes, {
    href: "https://example.com/path",
    rel: "noopener noreferrer",
    target: "_blank",
  });
  assert.deepEqual(findByText(tree, "a", "local")?.attributes, { href: "/sessions" });
  assert.deepEqual(findByText(tree, "a", "mail")?.attributes, {
    href: "mailto:team@example.com",
  });
  assert.equal(findByText(tree, "a", "script"), undefined);
  assert.equal(findByText(tree, "a", "entity"), undefined);
  assert.equal(findByText(tree, "a", "data"), undefined);
  assert.match(renderedText(tree), /script entity data/u, "blocked links must keep readable text");
});
