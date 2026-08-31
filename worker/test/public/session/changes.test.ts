import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { assert, describe, it } from "vitest";
import {
  createChangesViewer,
  parsePatchLines,
  splitPatchRows,
} from "../../../public/session/changes.js";
import changesSource from "../../../public/session/changes.js?raw";

const changesCss = readFileSync(
  new URL("../../../public/session/changes.css", import.meta.url),
  "utf8",
);

type TestEventListener = (event: {
  readonly target: TestElement;
  readonly preventDefault: () => void;
}) => void;

class TestElement {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, TestEventListener[]>();
  parent: TestElement | undefined;
  className = "";
  id = "";
  open = false;
  textContent = "";
  type = "";

  constructor(readonly tagName: string) {}

  append(...nodes: TestElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  prepend(...nodes: TestElement[]): void {
    for (const node of nodes.toReversed()) {
      node.parent = this;
      this.children.unshift(node);
    }
  }

  replaceChildren(...nodes: TestElement[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(name: string, listener: TestEventListener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  querySelectorAll(selector: string): TestElement[] {
    return this.descendants().filter((node) => node.tagName === selector);
  }

  descendants(): TestElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  click(): void {
    const event = { target: this, preventDefault: () => undefined };
    for (const listener of this.listeners.get("click") ?? []) listener(event);
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    const event = { target: this, preventDefault: () => undefined };
    for (const listener of this.listeners.get("close") ?? []) listener(event);
  }

  focus(): void {}

  remove(): void {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
}

class TestDocument {
  readonly body = new TestElement("body");

  createElement(tagName: string): TestElement {
    return new TestElement(tagName);
  }
}

interface TestResponse {
  readonly ok: boolean;
  readonly json: () => Promise<unknown>;
}

const deferred = <A>() => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const byClass = (root: TestElement, className: string): TestElement => {
  const match = root.descendants().find((node) => node.className === className);
  assert.isDefined(match, `Missing .${className}`);
  return match;
};

describe("session changes viewer", () => {
  it("pairs adjacent old and new lines for roomy split presentation", () => {
    const lines = parsePatchLines("@@ -1,2 +1,2 @@\n same\n-old\n+new");
    const rows = splitPatchRows(lines);

    assert.deepStrictEqual(
      lines.map((line) => line.kind),
      ["hunk", "context", "deletion", "addition"],
    );
    assert.deepInclude(rows.at(-1), {
      kind: "pair",
      old: { kind: "deletion", text: "-old" },
      next: { kind: "addition", text: "+new" },
    });
  });

  it("switches automatically from split to unified without a preference or mode toggle", () => {
    assert.include(changesCss, ".changes-split");
    assert.include(changesCss, ".changes-unified");
    assert.match(
      changesCss,
      /@media \(max-width: 1099px\)[\s\S]*?\.changes-split \{[\s\S]*?display: none;[\s\S]*?\.changes-unified \{[\s\S]*?display: block;/u,
    );
    assert.notInclude(changesSource, "localStorage");
    assert.notInclude(changesSource, "mode-toggle");
  });

  it("renders text safely and ignores stale list or patch responses after a session switch", () => {
    assert.include(changesSource, "node.textContent = text");
    assert.notInclude(changesSource, ".innerHTML");
    assert.notInclude(changesSource, 'setAttribute("role", "table")');
    assert.include(changesSource, 'setAttribute("aria-live", "polite")');
    assert.include(changesSource, "PATCH_LINE_LIMIT = 4_000");
    assert.include(changesSource, "currentGeneration !== generation");
    assert.include(changesSource, "controller?.abort()");
    assert.include(changesSource, "selectedPath !== file.path");
    assert.notInclude(changesSource, "setInterval");
    assert.notInclude(changesSource, "setTimeout");
  });

  it("lazily loads a patch and behaviorally fences stale session responses", async () => {
    const document = new TestDocument();
    const headerActions = new TestElement("div");
    document.body.append(headerActions);
    const requests: Array<{
      readonly url: string;
      readonly signal: AbortSignal | undefined;
      readonly response: ReturnType<typeof deferred<TestResponse>>;
    }> = [];
    const fetch = (input: string, init?: { readonly signal?: AbortSignal }) => {
      const response = deferred<TestResponse>();
      requests.push({ url: input, signal: init?.signal, response });
      return response.promise;
    };
    const viewer = createChangesViewer({
      document: document as never,
      fetch: fetch as never,
      headerActions: headerActions as never,
    });
    const file = (path: string) => ({
      path,
      status: "modified",
      staged: false,
      unstaged: true,
      additions: 1,
      deletions: 1,
      binary: false,
      patchable: true,
    });

    viewer.setSessionId("first");
    byClass(document.body, "changes-toggle").click();
    assert.lengthOf(requests, 1);
    const staleJson = deferred<unknown>();
    requests[0].response.resolve({ ok: true, json: () => staleJson.promise });
    await flush();

    viewer.setSessionId("second");
    assert.isTrue(requests[0].signal?.aborted);
    assert.lengthOf(requests, 2);
    requests[1].response.resolve({
      ok: true,
      json: () => Promise.resolve({ files: [file("new.ts")], truncated: false }),
    });
    await flush();
    staleJson.resolve({ files: [file("stale.ts")], truncated: false });
    await flush();
    assert.strictEqual(byClass(document.body, "changes-file-path").textContent, "new.ts");
    assert.lengthOf(requests, 2, "patch fetch remains lazy until selection");

    byClass(document.body, "changes-file").click();
    assert.lengthOf(requests, 3);
    assert.include(requests[2].url, "/changes/patch?path=new.ts");
    const stalePatchJson = deferred<unknown>();
    requests[2].response.resolve({ ok: true, json: () => stalePatchJson.promise });
    await flush();
    viewer.setSessionId("third");
    stalePatchJson.resolve({ ...file("new.ts"), patch: "+stale", truncated: false });
    await flush();

    const patchPanel = byClass(document.body, "changes-patch-panel");
    assert.strictEqual(
      patchPanel.descendants().find((node) => node.tagName === "h3")?.textContent,
      "Select a changed file",
    );
    const patchBody = byClass(document.body, "changes-patch-body");
    assert.notInclude(
      patchBody
        .descendants()
        .map((node) => node.textContent)
        .join(" "),
      "stale",
    );
    assert.isUndefined(patchBody.getAttribute("aria-live"));
    assert.strictEqual(patchBody.descendants()[0].getAttribute("role"), "status");
    viewer.dispose();
  });

  it("treats repeated signs in source lines as content rather than file metadata", () => {
    assert.deepStrictEqual(
      parsePatchLines("++value\n--value\n+++ b/file\n--- a/file").map((line) => line.kind),
      ["addition", "deletion", "meta", "meta"],
    );
  });

  it("uses explicit empty, binary, truncated, loading, and error copy", () => {
    for (const copy of [
      "No changed files",
      "Binary file — no textual patch.",
      "Patch truncated at 256 KiB",
      "Loading patch…",
      "Changes unavailable",
    ])
      assert.include(changesSource, copy);
  });
});
