import { assert, describe, it } from "@effect/vitest";
import { ScottyError, type SessionRecord } from "../../src/session/contracts";
import { decodeSandboxFileStream } from "../../src/session/object";
import {
  createSessionHarness,
  type HarnessFailureStage,
  type InitialStorageEntries,
  SESSION_ID,
  sessionHarnessKeys,
} from "../support/session-harness";
import { makeSessionRecord } from "../support";

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

const warmRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord =>
  makeSessionRecord({
    id: SESSION_ID,
    branch: `scotty/${SESSION_ID}`,
    codexThreadId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    ...overrides,
  });

const authorityEntries = (record: SessionRecord = warmRecord()): InitialStorageEntries => ({
  [sessionHarnessKeys.record]: record,
});

const assertUpstream = (error: unknown): void => {
  assert.ok(error instanceof ScottyError);
  assert.strictEqual(error.code, "upstream");
};

const assertLeaseReleased = (record: SessionRecord | undefined): void => {
  assert.strictEqual(record?.status, "warm");
  assert.strictEqual(record?.operation, null);
};

describe("Sandbox beam-down orchestration", () => {
  it("decodes the Sandbox SDK file protocol before returning archive bytes", async () => {
    const payload = [
      {
        type: "metadata",
        mimeType: "application/x-tar",
        size: 4,
        isBinary: true,
        encoding: "base64",
      },
      { type: "chunk", data: "AAEC/w==" },
      { type: "complete", bytesRead: 4 },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const source = new Response(payload).body;
    assert.ok(source);

    const bytes = new Uint8Array(await new Response(decodeSandboxFileStream(source)).arrayBuffer());

    assert.deepStrictEqual([...bytes], [0, 1, 2, 255]);
  });

  const rolloutPath =
    `/workspace/${SESSION_ID}/.codex/sessions/2026/07/24/` +
    "rollout-a1b2c3d4-e5f6-7890-abcd-ef0123456789.jsonl";

  const downStdout = (command: string): string | undefined => {
    if (command.includes("rev-parse HEAD")) return "abc123def456\n";
    if (command.startsWith("find ")) return `${rolloutPath}\n`;
    return undefined;
  };

  it("builds the exact manifest and tar members, then releases the lease", async () => {
    const harness = await createSessionHarness({
      commandStdout: downStdout,
      initialEntries: authorityEntries(),
    });

    const archive = await harness.sandbox.prepareDownArchive();

    assert.deepStrictEqual(archive, {
      path: `/tmp/scotty-${SESSION_ID}.tar`,
      filename: `scotty-${SESSION_ID}.tar`,
      manifest: {
        id: SESSION_ID,
        repo: "owner/project",
        branch: `scotty/${SESSION_ID}`,
        sha: "abc123def456",
        codexThreadId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
        rolloutFile: "rollout-a1b2c3d4-e5f6-7890-abcd-ef0123456789.jsonl",
      },
    });
    const manifestWrite = harness.writtenFiles.find(({ path }) => path === "/tmp/metadata.json");
    assert.ok(manifestWrite !== undefined);
    assert.deepStrictEqual(JSON.parse(manifestWrite.content), archive.manifest);
    const tar = harness.commands.find((command) => command.startsWith("tar -cf "));
    assert.strictEqual(
      tar,
      `tar -cf '/tmp/scotty-${SESSION_ID}.tar' -C /tmp 'metadata.json' ` +
        `-C '/workspace/${SESSION_ID}/.codex/sessions/2026/07/24' ` +
        "'rollout-a1b2c3d4-e5f6-7890-abcd-ef0123456789.jsonl'",
    );
    assertLeaseReleased(harness.readRecord());
  });

  const failureCases = [
    "downSha",
    "downRollout",
    "downWriteManifest",
    "downTar",
  ] satisfies ReadonlyArray<HarnessFailureStage>;

  for (const stage of failureCases) {
    it(`releases the down lease after injected ${stage} failure`, async () => {
      const harness = await createSessionHarness({
        commandStdout: downStdout,
        failureStage: stage,
        initialEntries: authorityEntries(),
      });

      const error = await rejection(harness.sandbox.prepareDownArchive());

      assertUpstream(error);
      assertLeaseReleased(harness.readRecord());
      assert.ok(harness.events.includes("projection:warm"));
    });
  }
});
