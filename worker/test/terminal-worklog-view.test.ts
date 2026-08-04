import { assert, describe, it } from "vitest";
import {
  createWorklogView,
  meaningfulWorklogAnnouncement,
  resolveKeyedItems,
  semanticSignature,
} from "../public/terminal-worklog-view.js";
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

  it("uses a dedicated live region and the keyed module without innerHTML", () => {
    const feedTag = terminalHtml.match(/<div id="worklog-feed"[^>]*>/u)?.[0];
    assert.ok(feedTag);
    assert.notInclude(feedTag, "aria-live");
    assert.match(
      terminalHtml,
      /id="worklog-announcer"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/u,
    );
    assert.include(terminalSource, 'from "/terminal-worklog-view.js"');
    assert.include(terminalSource, "worklogView.update(entries)");
    assert.notInclude(worklogViewSource, "innerHTML");
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
