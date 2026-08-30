import { assert, describe, expect, it, vi } from "vitest";
import {
  commandIntentDigest,
  consoleUrl,
  createCommandLane,
  createConsoleTransport,
  createPiConnection,
  type CommandEnvelope,
  type CommandTransportResult,
} from "../../../public/session/pi-connection.js";
import { commandIntentDigest as serverCommandIntentDigest } from "../../../../protocol/pi-console-shared.mjs";

const ids = ["123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-a456-426614174001"];
const deferred = <A>() => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((complete) => (resolve = complete));
  return { promise, resolve };
};
const accepted = async (envelope: CommandEnvelope): Promise<CommandTransportResult> => ({
  ok: true,
  status: 202,
  readable: true,
  body: {
    epoch: envelope.epoch,
    commandId: envelope.commandId,
    commandDigest: await commandIntentDigest(envelope.intent),
    status: "accepted",
    response: { success: true },
  },
});

describe("Pi connection", () => {
  it("uses an explicit same-origin mutation to prepare a missing runtime", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = createConsoleTransport({
      fetch,
      eventSource: () => ({ addEventListener() {}, close() {} }),
      origin: "https://scotty.example",
    });

    await transport.prepare("session/a");

    expect(fetch).toHaveBeenCalledWith("/s/session%2Fa/console/prepare", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  });

  it("uses only console URLs and matches the server digest", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let eventUrl: URL | undefined;
    const transport = createConsoleTransport({
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ epoch: "epoch-1", sequence: 12 });
      },
      eventSource: (url) => {
        eventUrl = url;
        return { close() {} } as EventSource;
      },
      origin: "https://scotty.example",
    });
    const envelope: CommandEnvelope = {
      epoch: "epoch-1",
      commandId: ids[0],
      expectedSessionRevision: 7,
      intent: { type: "prompt", message: "Ship it", streamingBehavior: "followUp" },
    };

    await transport.snapshot("session/a");
    transport.events("session/a", { epoch: "epoch-1", sequence: 12 });
    await transport.command("session/a", envelope);

    assert.strictEqual(consoleUrl("session/a", "snapshot"), "/s/session%2Fa/console/snapshot");
    assert.strictEqual(eventUrl?.search, "?epoch=epoch-1&since=12");
    assert.deepStrictEqual(JSON.parse(String(requests[1]?.init?.body)), envelope);
    assert.isFalse(requests.some(({ url }) => url.includes("/rpc/")));
    assert.strictEqual(
      await commandIntentDigest(envelope.intent),
      await serverCommandIntentDigest(envelope.intent),
    );
  });

  it("serializes commands and holds stale authority without replay", async () => {
    const first = deferred<CommandTransportResult>();
    const sends: CommandEnvelope[] = [];
    let id = 0;
    const lane = createCommandLane({
      send: async (_sessionId, envelope) => {
        sends.push(envelope);
        return sends.length === 1 ? first.promise : accepted(envelope);
      },
      randomUUID: () => ids[id++] ?? ids[1],
    });
    const authority = { sessionId: "agent-a", epoch: "epoch-1", expectedSessionRevision: 7 };
    const stale = lane.enqueue({
      ...authority,
      intent: { type: "prompt", message: "first" },
      label: "first",
    });
    const held = lane.enqueue({
      ...authority,
      intent: { type: "prompt", message: "second" },
      label: "second",
    });
    await vi.waitFor(() => assert.strictEqual(sends.length, 1));
    first.resolve({
      ok: false,
      status: 409,
      readable: true,
      body: {
        status: "stale",
        expectedSessionRevision: 7,
        sessionRevision: 8,
        retryable: false,
      },
    });

    assert.strictEqual((await stale.outcome).status, "stale");
    assert.strictEqual(lane.state("agent-a").paused, "stale");
    assert.strictEqual(sends.length, 1);
    lane.discard("agent-a");
    assert.strictEqual((await held.outcome).status, "discarded");
    assert.strictEqual(sends.length, 1);
    assert.isUndefined(lane.state("agent-a").paused);
    const explicitRetry = lane.enqueue({
      ...authority,
      expectedSessionRevision: 8,
      intent: { type: "prompt", message: "first" },
      label: "first",
    });
    assert.strictEqual((await explicitRetry.outcome).status, "accepted");
    assert.strictEqual(sends.length, 2);
    assert.strictEqual(sends[1].expectedSessionRevision, 8);
  });

  it("holds an ambiguous command for explicit recovery without replay", async () => {
    let attempts = 0;
    const lane = createCommandLane({
      send: async (_sessionId, envelope) => {
        attempts += 1;
        if (attempts === 1) throw new Error("response lost");
        return accepted(envelope);
      },
      randomUUID: () => ids[Math.min(attempts, 1)],
    });
    const authority = { sessionId: "agent-a", epoch: "epoch-1", expectedSessionRevision: 7 };
    const uncertain = lane.enqueue({
      ...authority,
      intent: { type: "follow_up", message: "check later" },
      label: "check later",
    });

    assert.strictEqual((await uncertain.outcome).status, "ambiguous");
    assert.strictEqual(lane.state("agent-a").paused, "ambiguous");
    assert.strictEqual(attempts, 1);
    assert.throws(() =>
      lane.enqueue({
        ...authority,
        intent: { type: "follow_up", message: "check later" },
        label: "check later",
      }),
    );
    assert.strictEqual(attempts, 1);

    lane.discard("agent-a");
    const explicitRetry = lane.enqueue({
      ...authority,
      intent: { type: "follow_up", message: "check later" },
      label: "check later",
    });
    assert.strictEqual((await explicitRetry.outcome).status, "accepted");
    assert.strictEqual(attempts, 2);
  });

  it("aborts the old snapshot and closes its stream before switching", async () => {
    const snapshotA = deferred<unknown>();
    const signals: AbortSignal[] = [];
    const closed: string[] = [];
    const source = (name: string) => ({
      addEventListener() {},
      close() {
        closed.push(name);
      },
    });
    const transport = {
      snapshot: async (sessionId: string, signal: AbortSignal) => {
        signals.push(signal);
        return sessionId === "a" ? snapshotA.promise : { epoch: "epoch-b", sequence: 0 };
      },
      prepare: async () => undefined,
      events: (sessionId: string) => source(sessionId),
      command: async (_sessionId: string, envelope: CommandEnvelope) => accepted(envelope),
    };
    const connection = createPiConnection({
      transport,
      randomUUID: () => ids[0],
      onEvent() {},
      onState() {},
      onLaneChange() {},
    });
    const openingA = connection.open("a");
    await vi.waitFor(() => assert.strictEqual(signals.length, 1));
    await connection.open("b");
    assert.isTrue(signals[0].aborted);
    snapshotA.resolve({ epoch: "epoch-a", sequence: 0 });
    assert.isUndefined(await openingA);
    connection.close();
    assert.deepStrictEqual(closed, ["b"]);
  });
});
