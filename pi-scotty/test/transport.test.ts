import { describe, expect, it } from "vitest";
import { commandIntentDigest } from "../../protocol/pi-console-shared.mjs";
import { HttpConsoleTransport, type FetchImplementation } from "../src/transport.ts";
import { SESSION_A, event, session, snapshot } from "./fixtures.ts";

const CREDENTIAL = `scotty_client.0123456789ab.${"x".repeat(32)}`;
const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const command = {
  version: 1 as const,
  epoch: "epoch-1",
  commandId: COMMAND_ID,
  expectedSessionRevision: 7,
  intent: { type: "steer" as const, message: "adjust" },
};
const COMMAND_DIGEST = await commandIntentDigest(command.intent);

const requestUrl = (input: string | URL | Request): URL =>
  new URL(input instanceof Request ? input.url : input.toString());

describe("HttpConsoleTransport", () => {
  it("uses the exact origin, standard-client cookie, and only console/v1 for live reads", async () => {
    const requests: Array<{ readonly url: URL; readonly init: RequestInit | undefined }> = [];
    const fetch: FetchImplementation = async (input, init) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.pathname === "/api/sessions") return Response.json([session(SESSION_A)]);
      if (url.pathname === `/api/sessions/${SESSION_A}`) return Response.json(session(SESSION_A));
      if (url.pathname.endsWith("/snapshot")) return Response.json(snapshot());
      return new Response(`data: ${JSON.stringify(event(1))}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const transport = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      { fetch },
    );

    await transport.listFleet();
    await transport.getSelected(SESSION_A);
    const live = await transport.getSnapshot(SESSION_A);
    const received = [];
    const abort = new AbortController();
    for await (const envelope of transport.streamEvents(SESSION_A, "epoch-1", 0, abort.signal))
      received.push(envelope);

    expect(requests.map(({ url }) => url.origin)).toEqual([
      "https://scotty.example",
      "https://scotty.example",
      "https://scotty.example",
      "https://scotty.example",
    ]);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/sessions",
      `/api/sessions/${SESSION_A}`,
      `/s/${SESSION_A}/console/v1/snapshot`,
      `/s/${SESSION_A}/console/v1/events`,
    ]);
    expect(requests.every(({ url }) => !url.pathname.includes("/rpc"))).toBe(true);
    expect(new Headers(requests[2].init?.headers).get("cookie")).toBe(
      `__Host-scotty=${CREDENTIAL}`,
    );
    expect("sessionRevision" in live).toBe(true);
    expect(received).toEqual([event(1)]);
  });

  it("contains a rejected stream cancellation during local session switching", async () => {
    let cancelled = false;
    const transport = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(event(1))}\n\n`),
                );
              },
              cancel() {
                cancelled = true;
                return Promise.reject(new DOMException("already aborted", "AbortError"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    );
    const iterator = transport
      .streamEvents(SESSION_A, "epoch-1", 0, new AbortController().signal)
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: event(1) });
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    expect(cancelled).toBe(true);
  });

  it("decodes typed production passive-relay unavailability", async () => {
    const transport = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      {
        fetch: async () =>
          Response.json(
            {
              version: 1,
              status: "unavailable",
              reason: "provider_passive_relay_unavailable",
              retryable: false,
            },
            { status: 503 },
          ),
      },
    );

    await expect(transport.getSnapshot(SESSION_A)).resolves.toEqual({
      version: 1,
      status: "unavailable",
      reason: "provider_passive_relay_unavailable",
      retryable: false,
    });
  });

  it("posts one revision-bound mutation with its stable command ID and no retry", async () => {
    const requests: Request[] = [];
    const transport = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      {
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(
            {
              version: 1,
              epoch: "epoch-1",
              commandId: COMMAND_ID,
              commandDigest: COMMAND_DIGEST,
              status: "accepted",
              response: { success: true },
            },
            { status: 202 },
          );
        },
      },
    );

    await expect(transport.postCommand(SESSION_A, command)).resolves.toMatchObject({
      commandId: COMMAND_ID,
      status: "accepted",
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(`/s/${SESSION_A}/console/v1/command`);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("origin")).toBe("https://scotty.example");
    expect(requests[0]?.headers.get("sec-fetch-site")).toBe("same-origin");
    expect(await requests[0]?.json()).toEqual(command);
  });

  it("verifies the receipt digest against the exact submitted canonical intent", async () => {
    const transport = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      {
        fetch: async () =>
          Response.json(
            {
              version: 1,
              epoch: command.epoch,
              commandId: command.commandId,
              commandDigest: await commandIntentDigest({ ...command.intent, message: "other" }),
              status: "accepted",
              response: { success: true },
            },
            { status: 202 },
          ),
      },
    );

    await expect(transport.postCommand(SESSION_A, command)).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("decodes deterministic command rejection separately from transport ambiguity", async () => {
    const transport = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      {
        fetch: async () =>
          Response.json(
            {
              version: 1,
              status: "error",
              code: "extension_ui_not_pending",
              retryable: false,
            },
            { status: 409 },
          ),
      },
    );

    await expect(transport.postCommand(SESSION_A, command)).resolves.toEqual({
      version: 1,
      status: "error",
      code: "extension_ui_not_pending",
      retryable: false,
    });
  });

  it("surfaces an ambiguous POST failure after one attempt", async () => {
    let calls = 0;
    const transport = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      {
        fetch: async () => {
          calls += 1;
          throw new Error("connection reset");
        },
      },
    );

    await expect(transport.postCommand(SESSION_A, command)).rejects.toThrow("connection reset");
    expect(calls).toBe(1);
  });

  it("decodes stale command authority without retrying", async () => {
    let calls = 0;
    const transport = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      {
        fetch: async () => {
          calls += 1;
          return Response.json(
            {
              version: 1,
              status: "stale",
              expectedSessionRevision: 7,
              sessionRevision: 8,
              retryable: false,
            },
            { status: 409 },
          );
        },
      },
    );

    await expect(transport.postCommand(SESSION_A, command)).resolves.toMatchObject({
      status: "stale",
      sessionRevision: 8,
    });
    expect(calls).toBe(1);
  });

  it("rejects oversized and malformed untrusted responses", async () => {
    const oversized = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      {
        fetch: async () =>
          new Response("[]", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
      },
    );
    const malformed = new HttpConsoleTransport(
      { version: 1, origin: "https://scotty.example", credential: CREDENTIAL },
      { fetch: async () => Response.json([{ id: "not-a-session" }]) },
    );

    await expect(oversized.listFleet()).rejects.toMatchObject({ code: "response_too_large" });
    await expect(malformed.listFleet()).rejects.toMatchObject({ code: "response_invalid" });
  });
});
