import { describe, expect, it } from "vitest";
import type { StoredCredential } from "../src/contracts";
import { createSessionHarness, makeStoredCredential, sessionHarnessKeys } from "./session-harness";

describe("session installation Pi credential write-back", () => {
  it("commits rotation before installation write-back and stores providers only", async () => {
    const nonce = "rotation-nonce";
    const initial = makeStoredCredential({
      refreshLease: { nonce, startedAt: "2026-07-24T11:59:59.000Z" },
    });
    const harness = await createSessionHarness({
      initialEntries: { [sessionHarnessKeys.credential]: initial },
    });
    const sentinel = initial.providers["openai-codex"]?.sentinel ?? "missing";
    await harness.sandbox.persistRotatedCredential(
      sentinel,
      { accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresInSeconds: 60 },
      nonce,
    );
    expect(harness.events.indexOf("credential:put")).toBeLessThan(
      harness.events.indexOf("installation-pi-auth:write"),
    );
    const written = harness.installationPiAuthWrites[0];
    expect(written?.source).toBe("rotation");
    expect(JSON.stringify(written)).not.toContain("github");
    expect(JSON.stringify(written)).not.toContain("sentinel");
    expect(JSON.stringify(written)).toContain("rotated-access");
  });

  it("keeps the committed vault rotation when installation write-back fails", async () => {
    const nonce = "rotation-nonce";
    const initial = makeStoredCredential({
      refreshLease: { nonce, startedAt: "2026-07-24T11:59:59.000Z" },
    });
    const harness = await createSessionHarness({
      initialEntries: { [sessionHarnessKeys.credential]: initial },
      installationPiAuthWriteFailure: true,
    });
    const sentinel = initial.providers["openai-codex"]?.sentinel ?? "missing";
    await expect(
      harness.sandbox.persistRotatedCredential(sentinel, { accessToken: "rotated-access" }, nonce),
    ).rejects.toThrow();
    const stored = harness.read<StoredCredential>(sessionHarnessKeys.credential);
    expect(stored?.providers["openai-codex"]?.credential).toMatchObject({
      access: "rotated-access",
    });
    expect(stored?.refreshLease).toBeUndefined();
  });
});
