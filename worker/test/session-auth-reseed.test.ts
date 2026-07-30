import { assert, describe, it } from "@effect/vitest";
import {
  createSessionHarness,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

describe("Sandbox Pi auth reseed", () => {
  it("restarts the Pi RPC process after replacing its credential file", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });

    await harness.sandbox.fetch(new Request("http://scotty.internal/_scotty/pi-session/snapshot"));
    const reseedStart = harness.events.length;
    const writeStart = harness.writtenFiles.length;

    await harness.sandbox.reseedPiAuth();

    const reseedEvents = harness.events.slice(reseedStart);
    const reseedWrites = harness.writtenFiles.slice(writeStart);
    assert.deepStrictEqual(
      reseedWrites.map((write) => write.path),
      [
        `/workspace/${SESSION_ID}/.pi-agent/auth.json`,
        `/workspace/${SESSION_ID}/.pi-agent/settings.json`,
        `/workspace/${SESSION_ID}/.pi-agent/auth.json`,
        `/workspace/${SESSION_ID}/.pi-agent/settings.json`,
        `/workspace/${SESSION_ID}/.pi-agent/scotty-pi-session.token`,
      ],
    );
    const auth = JSON.parse(reseedWrites[0]?.content ?? "{}");
    assert.strictEqual(auth["openai-codex"]?.type, "oauth");
    assert.match(auth["openai-codex"]?.access ?? "", /^scotty-pi-/u);
    const settings = JSON.parse(reseedWrites[1]?.content ?? "{}");
    assert.deepInclude(settings, {
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "high",
    });
    const quiesce = reseedEvents.indexOf("host:pi:fetch:43117:/quiesce");
    const credentialWrite = reseedEvents.indexOf("host:writeFile");
    const processStop = reseedEvents.indexOf("host:pi:kill");
    const processStart = reseedEvents.indexOf("host:pi:start:scotty-pi-session");
    assert.ok(quiesce >= 0);
    assert.ok(credentialWrite > quiesce);
    assert.ok(processStop > credentialWrite);
    assert.ok(processStart > processStop);
  });
});
