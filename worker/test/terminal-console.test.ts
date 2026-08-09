import { assert, describe, it, vi } from "vitest";
import {
  consoleUrl,
  createConsoleClient,
  type ConsoleCommandEnvelope,
  type ConsoleCommandTransportResult,
} from "../public/terminal-console-client.js";
import { createCommandLane } from "../public/terminal-command-lane.js";
import { createComposerDrafts } from "../public/terminal-draft.js";
import { commandIntentDigest } from "../public/terminal-console-protocol.js";
import { commandIntentDigest as serverCommandIntentDigest } from "../../protocol/pi-console-shared.mjs";
import terminalHtml from "../public/terminal.html?raw";
import terminalSource from "../public/terminal.js?raw";

const ids = ["123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-a456-426614174001"];

const deferred = <A>() => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const accepted = (envelope: ConsoleCommandEnvelope, commandDigest: string) => ({
  ok: true,
  status: 202,
  readable: true as const,
  body: {
    version: 1,
    epoch: envelope.epoch,
    commandId: envelope.commandId,
    commandDigest,
    status: "accepted" as const,
    response: { success: true },
  },
});

describe("browser console client", () => {
  it("computes the same canonical intent digest as the server protocol", async () => {
    const intent = {
      type: "prompt",
      streamingBehavior: "followUp",
      message: "ship it",
    };
    assert.strictEqual(await commandIntentDigest(intent), await serverCommandIntentDigest(intent));
  });

  it("uses only console/v1 URLs and sends the stable modern envelope", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let eventUrl: URL | undefined;
    const client = createConsoleClient({
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return Response.json({ version: 1, epoch: "epoch-1", sessionRevision: 7 });
      },
      eventSource: (url: URL) => {
        eventUrl = url;
        return { close() {} };
      },
      origin: "https://scotty.example",
    });
    const envelope: ConsoleCommandEnvelope = {
      version: 1,
      epoch: "epoch-1",
      commandId: ids[0],
      expectedSessionRevision: 7,
      intent: { type: "prompt", message: "ship it" },
    };

    await client.snapshot("session/a", undefined);
    client.events("session/a", { epoch: "epoch-1", sequence: 12 });
    await client.command("session/a", envelope);

    assert.strictEqual(consoleUrl("session/a", "snapshot"), "/s/session%2Fa/console/v1/snapshot");
    assert.strictEqual(requests[0]?.url, "/s/session%2Fa/console/v1/snapshot");
    assert.strictEqual(eventUrl?.pathname, "/s/session%2Fa/console/v1/events");
    assert.strictEqual(eventUrl?.search, "?epoch=epoch-1&since=12");
    assert.strictEqual(requests[1]?.url, "/s/session%2Fa/console/v1/command");
    assert.deepStrictEqual(JSON.parse(String(requests[1]?.init?.body)), envelope);
    assert.isFalse(requests.some(({ url }) => url.includes("/rpc/")));
  });
});

describe("browser command lane", () => {
  it("serializes a rapid second command without losing either intent", async () => {
    const firstResponse = deferred<ReturnType<typeof accepted>>();
    const sends: ConsoleCommandEnvelope[] = [];
    let idIndex = 0;
    const lane = createCommandLane({
      send: async (_sessionId, envelope) => {
        sends.push(envelope);
        return sends.length === 1
          ? firstResponse.promise
          : accepted(envelope, await commandIntentDigest(envelope.intent));
      },
      randomUUID: () => ids[idIndex++] ?? ids[1],
    });
    const authority = { sessionId: "session-a", epoch: "epoch-1", expectedSessionRevision: 7 };
    const first = lane.enqueue({
      ...authority,
      intent: { type: "prompt", message: "first" },
      label: "first",
    });
    const second = lane.enqueue({
      ...authority,
      intent: { type: "prompt", message: "second" },
      label: "second",
    });

    await vi.waitFor(() => assert.strictEqual(sends.length, 1));
    assert.deepInclude(sends[0], {
      version: 1,
      epoch: "epoch-1",
      commandId: ids[0],
      expectedSessionRevision: 7,
      intent: { type: "prompt", message: "first" },
    });
    assert.deepStrictEqual(
      lane
        .state("session-a")
        .items.map((item: { label: string; state: string }) => [item.label, item.state]),
      [
        ["first", "sending"],
        ["second", "queued"],
      ],
    );

    firstResponse.resolve(accepted(sends[0], await commandIntentDigest(sends[0].intent)));
    assert.strictEqual((await first.outcome).status, "accepted");
    assert.strictEqual((await second.outcome).status, "accepted");
    assert.strictEqual(sends.length, 2);
    assert.deepInclude(sends[1], {
      version: 1,
      commandId: ids[1],
      intent: { type: "prompt", message: "second" },
    });
    assert.deepStrictEqual(lane.state("session-a").items, []);
  });

  it("isolates stale authority by session and discards held intent without replay", async () => {
    const staleResponse = deferred<ConsoleCommandTransportResult>();
    const sends: Array<{ sessionId: string; envelope: ConsoleCommandEnvelope }> = [];
    let idIndex = 0;
    const lane = createCommandLane({
      send: async (sessionId, envelope) => {
        sends.push({ sessionId, envelope });
        if (
          sessionId === "session-a" &&
          envelope.intent.type === "prompt" &&
          envelope.intent.message === "stale"
        )
          return staleResponse.promise;
        return accepted(envelope, await commandIntentDigest(envelope.intent));
      },
      randomUUID: () => ids[idIndex++] ?? ids[1],
    });
    const authorityA = { sessionId: "session-a", epoch: "epoch-a", expectedSessionRevision: 7 };
    const stale = lane.enqueue({
      ...authorityA,
      intent: { type: "prompt", message: "stale" },
      label: "stale",
    });
    const held = lane.enqueue({
      ...authorityA,
      intent: { type: "prompt", message: "must not replay" },
      label: "must not replay",
    });
    staleResponse.resolve({
      ok: false,
      status: 409,
      readable: true,
      body: {
        version: 1,
        status: "stale",
        expectedSessionRevision: 7,
        sessionRevision: 8,
        retryable: false,
      },
    });

    assert.strictEqual((await stale.outcome).status, "stale");
    const otherSession = lane.enqueue({
      sessionId: "session-b",
      epoch: "epoch-b",
      expectedSessionRevision: 3,
      intent: { type: "prompt", message: "session B continues" },
      label: "session B continues",
    });
    assert.strictEqual((await otherSession.outcome).status, "accepted");
    assert.strictEqual(sends.length, 2);
    assert.strictEqual(lane.state("session-a").paused, "stale");
    assert.isUndefined(lane.state("session-b").paused);
    assert.deepStrictEqual(
      lane
        .state("session-a")
        .items.map((item: { label: string; state: string }) => [item.label, item.state]),
      [
        ["stale", "stale"],
        ["must not replay", "paused"],
      ],
    );
    assert.throws(
      () =>
        lane.enqueue({
          ...authorityA,
          intent: { type: "abort" },
          label: "new intent",
        }),
      /session is paused/u,
    );

    lane.discard("session-a");
    assert.deepInclude(await held.outcome, {
      status: "discarded",
      accepted: false,
      message: "Command discarded without being sent",
    });
    assert.deepStrictEqual(lane.state("session-a"), { paused: undefined, items: [] });

    const fresh = lane.enqueue({
      sessionId: "session-a",
      epoch: "epoch-a-refreshed",
      expectedSessionRevision: 8,
      intent: { type: "prompt", message: "fresh command" },
      label: "fresh command",
    });
    assert.strictEqual((await fresh.outcome).status, "accepted");
    assert.deepStrictEqual(
      sends.map(({ sessionId, envelope }) => [
        sessionId,
        envelope.intent.type === "prompt" ? envelope.intent.message : envelope.intent.type,
      ]),
      [
        ["session-a", "stale"],
        ["session-b", "session B continues"],
        ["session-a", "fresh command"],
      ],
    );
  });

  it("restores every unsent prompt as a draft without replaying held intent", async () => {
    const staleResponse = deferred<ConsoleCommandTransportResult>();
    const sends: ConsoleCommandEnvelope[] = [];
    const entry = { draft: "" };
    const drafts = createComposerDrafts(() => entry);
    let idIndex = 0;
    const lane = createCommandLane({
      send: async (_sessionId, envelope) => {
        sends.push(envelope);
        return staleResponse.promise;
      },
      randomUUID: () => ids[idIndex++] ?? ids[1],
    });
    const authority = { sessionId: "session-a", epoch: "epoch-a", expectedSessionRevision: 7 };

    drafts.set("session-a", "stale prompt");
    const staleDraft = drafts.begin("session-a", "stale prompt");
    const stale = lane.enqueue({
      ...authority,
      intent: { type: "prompt", message: "stale prompt" },
      label: "stale prompt",
    });
    drafts.set("session-a", "held prompt");
    const heldDraft = drafts.begin("session-a", "held prompt");
    const held = lane.enqueue({
      ...authority,
      intent: { type: "prompt", message: "held prompt" },
      label: "held prompt",
    });

    staleResponse.resolve({
      ok: false,
      status: 409,
      readable: true,
      body: {
        version: 1,
        status: "stale",
        expectedSessionRevision: 7,
        sessionRevision: 8,
        retryable: false,
      },
    });
    assert.isTrue(drafts.settle(staleDraft, (await stale.outcome).status));
    lane.discard("session-a");
    assert.isTrue(drafts.settle(heldDraft, (await held.outcome).status));

    assert.strictEqual(entry.draft, "stale prompt\n\nheld prompt");
    assert.deepStrictEqual(
      sends.map((envelope) =>
        envelope.intent.type === "prompt" ? envelope.intent.message : envelope.intent.type,
      ),
      ["stale prompt"],
    );
  });

  it("isolates ambiguous authority and settles its held queue on discard", async () => {
    const sends: Array<{ sessionId: string; label: unknown }> = [];
    const lane = createCommandLane({
      send: async (sessionId, envelope) => {
        sends.push({
          sessionId,
          label: envelope.intent.type === "prompt" ? envelope.intent.message : envelope.intent.type,
        });
        if (sessionId === "session-a") throw new TypeError("network interrupted");
        return accepted(envelope, await commandIntentDigest(envelope.intent));
      },
      randomUUID: () => ids[0],
    });
    const command = lane.enqueue({
      sessionId: "session-a",
      epoch: "epoch-1",
      expectedSessionRevision: 7,
      intent: { type: "abort" },
      label: "Stop Pi",
    });
    const held = lane.enqueue({
      sessionId: "session-a",
      epoch: "epoch-1",
      expectedSessionRevision: 7,
      intent: { type: "prompt", message: "held text" },
      label: "held text",
    });
    const outcome = await command.outcome;
    assert.deepInclude(outcome, { status: "ambiguous", message: "network interrupted" });
    const otherSession = lane.enqueue({
      sessionId: "session-b",
      epoch: "epoch-2",
      expectedSessionRevision: 2,
      intent: { type: "prompt", message: "B still sends" },
      label: "B still sends",
    });
    assert.strictEqual((await otherSession.outcome).status, "accepted");
    assert.strictEqual(lane.state("session-a").paused, "ambiguous");
    assert.deepInclude(lane.state("session-a").items[0], {
      label: "Stop Pi",
      state: "ambiguous",
    });
    assert.deepInclude(lane.state("session-a").items[1], {
      label: "held text",
      state: "paused",
    });

    lane.discard("session-a");
    assert.deepInclude(await held.outcome, { status: "discarded", accepted: false });
    assert.deepStrictEqual(sends, [
      { sessionId: "session-a", label: "abort" },
      { sessionId: "session-b", label: "B still sends" },
    ]);
  });

  it("exposes an accessible recovery control scoped to the current session", () => {
    assert.match(
      terminalHtml,
      /id="command-recovery"[\s\S]*?role="alert"[\s\S]*?id="discard-held-commands"[\s\S]*?>\s*Discard held commands\s*</u,
    );
    assert.include(terminalSource, "commandLane.state(currentSessionId)");
    assert.include(terminalSource, "commandLane.discard(sessionId)");
    assert.include(terminalSource, "await loadSnapshot(sessionId)");
    assert.include(terminalSource, "composerDrafts.begin(submission.sessionId, editableDraft)");
    assert.include(terminalSource, "composerDrafts.settle(draftSubmission, outcome.status)");
    assert.include(terminalSource, "submission.sessionId === currentSessionId");
  });
});
