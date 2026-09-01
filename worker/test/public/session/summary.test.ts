import { assert, describe, it } from "vitest";
import { projectionFromSnapshot } from "../../../public/session/chat.js";
import {
  decodeSummaryEvidence,
  decodeSummaryHatch,
  createEvidenceLoader,
  createHatchStatusLoader,
  createSummaryView,
  extractSummaryReferences,
  summaryProjection,
} from "../../../public/session/summary.js";
import summarySource from "../../../public/session/summary.js?raw";

const sessionId = "a0b1c2d3e4f5";
const evidenceResult = {
  id: "result-1",
  role: "toolResult",
  toolCallId: "tool-1",
  toolName: "scotty_browser_test",
  content: {
    details: {
      jobId: "job-1",
      status: "succeeded",
      summaryUrl: `/s/${sessionId}/evidence/job-1`,
      completedSteps: 1,
      frameCount: 1,
      video: false,
    },
  },
};
const snapshot = (messages: ReadonlyArray<unknown>) => ({
  epoch: "epoch-1",
  sessionRevision: 1,
  baseSequence: 0,
  sequence: 0,
  state: { isStreaming: false },
  messages,
  overlapEvents: [],
  activeTools: [],
  queue: { steer: [], followUp: [] },
  pendingUi: [],
});

class TestNode {
  readonly children: TestNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  parent: TestNode | undefined;
  className = "";
  textContent = "";
  href = "";
  src = "";
  alt = "";
  loading = "";

  constructor(
    readonly tagName: string,
    readonly fragment = false,
  ) {}

  get childNodes(): ReadonlyArray<TestNode> {
    return this.children;
  }

  append(...nodes: TestNode[]): void {
    for (const node of nodes) {
      const appended = node.fragment ? [...node.children] : [node];
      for (const child of appended) {
        child.parent = this;
        this.children.push(child);
      }
      if (node.fragment) node.children.length = 0;
    }
  }

  replaceChildren(...nodes: TestNode[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  descendants(): TestNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

class TestDocument {
  createElement(tagName: string): TestNode {
    return new TestNode(tagName);
  }

  createDocumentFragment(): TestNode {
    return new TestNode("#fragment", true);
  }

  createTextNode(text: string): TestNode {
    const node = new TestNode("#text");
    node.textContent = text;
    return node;
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
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

const evidencePayload = (jobId: string) => ({
  jobId,
  status: "succeeded",
  totalSteps: 1,
  completedSteps: 1,
  frameCount: 1,
  steps: [
    {
      index: 0,
      name: "Home",
      status: "passed",
      assertions: [{ kind: "visible", passed: true }],
      frame: { frameId: `frame-${jobId}`, offsetMillis: 10 },
    },
  ],
});

const summaryMessagesForSession = (targetSessionId: string, ...jobIds: string[]) => [
  { id: "u1", role: "user", content: "Check the page" },
  ...jobIds.flatMap((jobId, index) => [
    {
      id: `call-${jobId}`,
      role: "assistant",
      content: [{ type: "toolCall", id: `tool-${index}`, name: "scotty_browser_test" }],
    },
    {
      ...evidenceResult,
      id: `result-${jobId}`,
      toolCallId: `tool-${index}`,
      content: {
        details: {
          ...evidenceResult.content.details,
          jobId,
          summaryUrl: `/s/${targetSessionId}/evidence/${jobId}`,
        },
      },
    },
  ]),
  {
    id: "summary",
    role: "assistant",
    content: jobIds.map((jobId) => `scotty-evidence:${jobId}`).join(" "),
  },
];

const summaryMessages = (...jobIds: string[]) => summaryMessagesForSession(sessionId, ...jobIds);

const nodeForReference = (root: TestNode, reference: string): TestNode => {
  const node = root.descendants().find((candidate) => candidate.dataset.reference === reference);
  assert.isDefined(node, `Missing ${reference}`);
  return node;
};

const renderedText = (node: TestNode): string =>
  [node.textContent, ...node.children.map(renderedText)].filter(Boolean).join(" ");

const response = (value: unknown): TestResponse => ({
  ok: true,
  json: () => Promise.resolve(value),
});

describe("agent Summary projection", () => {
  it("selects the latest assistant update and verifies its same-conversation reference", () => {
    const projection = projectionFromSnapshot(
      snapshot([
        { id: "u1", role: "user", content: "Check the page" },
        {
          id: "a1",
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "scotty_browser_test" }],
        },
        evidenceResult,
        {
          id: "a2",
          role: "assistant",
          content: "Looks good. scotty-evidence:job-1",
        },
      ]),
    );

    const summary = summaryProjection(projection, sessionId);
    assert.strictEqual(summary.update, "Looks good. scotty-evidence:job-1");
    assert.deepInclude(summary.artifacts[0], {
      kind: "evidence",
      reference: "scotty-evidence:job-1",
      jobId: "job-1",
    });
  });

  it("does not project a structured result that the assistant did not reference", () => {
    const projection = projectionFromSnapshot(
      snapshot([
        { id: "u1", role: "user", content: "Check the page" },
        evidenceResult,
        { id: "a1", role: "assistant", content: "The run completed." },
      ]),
    );
    assert.deepStrictEqual(summaryProjection(projection, sessionId), {
      objective: "Check the page",
      update: "The run completed.",
      previousUpdates: [],
      artifacts: [],
    });
  });

  it("keeps verified evidence from earlier turns in the whole-session summary", () => {
    const projection = projectionFromSnapshot(
      snapshot([
        { id: "u1", role: "user", content: "Check the page" },
        evidenceResult,
        { id: "a1", role: "assistant", content: "scotty-evidence:job-1" },
        { id: "u2", role: "user", content: "Again" },
        {
          id: "a2",
          role: "assistant",
          content: "scotty-evidence:job-1 and scotty-hatch:invented",
        },
      ]),
    );
    const summary = summaryProjection(projection, sessionId);
    assert.strictEqual(summary.objective, "Check the page");
    assert.strictEqual(summary.update, "scotty-evidence:job-1 and scotty-hatch:invented");
    assert.deepStrictEqual(summary.previousUpdates, ["scotty-evidence:job-1"]);
    assert.deepInclude(summary.artifacts[0], {
      kind: "evidence",
      reference: "scotty-evidence:job-1",
      jobId: "job-1",
    });
  });

  it("reconstructs the same Summary after a fresh snapshot", () => {
    const messages = [
      { id: "u1", role: "user", content: "Check the page" },
      evidenceResult,
      { id: "a1", role: "assistant", content: "scotty-evidence:job-1" },
    ];
    const before = summaryProjection(projectionFromSnapshot(snapshot(messages)), sessionId);
    const after = summaryProjection(projectionFromSnapshot(snapshot(messages)), sessionId);
    assert.deepStrictEqual(after, before);
  });

  it("accepts only bounded exact reference markers", () => {
    assert.deepStrictEqual(
      extractSummaryReferences(
        "scotty-evidence:job-1 scotty-evidence:job-1 scotty-hatch:hatch_2 nope:job-1",
      ),
      ["scotty-evidence:job-1", "scotty-hatch:hatch_2"],
    );
  });

  it("decodes allow-listed evidence and Hatch projections", () => {
    const evidencePayload = {
      jobId: "job-1",
      status: "succeeded",
      totalSteps: 1,
      completedSteps: 1,
      frameCount: 1,
      steps: [
        {
          index: 0,
          name: "Home",
          status: "passed",
          assertions: [{ kind: "text", passed: true }],
          frame: { frameId: "frame-1", offsetMillis: 10 },
        },
      ],
    };
    const evidence = decodeSummaryEvidence(evidencePayload, "job-1");
    assert.deepInclude(evidence, { jobId: "job-1", frameCount: 1 });
    assert.isUndefined(decodeSummaryEvidence({ ...evidencePayload, jobId: "other" }, "job-1"));

    assert.deepInclude(
      decodeSummaryEvidence(
        {
          ...evidencePayload,
          status: "failed",
          completedSteps: 0,
          frameCount: 0,
          steps: [],
          failure: { code: "port_conflict" },
        },
        "job-1",
      ),
      { failure: { code: "port_conflict" }, frameCount: 0 },
    );
    assert.isUndefined(
      decodeSummaryEvidence({ ...evidencePayload, failure: { code: "private_failure" } }, "job-1"),
    );

    const recordedEvidence = decodeSummaryEvidence(
      {
        ...evidencePayload,
        video: {
          artifactId: "recording",
          sha256: "a".repeat(64),
          bytes: 1_024,
          capturedAt: "2026-08-30T12:00:00.000Z",
          offsetMillis: 100,
        },
      },
      "job-1",
    );
    assert.deepStrictEqual(recordedEvidence?.video, {
      artifactId: "recording",
      sha256: "a".repeat(64),
      bytes: 1_024,
      capturedAt: "2026-08-30T12:00:00.000Z",
      offsetMillis: 100,
    });
    assert.isUndefined(
      decodeSummaryEvidence(
        { ...evidencePayload, video: { artifactId: "recording", sha256: "not-a-digest" } },
        "job-1",
      ),
    );

    assert.deepStrictEqual(
      decodeSummaryHatch({
        status: "configured",
        hatchId: "hatch-1",
        service: { name: "Preview", port: 4173 },
        desiredStatus: "open",
        observedStatus: "running",
        exposure: "active",
      }),
      {
        configured: true,
        hatchId: "hatch-1",
        serviceName: "Preview",
        desiredStatus: "open",
        observedStatus: "running",
        exposure: "active",
        available: true,
      },
    );
    assert.deepStrictEqual(decodeSummaryHatch({ status: "not_configured" }), {
      configured: false,
      available: false,
    });
    assert.deepStrictEqual(
      decodeSummaryHatch({
        status: "configured",
        hatchId: "hatch-1",
        service: { name: "Preview", port: 4173 },
        desiredStatus: "open",
        observedStatus: "running",
        exposure: "closed",
      }),
      {
        configured: true,
        hatchId: "hatch-1",
        serviceName: "Preview",
        desiredStatus: "open",
        observedStatus: "running",
        exposure: "closed",
        available: false,
      },
    );
  });

  it("keeps an unconfigured Hatch absent from the summary", async () => {
    const document = new TestDocument();
    const root = new TestNode("div");
    const view = createSummaryView({
      document: document as never,
      root: root as never,
      baseUrl: "https://scotty.example/",
      fetch: (() => Promise.resolve(response({ status: "not_configured" }))) as never,
    });

    view.render(
      projectionFromSnapshot(
        snapshot([{ id: "update", role: "assistant", content: "No preview configured." }]),
      ),
      sessionId,
    );
    assert.equal(root.children.length, 2);
    assert.equal(root.children[1]?.children.length, 0);
    assert.equal((root.children[1] as TestNode & { hidden: boolean }).hidden, true);
    await flush();
    assert.notInclude(renderedText(root), "Hatch");
    assert.equal((root.children[1] as TestNode & { hidden: boolean }).hidden, true);
    assert.equal(root.children[1]?.attributes.get("role"), "status");
    assert.equal(root.children[1]?.attributes.get("aria-live"), "polite");
    assert.equal(root.children[1]?.attributes.get("aria-atomic"), "true");
    assert.equal(root.children[1]?.attributes.get("aria-busy"), "false");
  });

  it("explains configured Hatch states instead of presenting a dead open link", async () => {
    const document = new TestDocument();
    const root = new TestNode("div");
    const view = createSummaryView({
      document: document as never,
      root: root as never,
      baseUrl: "https://scotty.example/",
      fetch: (() =>
        Promise.resolve(
          response({
            status: "configured",
            hatchId: "hatch-1",
            service: { name: "Preview", port: 4173 },
            desiredStatus: "open",
            observedStatus: "starting",
            exposure: "closed",
          }),
        )) as never,
    });

    view.render(
      projectionFromSnapshot(
        snapshot([{ id: "update", role: "assistant", content: "Preview is starting." }]),
      ),
      sessionId,
    );
    await flush();
    assert.include(renderedText(root), "Hatch is starting");
    assert.notInclude(renderedText(root), "Open Hatch");
    assert.notInclude(renderedText(root), "Hatch is closed");
    assert.equal(root.children[1]?.attributes.get("role"), "status");
    assert.equal(root.children[1]?.attributes.get("aria-busy"), "false");
  });

  it("replaces a cached ready Hatch link when the next refresh rejects", async () => {
    const document = new TestDocument();
    const root = new TestNode("div");
    let hatchRequests = 0;
    const fetch = (input: string) => {
      assert.include(input, "/hatch");
      hatchRequests += 1;
      if (hatchRequests > 1) return Promise.reject(new Error("Hatch status unavailable"));
      return Promise.resolve(
        response({
          status: "configured",
          hatchId: "hatch-1",
          service: { name: "Preview", port: 4173 },
          desiredStatus: "open",
          observedStatus: "running",
          exposure: "active",
        }),
      );
    };
    const view = createSummaryView({
      document: document as never,
      root: root as never,
      baseUrl: "https://scotty.example/",
      fetch: fetch as never,
    });

    view.render(
      projectionFromSnapshot(
        snapshot([{ id: "ready", role: "assistant", content: "Preview is ready." }]),
      ),
      sessionId,
    );
    await flush();
    assert.include(renderedText(root), "Open Hatch");

    view.render(
      projectionFromSnapshot(
        snapshot([{ id: "refresh", role: "assistant", content: "Checking preview again." }]),
      ),
      sessionId,
    );
    assert.include(renderedText(root), "Open Hatch");
    assert.equal(root.children[1]?.attributes.get("aria-busy"), "true");
    await flush();

    assert.notInclude(renderedText(root), "Open Hatch");
    assert.include(renderedText(root), "Hatch status could not be loaded");
    assert.equal(root.children[1]?.attributes.get("aria-busy"), "false");
  });

  it("fences stale fetches and constructs only authenticated same-origin routes", () => {
    assert.include(summarySource, "generation !== currentGeneration");
    assert.include(summarySource, 'credentials: "same-origin"');
    assert.include(summarySource, 'cache: "no-store"');
    assert.include(summarySource, "/api/sessions/");
    assert.include(summarySource, 'hatchTarget.dataset.currentHatch = ""');
    assert.include(summarySource, "public HTTPS ready");
    assert.include(summarySource, "public HTTPS unavailable");
    assert.include(summarySource, "/hatch/open");
    assert.include(summarySource, "/video.webm");
    assert.include(summarySource, "Watch browser recording");
    assert.include(summarySource, "Open full evidence");
    assert.notInclude(summarySource, "localStorage");
    assert.notInclude(summarySource, "innerHTML");
  });

  it("deduplicates and caches successfully decoded Evidence by session and job", async () => {
    const pending = deferred<ReturnType<typeof evidencePayload> | undefined>();
    let requests = 0;
    const loader = createEvidenceLoader(async () => {
      requests += 1;
      return pending.promise;
    });

    const first = loader.load(sessionId, "job-1");
    const duplicate = loader.load(sessionId, "job-1");
    assert.strictEqual(first, duplicate);
    await flush();
    assert.strictEqual(requests, 1);
    pending.resolve(evidencePayload("job-1"));
    const verified = await first;
    assert.strictEqual(loader.current(sessionId, "job-1"), verified);
    assert.strictEqual(await loader.load(sessionId, "job-1"), verified);
    assert.strictEqual(requests, 1);
  });

  it("does not cache a late Evidence result after reset", async () => {
    const requests: Array<ReturnType<typeof deferred<ReturnType<typeof evidencePayload>>>> = [];
    const loader = createEvidenceLoader(() => {
      const request = deferred<ReturnType<typeof evidencePayload>>();
      requests.push(request);
      return request.promise;
    });

    const stale = loader.load(sessionId, "job-1");
    await flush();
    loader.reset();
    const current = loader.load(sessionId, "job-1");
    await flush();
    requests[0]?.resolve(evidencePayload("job-1"));
    await stale;
    assert.isUndefined(loader.current(sessionId, "job-1"));
    requests[1]?.resolve(evidencePayload("job-1"));
    assert.deepStrictEqual(await current, evidencePayload("job-1"));
    assert.isDefined(loader.current(sessionId, "job-1"));
  });

  it("keeps verified Evidence mounted through frequent sequence-only renders", async () => {
    const document = new TestDocument();
    const root = new TestNode("div");
    const evidenceRequests: string[] = [];
    const fetch = (input: string) => {
      if (input.endsWith("/hatch")) return Promise.resolve(response({ status: "not_configured" }));
      evidenceRequests.push(input);
      return Promise.resolve(response(evidencePayload("job-1")));
    };
    const view = createSummaryView({
      document: document as never,
      root: root as never,
      baseUrl: "https://scotty.example/",
      fetch: fetch as never,
    });
    const projection = projectionFromSnapshot(snapshot(summaryMessages("job-1")));

    view.render(projection, sessionId);
    await flush();
    const verified = nodeForReference(root, "scotty-evidence:job-1");
    assert.include(renderedText(verified), "Verified run");

    for (let sequence = 1; sequence <= 20; sequence += 1) {
      projection.sequence = sequence;
      view.render(projection, sessionId);
    }

    const stable = nodeForReference(root, "scotty-evidence:job-1");
    assert.strictEqual(stable, verified);
    assert.notInclude(renderedText(stable), "Loading…");
    assert.lengthOf(evidenceRequests, 1);
    const changedMessages = summaryMessages("job-1");
    changedMessages[changedMessages.length - 1] = {
      id: "summary-updated",
      role: "assistant",
      content: "Still verified. scotty-evidence:job-1",
    };
    view.render(projectionFromSnapshot(snapshot(changedMessages)), sessionId);
    const rerendered = nodeForReference(root, "scotty-evidence:job-1");
    assert.include(renderedText(rerendered), "Verified run");
    assert.notInclude(renderedText(rerendered), "Loading…");
    assert.lengthOf(evidenceRequests, 1);
  });

  it("fences late Evidence across session switches and keeps distinct refs independent", async () => {
    const document = new TestDocument();
    const root = new TestNode("div");
    const oldEvidence = deferred<TestResponse>();
    const firstEvidence = deferred<TestResponse>();
    const requests: string[] = [];
    const fetch = (input: string) => {
      if (input.endsWith("/hatch")) return Promise.resolve(response({ status: "not_configured" }));
      requests.push(input);
      if (input.includes("old-job")) return oldEvidence.promise;
      if (input.includes("job-1")) return firstEvidence.promise;
      return Promise.resolve(response(evidencePayload("job-2")));
    };
    const view = createSummaryView({
      document: document as never,
      root: root as never,
      baseUrl: "https://scotty.example/",
      fetch: fetch as never,
    });

    view.render(projectionFromSnapshot(snapshot(summaryMessages("old-job"))), sessionId);
    const nextSessionId = "f0e1d2c3b4a5";
    const nextMessages = summaryMessagesForSession(nextSessionId, "job-1", "job-2");
    view.render(projectionFromSnapshot(snapshot(nextMessages)), nextSessionId);
    await flush();

    assert.include(renderedText(nodeForReference(root, "scotty-evidence:job-1")), "Loading…");
    assert.include(renderedText(nodeForReference(root, "scotty-evidence:job-2")), "Verified run");
    oldEvidence.resolve(response(evidencePayload("old-job")));
    await flush();
    assert.notInclude(renderedText(root), "old-job browser evidence");

    firstEvidence.resolve(response(evidencePayload("job-1")));
    await flush();
    assert.include(renderedText(nodeForReference(root, "scotty-evidence:job-1")), "Verified run");
    assert.lengthOf(requests, 3);
  });

  it("keeps the last verified Hatch state visible while refreshing", async () => {
    const pending: Array<(value: { status: string }) => void> = [];
    const loader = createHatchStatusLoader(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );

    const first = loader.refresh(sessionId);
    const duplicate = loader.refresh(sessionId);
    assert.strictEqual(first, duplicate);
    await Promise.resolve();
    assert.lengthOf(pending, 1);
    pending[0]?.({ status: "not_configured" });
    await first;
    assert.deepStrictEqual(loader.current(sessionId), { status: "not_configured" });

    const refreshing = loader.refresh(sessionId);
    assert.deepStrictEqual(loader.current(sessionId), { status: "not_configured" });
    await Promise.resolve();
    assert.lengthOf(pending, 2);
    pending[1]?.({ status: "configured" });
    await refreshing;
    assert.deepStrictEqual(loader.current(sessionId), { status: "configured" });
  });

  it("clears a cached Hatch state when a later refresh is rejected", async () => {
    let requests = 0;
    const loader = createHatchStatusLoader(async () => {
      requests += 1;
      if (requests === 1) return { status: "configured", available: true };
      throw new Error("refresh failed");
    });

    await loader.refresh(sessionId);
    assert.deepStrictEqual(loader.current(sessionId), { status: "configured", available: true });

    let rejected = false;
    try {
      await loader.refresh(sessionId);
    } catch {
      rejected = true;
    }
    assert.isTrue(rejected);
    assert.isUndefined(loader.current(sessionId));
  });

  it("does not let an old session Hatch response replace the current session", async () => {
    const pending = new Map<string, Array<(value: { status: string }) => void>>();
    const loader = createHatchStatusLoader(
      (id) =>
        new Promise((resolve) => {
          pending.set(id, [...(pending.get(id) ?? []), resolve]);
        }),
    );
    const oldRefresh = loader.refresh("old-session");
    await Promise.resolve();
    const currentRefresh = loader.refresh("current-session");
    await Promise.resolve();
    pending.get("old-session")?.[0]?.({ status: "configured" });
    await oldRefresh;
    assert.isUndefined(loader.current("current-session"));
    pending.get("current-session")?.[0]?.({ status: "not_configured" });
    await currentRefresh;
    assert.deepStrictEqual(loader.current("current-session"), { status: "not_configured" });
  });

  it("fences an old request when navigation returns to the same session", async () => {
    const pending = new Map<string, Array<(value: { status: string }) => void>>();
    const loader = createHatchStatusLoader(
      (id) =>
        new Promise((resolve) => {
          pending.set(id, [...(pending.get(id) ?? []), resolve]);
        }),
    );
    const firstA = loader.refresh("session-a");
    await Promise.resolve();
    const requestB = loader.refresh("session-b");
    await Promise.resolve();
    const secondA = loader.refresh("session-a");
    await Promise.resolve();

    pending.get("session-a")?.[0]?.({ status: "configured" });
    await firstA;
    assert.isUndefined(loader.current("session-a"));

    pending.get("session-a")?.[1]?.({ status: "not_configured" });
    await secondA;
    assert.deepStrictEqual(loader.current("session-a"), { status: "not_configured" });
    pending.get("session-b")?.[0]?.({ status: "configured" });
    await requestB;
  });
});
