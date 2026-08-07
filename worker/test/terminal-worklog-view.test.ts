import { assert, describe, it } from "vitest";
import {
  createWorklogView,
  meaningfulWorklogAnnouncement,
  resolveKeyedItems,
  semanticSignature,
} from "../public/terminal-worklog-view.js";
import evidenceAttachmentSource from "../public/terminal-evidence-attachment.js?raw";
import terminalHtml from "../public/terminal.html?raw";
import terminalSource from "../public/terminal.js?raw";
import worklogViewSource from "../public/terminal-worklog-view.js?raw";

describe("terminal worklog view", () => {
  it("reuses unchanged keyed nodes and replaces only changed nodes", () => {
    const previous = new Map([
      ["turn:a", { node: "node-a", signature: "same" }],
      ["turn:b", { node: "node-b", signature: "before" }],
    ]);
    const result = resolveKeyedItems(previous, [
      { key: "turn:a", signature: "same", render: () => "unexpected" },
      { key: "turn:b", signature: "after", render: () => "node-b-next" },
      { key: "ask:c", signature: "new", render: () => "node-c" },
    ]);

    assert.deepStrictEqual(result.nodes, ["node-a", "node-b-next", "node-c"]);
    assert.deepStrictEqual(
      {
        added: result.added,
        removed: result.removed,
        replaced: result.replaced,
        reused: result.reused,
      },
      { added: 1, removed: 0, replaced: 1, reused: 1 },
    );
  });

  it("patches order without recreating unchanged controls", () => {
    const container = new FakeContainer<FakeWorklogNode>([{ name: "placeholder" }]);
    const view = createWorklogView(container);
    const askControl = {
      name: "ask-control",
      focused: true,
      value: "draft answer",
      selectionStart: 5,
    };
    view.update([
      { key: "turn:a", signature: "a1", render: () => ({ name: "turn-a" }) },
      { key: "ask:b", signature: "b1", render: () => askControl },
    ]);
    const firstTurn = container.children[0];

    const result = view.update([
      { key: "turn:a", signature: "a2", render: () => ({ name: "turn-a-next" }) },
      { key: "ask:b", signature: "b1", render: () => ({ name: "unexpected" }) },
    ]);

    assert.notStrictEqual(container.children[0], firstTurn);
    assert.strictEqual(container.children[1], askControl);
    assert.deepInclude(container.children[1], {
      focused: true,
      value: "draft answer",
      selectionStart: 5,
    });
    assert.deepStrictEqual(result, { added: 0, removed: 0, replaced: 1, reused: 1 });
  });

  it("restores focus to a matching tool summary when its assistant node is replaced", () => {
    const document = new FakeDocument();
    const container = new FakeDomContainer(document);
    const firstSummary = new FakeDomNode(document, "tool summary", "tool:conversation-7:tool-42");
    const firstAssistant = new FakeDomNode(document, "assistant", undefined, [firstSummary]);
    const view = createWorklogView(container);
    view.update([
      { key: "assistant:conversation-7", signature: "stream-1", render: () => firstAssistant },
    ]);
    firstSummary.focus();

    const nextSummary = new FakeDomNode(
      document,
      "tool summary next",
      "tool:conversation-7:tool-42",
    );
    const nextAssistant = new FakeDomNode(document, "assistant next", undefined, [nextSummary]);
    view.update([
      { key: "assistant:conversation-7", signature: "stream-2", render: () => nextAssistant },
    ]);

    assert.strictEqual(document.activeElement, nextSummary);
    assert.deepStrictEqual(nextSummary.focusOptions, { preventScroll: true });
  });

  it("restores a focused Markdown anchor when the same assistant response is replaced", () => {
    const document = new FakeDocument();
    const container = new FakeDomContainer(document);
    const anchorKey = 'markdown:session-1:conversation-7:0:link:["/docs","docs"]:1';
    const firstAnchor = new FakeDomNode(document, "second docs link", anchorKey);
    const firstAssistant = new FakeDomNode(document, "streaming assistant", undefined, [
      firstAnchor,
    ]);
    const view = createWorklogView(container);
    view.update([
      { key: "assistant:conversation-7", signature: "stream-1", render: () => firstAssistant },
    ]);
    firstAnchor.focus();

    const nextAnchor = new FakeDomNode(document, "second docs link continued", anchorKey);
    const nextAssistant = new FakeDomNode(document, "continued assistant", undefined, [nextAnchor]);
    view.update([
      { key: "assistant:conversation-7", signature: "stream-2", render: () => nextAssistant },
    ]);

    assert.strictEqual(document.activeElement, nextAnchor);
    assert.deepStrictEqual(nextAnchor.focusOptions, { preventScroll: true });
  });

  it("restores selection when a keyed editable ask control is replaced", () => {
    const document = new FakeDocument();
    const container = new FakeDomContainer(document);
    const firstInput = new FakeDomNode(document, "ask input", "ask:request-9:custom");
    firstInput.selectionStart = 2;
    firstInput.selectionEnd = 8;
    firstInput.selectionDirection = "backward";
    const firstAsk = new FakeDomNode(document, "ask", undefined, [firstInput]);
    const view = createWorklogView(container);
    view.update([{ key: "request:request-9", signature: "ask-1", render: () => firstAsk }]);
    firstInput.focus();

    const nextInput = new FakeDomNode(document, "ask input next", "ask:request-9:custom");
    const nextAsk = new FakeDomNode(document, "ask next", undefined, [nextInput]);
    view.update([{ key: "request:request-9", signature: "ask-2", render: () => nextAsk }]);

    assert.strictEqual(document.activeElement, nextInput);
    assert.deepStrictEqual(nextInput.focusOptions, { preventScroll: true });
    assert.deepStrictEqual(
      [nextInput.selectionStart, nextInput.selectionEnd, nextInput.selectionDirection],
      [2, 8, "backward"],
    );
  });

  it("builds stable semantic signatures independent of object key order", () => {
    assert.strictEqual(
      semanticSignature({ request: { method: "input", id: "ask-1" }, delivered: false }),
      semanticSignature({ delivered: false, request: { id: "ask-1", method: "input" } }),
    );
    assert.notStrictEqual(
      semanticSignature({ request: { id: "ask-1" }, delivered: false }),
      semanticSignature({ request: { id: "ask-1" }, delivered: true }),
    );
  });

  it("announces only questions and run-state transitions", () => {
    assert.strictEqual(
      meaningfulWorklogAnnouncement({
        type: "extension_ui_request",
        method: "input",
        wasActive: true,
        isActive: true,
      }),
      "Pi needs your input.",
    );
    assert.strictEqual(
      meaningfulWorklogAnnouncement({
        type: "message_update",
        wasActive: true,
        isActive: true,
      }),
      undefined,
    );
    assert.strictEqual(
      meaningfulWorklogAnnouncement({
        type: "agent_settled",
        wasActive: true,
        isActive: false,
      }),
      "Pi finished working.",
    );
  });

  it("keys changing worklog controls from conversation, tool, and request identities", () => {
    assert.include(terminalSource, "`activity:${conversationKey}`");
    assert.include(terminalSource, "`reasoning:${conversationKey}`");
    assert.include(terminalSource, "`${conversationKey}:${tool.id ?? index}`");
    assert.include(terminalSource, "`tool:${disclosureKey}`");
    assert.include(terminalSource, "`ask:${request.id}:option:${index}:${optionId}`");
    assert.include(terminalSource, "`ask:${request.id}:custom`");
    assert.include(terminalSource, "`ask:${request.id}:reply`");
    assert.include(terminalSource, "`ask:${request.id}:cancel`");
  });

  it("renders browser evidence inside its keyed tool without changing generic tools", () => {
    assert.include(terminalSource, 'from "/terminal-evidence-attachment.js"');
    assert.include(terminalSource, "browserEvidenceAttachment(tool, currentSessionId)");
    assert.include(terminalSource, "details.append(renderBrowserEvidenceAttachment(evidence))");
    assert.include(terminalSource, 'image.loading = "lazy"');
    assert.include(terminalSource, 'credentials: "same-origin"');
    assert.include(terminalSource, '"Open Replay"');
    assert.include(terminalSource, "The run failed before a screenshot was available.");
    assert.include(terminalSource, "Evidence unavailable");
    assert.include(evidenceAttachmentSource, "value.summaryUrl !== paths.replay");
    assert.notInclude(evidenceAttachmentSource, "base64");
    assert.notInclude(evidenceAttachmentSource, "objectKey");
  });

  it("uses a dedicated live region and the keyed modules without innerHTML", () => {
    const feedTag = terminalHtml.match(/<div id="worklog-feed"[^>]*>/u)?.[0];
    assert.ok(feedTag);
    assert.notInclude(feedTag, "aria-live");
    assert.match(
      terminalHtml,
      /id="worklog-announcer"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/u,
    );
    assert.include(terminalSource, 'from "/terminal-worklog-view.js"');
    assert.include(terminalSource, "worklogView.update(entries)");
    assert.include(terminalSource, "data-worklog-focus-key");
    assert.notInclude(terminalSource, "innerHTML");
    assert.notInclude(worklogViewSource, "innerHTML");
    assert.notInclude(evidenceAttachmentSource, "innerHTML");
  });
});

interface FakeWorklogNode {
  readonly name: string;
  readonly focused?: boolean;
  readonly value?: string;
  readonly selectionStart?: number;
}

class FakeContainer<Node> {
  readonly children: Node[];

  constructor(children: Node[]) {
    this.children = children;
  }

  insertBefore(node: Node, before: Node | null) {
    const existingIndex = this.children.indexOf(node);
    if (existingIndex >= 0) this.children.splice(existingIndex, 1);
    const nextIndex = before === null ? this.children.length : this.children.indexOf(before);
    this.children.splice(nextIndex < 0 ? this.children.length : nextIndex, 0, node);
  }

  removeChild(node: Node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
  }
}

class FakeDocument {
  activeElement: FakeDomNode | undefined;
}

class FakeDomNode {
  readonly children: FakeDomNode[];
  readonly dataset: { worklogFocusKey?: string };
  readonly ownerDocument: FakeDocument;
  parentNode: FakeDomNode | undefined;
  focusOptions: { preventScroll?: boolean } | undefined;
  selectionStart: number | undefined;
  selectionEnd: number | undefined;
  selectionDirection: "backward" | "forward" | "none" | undefined;

  constructor(
    document: FakeDocument,
    readonly name: string,
    focusKey?: string,
    children: FakeDomNode[] = [],
  ) {
    this.ownerDocument = document;
    this.dataset = focusKey ? { worklogFocusKey: focusKey } : {};
    this.children = children;
    for (const child of children) child.parentNode = this;
  }

  contains(candidate: unknown): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  querySelectorAll(selector: string): FakeDomNode[] {
    assert.strictEqual(selector, "[data-worklog-focus-key]");
    return this.children.flatMap((child) => [
      ...(child.dataset.worklogFocusKey ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  focus(options?: { preventScroll?: boolean }) {
    this.focusOptions = options;
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start: number, end: number, direction?: "backward" | "forward" | "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}

class FakeDomContainer extends FakeDomNode {
  constructor(document: FakeDocument) {
    super(document, "container");
  }

  insertBefore(node: FakeDomNode, before: FakeDomNode | null) {
    const existingIndex = this.children.indexOf(node);
    if (existingIndex >= 0) this.children.splice(existingIndex, 1);
    const nextIndex = before === null ? this.children.length : this.children.indexOf(before);
    this.children.splice(nextIndex < 0 ? this.children.length : nextIndex, 0, node);
    node.parentNode = this;
  }

  removeChild(node: FakeDomNode) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    if (node.contains(this.ownerDocument.activeElement))
      this.ownerDocument.activeElement = undefined;
    node.parentNode = undefined;
  }
}
