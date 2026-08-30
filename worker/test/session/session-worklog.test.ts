import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER,
  PiConsoleStaleCommandSchema,
} from "../../../protocol/pi-console";
import { PI_SESSION_PORT, PI_SESSION_TOKEN_HEADER } from "../../src/sandbox/auth";
import { createSessionHarness, SESSION_ID, sessionHarnessKeys } from "../support/session-harness";
import { SESSION_CONTROL_REVISION_KEY } from "../../src/session/store";
import { makeSessionRecord } from "../support";

const decodeStaleCommand = Schema.decodeUnknownPromise(PiConsoleStaleCommandSchema);

const relaySnapshot = () => ({
  epoch: "epoch-1",
  baseSequence: 0,
  sequence: 0,
  state: { isStreaming: false },
  messages: [],
  overlapEvents: [],
  activeTools: [],
  queue: { steer: [], followUp: [] },
  pendingUi: [],
  pendingUiAuthority: {
    status: "partial" as const,
    reason: "pi_0_83_signal_cancellation_unobservable" as const,
  },
  extensionSurface: { statuses: {}, widgets: [] },
  capabilities: { models: [], thinkingLevels: [], commands: [] },
  truncated: { messages: false, values: false },
});

const deferred = <A>() => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const consoleCommand = (expectedSessionRevision: number) => ({
  epoch: "epoch-1",
  commandId: "123e4567-e89b-42d3-a456-426614174000",
  expectedSessionRevision,
  intent: { type: "abort" as const },
});

describe("Sandbox Pi worklog HTTP boundary", () => {
  it("fails a stopped container closed without touching start-capable provider runtime", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
        }),
      },
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/snapshot"),
    );

    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(await response.json(), {
      status: "unavailable",
      reason: "provider_passive_relay_unavailable",
      retryable: false,
    });
    assert.deepStrictEqual(harness.piRequests, []);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:container:")));
    assert.deepStrictEqual(harness.rawPiRequests, []);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:pi:")));
  });

  it("maps a raw transport race to typed unavailable without retry or lifecycle mutation", async () => {
    const record = makeSessionRecord({ id: SESSION_ID, status: "warm" });
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: record,
      },
      rawPiContainerRunning: true,
      rawPiFetch: async () => {
        throw new TypeError("container stopped during raw fetch");
      },
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/snapshot"),
    );

    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(await response.json(), {
      status: "unavailable",
      reason: "provider_passive_relay_unavailable",
      retryable: false,
    });
    assert.strictEqual(harness.rawPiRequests.length, 1);
    assert.deepStrictEqual(harness.piRequests, []);
    assert.deepStrictEqual(harness.readRecord(), record);
    assert.strictEqual(harness.read<number>(SESSION_CONTROL_REVISION_KEY), undefined);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:pi:start:")));
    assert.isFalse(harness.events.some((event) => event.startsWith("host:container:")));
  });

  it("maps an absent supervisor to typed unavailable without SDK containerFetch", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID, status: "warm" }),
      },
      rawPiContainerRunning: true,
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/events"),
    );

    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(await response.json(), {
      status: "unavailable",
      reason: "provider_passive_relay_unavailable",
      retryable: false,
    });
    assert.strictEqual(harness.rawPiRequests.length, 1);
    assert.deepStrictEqual(harness.piRequests, []);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:pi:start:")));
    assert.isFalse(harness.events.some((event) => event.startsWith("host:container:")));
    assert.strictEqual(harness.read<number>(SESSION_CONTROL_REVISION_KEY), undefined);
  });

  it("relays a native snapshot over one raw TCP fetch with isolated headers and token", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID, status: "warm" }),
      },
      rawPiContainerRunning: true,
      rawPiFetch: async () =>
        Response.json(relaySnapshot(), {
          headers: { [PI_SESSION_TOKEN_HEADER]: "must-not-return" },
        }),
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/snapshot?since=7", {
        headers: {
          accept: "application/json",
          authorization: "must-not-forward",
          "content-type": "x".repeat(8 * 1024 + 1),
          cookie: "must-not-forward",
          "last-event-id": "event-6",
          [PI_SESSION_TOKEN_HEADER]: "attacker-token",
          [PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER]: "public-marker",
          "x-scotty-root": "must-not-forward",
        },
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get(PI_SESSION_TOKEN_HEADER), null);
    assert.deepStrictEqual(await response.json(), { ...relaySnapshot(), sessionRevision: 0 });
    assert.strictEqual(harness.rawPiRequests.length, 1);
    const forwarded = harness.rawPiRequests[0];
    assert.strictEqual(new URL(forwarded.url).origin, `http://127.0.0.1:${PI_SESSION_PORT}`);
    assert.strictEqual(new URL(forwarded.url).pathname, "/snapshot");
    assert.strictEqual(new URL(forwarded.url).search, "?since=7");
    assert.strictEqual(forwarded.headers.get("accept"), "application/json");
    assert.strictEqual(forwarded.headers.get("content-type"), null);
    assert.strictEqual(forwarded.headers.get("last-event-id"), "event-6");
    assert.strictEqual(forwarded.headers.get("authorization"), null);
    assert.strictEqual(forwarded.headers.get("cookie"), null);
    assert.strictEqual(forwarded.headers.get("x-scotty-root"), null);
    assert.strictEqual(forwarded.headers.get(PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER), "1");
    assert.notStrictEqual(forwarded.headers.get(PI_SESSION_TOKEN_HEADER), "attacker-token");
    assert.ok((forwarded.headers.get(PI_SESSION_TOKEN_HEADER)?.length ?? 0) >= 32);
    assert.deepStrictEqual(harness.piRequests, []);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:container:")));
  });

  it("propagates native event stream cancellation and Last-Event-ID without renewal", async () => {
    let streamCancelled = false;
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID, status: "warm" }),
      },
      rawPiContainerRunning: true,
      rawPiFetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: one\n\n"));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/events?epoch=epoch-1&since=4", {
        headers: { "last-event-id": "event-4" },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.isFalse((await reader.read()).done);
    await reader.cancel();

    assert.isTrue(streamCancelled);
    assert.strictEqual(harness.rawPiRequests.length, 1);
    assert.strictEqual(new URL(harness.rawPiRequests[0].url).pathname, "/events");
    assert.strictEqual(new URL(harness.rawPiRequests[0].url).search, "?epoch=epoch-1&since=4");
    assert.strictEqual(harness.rawPiRequests[0].headers.get("last-event-id"), "event-4");
    assert.strictEqual(
      harness.rawPiRequests[0].headers.get(PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER),
      "1",
    );
    assert.deepStrictEqual(harness.piRequests, []);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:container:")));
  });

  it("fails closed when the authoritative control revision is malformed", async () => {
    let relayCalls = 0;
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord(),
        [SESSION_CONTROL_REVISION_KEY]: "invalid",
      },
      passivePiConsoleRelay: {
        fetch: async () => {
          relayCalls += 1;
          return Response.json({ unexpected: true });
        },
      },
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/snapshot"),
    );

    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(await response.json(), {
      status: "unavailable",
      reason: "session_authority_unavailable",
      retryable: false,
    });
    assert.strictEqual(relayCalls, 0);
  });

  it("preserves injected passive relay substitution without using the raw container", async () => {
    const relayRequests: Request[] = [];
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
        }),
      },
      passivePiConsoleRelay: {
        fetch: async ({ sessionId, request }) => {
          assert.strictEqual(sessionId, SESSION_ID);
          relayRequests.push(request.clone());
          return Response.json(relaySnapshot());
        },
      },
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/snapshot?since=7"),
    );

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      ...relaySnapshot(),
      sessionRevision: 0,
    });
    assert.strictEqual(relayRequests.length, 1);
    assert.strictEqual(new URL(relayRequests[0].url).search, "?since=7");
    assert.strictEqual(relayRequests[0].headers.get(PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER), null);
    assert.deepStrictEqual(harness.piRequests, []);
    assert.deepStrictEqual(harness.rawPiRequests, []);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:pi:")));
  });

  it("relays a current native command over the raw TCP transport", async () => {
    const command = {
      ...consoleCommand(0),
      intent: {
        type: "prompt" as const,
        message: "inspect",
        images: [{ type: "image" as const, data: "AA==", mimeType: "image/png" as const }],
      },
    };
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID, status: "warm" }),
      },
      rawPiContainerRunning: true,
      rawPiFetch: async () => Response.json({ accepted: true }, { status: 202 }),
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/command?source=fleet", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: "must-not-forward",
        },
        body: JSON.stringify(command),
      }),
    );

    assert.strictEqual(response.status, 202);
    assert.strictEqual(harness.rawPiRequests.length, 1);
    const forwarded = harness.rawPiRequests[0];
    assert.strictEqual(new URL(forwarded.url).pathname, "/command");
    assert.strictEqual(new URL(forwarded.url).search, "?source=fleet");
    assert.strictEqual(forwarded.headers.get("content-type"), "application/json");
    assert.strictEqual(forwarded.headers.get("authorization"), null);
    assert.deepStrictEqual(await forwarded.json(), command);
    assert.deepStrictEqual(harness.piRequests, []);
  });

  it("forwards a decoded command only when its selected-session revision is current", async () => {
    const relayRequests: Request[] = [];
    const harness = await createSessionHarness({
      initialEntries: { [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }) },
      passivePiConsoleRelay: {
        fetch: async ({ request }) => {
          relayRequests.push(request.clone());
          return Response.json({ accepted: true }, { status: 202 });
        },
      },
    });
    const command = consoleCommand(0);

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    );

    assert.strictEqual(response.status, 202);
    assert.strictEqual(relayRequests.length, 1);
    assert.deepStrictEqual(await relayRequests[0].json(), command);
    assert.deepStrictEqual(harness.piRequests, []);
  });

  it("atomically rejects commands after a lifecycle revision changes", async () => {
    const relayRequests: Request[] = [];
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }),
      },
      passivePiConsoleRelay: {
        fetch: async ({ request }) => {
          relayRequests.push(request.clone());
          return Response.json({ accepted: true }, { status: 202 });
        },
      },
    });

    await harness.sandbox.snapshotScottySession();
    const piRequestCount = harness.piRequests.length;
    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(consoleCommand(0)),
      }),
    );

    assert.strictEqual(response.status, 409);
    const stale = await decodeStaleCommand(await response.json());
    assert.deepInclude(stale, {
      status: "stale",
      expectedSessionRevision: 0,
      retryable: false,
    });
    assert.isAbove(stale.sessionRevision, 0);
    assert.strictEqual(relayRequests.length, 0);
    assert.strictEqual(harness.piRequests.length, piRequestCount);
  });

  it("serializes command relay acceptance atomically against lifecycle acquisition", async () => {
    const relayEntered = deferred<void>();
    const relayResponse = deferred<Response>();
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }),
      },
      passivePiConsoleRelay: {
        fetch: async () => {
          relayEntered.resolve();
          return relayResponse.promise;
        },
      },
    });

    const commandPromise = harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(consoleCommand(0)),
      }),
    );
    await relayEntered.promise;

    let lifecycleSettled = false;
    const lifecyclePromise = harness.sandbox.snapshotScottySession().then((result) => {
      lifecycleSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.isFalse(lifecycleSettled);
    assert.strictEqual(harness.readRecord()?.operation, null);
    assert.strictEqual(harness.read<number>(SESSION_CONTROL_REVISION_KEY), undefined);
    assert.deepStrictEqual(harness.piRequests, []);

    relayResponse.resolve(Response.json({ accepted: true }, { status: 202 }));
    assert.strictEqual((await commandPromise).status, 202);
    await lifecyclePromise;
    assert.isTrue(lifecycleSettled);
    assert.isAbove(harness.read<number>(SESSION_CONTROL_REVISION_KEY) ?? 0, 0);
  });

  it("bounds and decodes commands before reading authority or invoking the relay", async () => {
    let relayCalls = 0;
    const harness = await createSessionHarness({
      initialEntries: { [sessionHarnessKeys.record]: makeSessionRecord() },
      passivePiConsoleRelay: {
        fetch: async () => {
          relayCalls += 1;
          return Response.json({ unexpected: true });
        },
      },
    });
    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...consoleCommand(0), unexpected: true }),
      }),
    );

    assert.strictEqual(response.status, 400);

    const oversized = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-console/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(PI_CONSOLE_MAX_COMMAND_BYTES + 1),
      }),
    );
    assert.strictEqual(oversized.status, 413);
    assert.strictEqual(relayCalls, 0);
  });

  it("reports typed passive-console authority conflicts without invoking the relay", async () => {
    const records = [
      {
        record: makeSessionRecord({ status: "sleeping" }),
        reason: "session_not_warm",
      },
      {
        record: makeSessionRecord({
          operation: {
            kind: "snapshot",
            nonce: "operation-1",
            startedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
        reason: "session_operation_active",
      },
      {
        record: makeSessionRecord({
          provider: "runner",
          runner: "runner-1",
          execution: { provider: "runner", runner: "runner-1", runtimeId: "runtime-1" },
        }),
        reason: "provider_unsupported",
      },
    ] as const;

    for (const { record, reason } of records) {
      let relayCalls = 0;
      const harness = await createSessionHarness({
        initialEntries: { [sessionHarnessKeys.record]: record },
        passivePiConsoleRelay: {
          fetch: async () => {
            relayCalls += 1;
            return Response.json({ unexpected: true });
          },
        },
      });

      const response = await harness.sandbox.fetch(
        new Request("http://scotty.internal/_scotty/pi-console/events"),
      );

      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(await response.json(), {
        status: "unavailable",
        reason,
        retryable: false,
      });
      assert.strictEqual(relayCalls, 0);
      assert.deepStrictEqual(harness.piRequests, []);
    }
  });
});
