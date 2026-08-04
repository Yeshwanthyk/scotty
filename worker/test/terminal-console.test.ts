import { assert, describe, it, vi } from "vitest";
import {
  consoleUrl,
  createConsoleClient,
  type ConsoleCommandEnvelope,
} from "../public/terminal-console-client.js";
import { createCommandLane } from "../public/terminal-command-lane.js";
import { commandIntentDigest } from "../public/terminal-console-protocol.js";
import { commandIntentDigest as serverCommandIntentDigest } from "../../protocol/pi-console-shared.mjs";

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
  readable: true,
  body: {
    version: 1,
    epoch: envelope.epoch,
    commandId: envelope.commandId,
    commandDigest,
    status: "accepted",
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
      lane.state().items.map((item: { label: string; state: string }) => [item.label, item.state]),
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
    assert.deepStrictEqual(lane.state().items, []);
  });

  it("pauses on stale authority and never replays or advances queued intent", async () => {
    const sends: ConsoleCommandEnvelope[] = [];
    let idIndex = 0;
    const lane = createCommandLane({
      send: async (_sessionId, envelope) => {
        sends.push(envelope);
        return {
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
        };
      },
      randomUUID: () => ids[idIndex++] ?? ids[1],
    });
    const authority = { sessionId: "session-a", epoch: "epoch-1", expectedSessionRevision: 7 };
    const stale = lane.enqueue({
      ...authority,
      intent: { type: "prompt", message: "stale" },
      label: "stale",
    });
    lane.enqueue({
      ...authority,
      intent: { type: "prompt", message: "must not replay" },
      label: "must not replay",
    });

    assert.strictEqual((await stale.outcome).status, "stale");
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(lane.state().paused, "stale");
    assert.deepStrictEqual(
      lane.state().items.map((item: { label: string; state: string }) => [item.label, item.state]),
      [
        ["stale", "stale"],
        ["must not replay", "paused"],
      ],
    );
    await Promise.resolve();
    assert.strictEqual(sends.length, 1);
    assert.throws(
      () =>
        lane.enqueue({
          ...authority,
          intent: { type: "abort" },
          label: "new intent",
        }),
      /Command lane is paused/u,
    );
  });

  it("holds an ambiguous command and stops the lane", async () => {
    const lane = createCommandLane({
      send: async () => {
        throw new TypeError("network interrupted");
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

    const outcome = await command.outcome;
    assert.deepInclude(outcome, { status: "ambiguous", message: "network interrupted" });
    assert.strictEqual(lane.state().paused, "ambiguous");
    assert.deepInclude(lane.state().items[0], { label: "Stop Pi", state: "ambiguous" });
  });
});
