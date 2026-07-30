import { assert, describe, it } from "@effect/vitest";
import {
  createSessionHarness,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

describe("Sandbox Pi worklog HTTP boundary", () => {
  it("injects the session capability through the reserved fetch handler", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-session/snapshot?epoch=epoch-1&since=7", {
        headers: {
          accept: "application/json",
          authorization: "must-not-forward",
          cookie: "must-not-forward",
        },
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { status: "quiesced" });
    const forwarded = harness.piRequests.at(-1);
    assert.ok(forwarded);
    assert.strictEqual(new URL(forwarded.url).pathname, "/snapshot");
    assert.strictEqual(new URL(forwarded.url).search, "?epoch=epoch-1&since=7");
    assert.strictEqual(forwarded.headers.get("accept"), "application/json");
    assert.strictEqual(forwarded.headers.get("authorization"), null);
    assert.strictEqual(forwarded.headers.get("cookie"), null);
    assert.ok((forwarded.headers.get("x-scotty-pi-session")?.length ?? 0) >= 32);
    assert.ok(harness.events.includes("host:pi:fetch:43117:/snapshot"));
  });

  it("rejects unsupported internal actions before touching the container", async () => {
    const harness = await createSessionHarness();

    const response = await harness.sandbox.fetch(
      new Request("http://scotty.internal/_scotty/pi-session/unknown"),
    );

    assert.strictEqual(response.status, 404);
    assert.deepStrictEqual(harness.piRequests, []);
  });
});
