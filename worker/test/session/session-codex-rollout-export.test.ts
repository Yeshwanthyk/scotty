import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import { rejects } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionAuthority } from "../../src/session-actor/authority";
import type { SessionActorMetadata } from "../../src/session-actor/metadata";
import { ScottyError } from "../../src/session/contracts";
import { parseSandboxTar } from "../../src/sandbox/archive";
import { makeSessionRecord } from "../support";
import {
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
  type SessionHarness,
} from "../support/session-harness";

const selection = { agent: "codex", model: "gpt-5.4", effort: "high" } as const;
const files = [
  "sessions/2026/09/12/rollout-parent.jsonl",
  "sessions/2026/09/12/rollout-child-a.jsonl",
  "sessions/2026/09/12/rollout-child-b.jsonl",
];
const listing = files.map((file) => `${file}\t100\t1`).join("\n") + "\n";

async function fixtureArchive(): Promise<Uint8Array> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scotty-native-rollouts-"));
  try {
    for (const [index, file] of files.entries()) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        `${JSON.stringify({ type: "session_meta", payload: { id: `native-thread-${index}` } })}\n`,
      );
    }
    return execFileSync("tar", ["--format=ustar", "-cf", "-", "-C", root, ...files]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function harnessForArchive(changeRevision = false) {
  const tar = await fixtureArchive();
  let archiveWritten = false;
  let harness: SessionHarness;
  harness = await createSessionHarness({
    containerPlacementId: "container-runtime-1",
    onGetContainerPlacementId: async () => {
      if (!changeRevision || !archiveWritten) return;
      archiveWritten = false;
      await harness.sandbox.renameScottySession("Renamed during export");
    },
    initialEntries: {
      [sessionHarnessKeys.actorFixtureSession]: makeSessionRecord({ id: SESSION_ID }),
    },
    commandStdout: (command) =>
      command.startsWith("find '/tmp/scotty-codex-runtime-1/runtime/codex-home/sessions'")
        ? listing
        : undefined,
    commandGate: async (command) => {
      const archivePath = /tar --format=ustar -cf '([^']+)'/u.exec(command)?.[1];
      if (archivePath === undefined) return;
      await harness.sandbox.writeFile(
        archivePath,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(tar);
            controller.close();
          },
        }),
      );
      archiveWritten = true;
    },
  });
  const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
  const metadata = harness.read<SessionActorMetadata>(sessionHarnessKeys.actorMetadata);
  assert.ok(authority && metadata);
  harness.memory.values.set(sessionHarnessKeys.actorAuthority, {
    ...authority,
    session: { ...authority.session, selection },
  });
  harness.memory.values.set(sessionHarnessKeys.actorMetadata, {
    ...metadata,
    selection,
    codexControl: { token: "c".repeat(64), initialPrompt: "Investigate the failing build" },
  });
  return { harness, tar };
}

describe("read-only native Codex rollout export", () => {
  it("exports all parent and child files when the agent process has stopped", async () => {
    const { harness, tar } = await harnessForArchive();
    const parsed = parseSandboxTar(tar);
    assert.ok(Result.isSuccess(parsed), Result.isFailure(parsed) ? parsed.failure.message : "");
    const before = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    const archive = await harness.sandbox.prepareCodexRolloutArchive();
    assert.deepStrictEqual(archive.bytes, tar);
    assert.equal(archive.filename, `scotty-${SESSION_ID}-codex-rollouts.tar`);
    assert.equal(
      harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority)?.revision,
      before?.revision,
    );
    assert.ok(harness.commands.some((command) => command.includes("tar --format=ustar -cf")));
    assert.ok(!harness.events.some((event) => event.startsWith("host:pi:start:")));
    assert.ok(!harness.events.some((event) => event.includes("warm_work")));
  });

  it("rejects publication when actor authority changes during archive creation", async () => {
    const { harness } = await harnessForArchive(true);
    await rejects(
      harness.sandbox.prepareCodexRolloutArchive(),
      (error: unknown) =>
        error instanceof ScottyError &&
        error.code === "conflict" &&
        error.message === "Codex rollout session changed during export",
    );
    assert.equal(harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority)?.revision, 2);
  });
});
