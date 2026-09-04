import { assert, describe, expect, it } from "vitest";
import {
  GIT_STATUS_COMMAND,
  gitPatchCommand,
  gitTrackedNumstatCommand,
  gitUntrackedNumstatCommand,
} from "../../src/changes/git";
import type { ChangedFile } from "../../src/changes/contracts";
import {
  AuthorityStateSchema,
  StableStateSchema,
  type SessionAuthority,
} from "../../src/session-actor/authority";
import type { LifecycleJournalEvent } from "../../src/session-actor/journal";
import { createSessionHarness, sessionHarnessKeys } from "../support/session-harness";
import { InMemoryFaultInjectableFake, makeSessionRecord } from "../support";

const hash = "a".repeat(40);
const statusFor = (path: string): string =>
  `1 .M N... 100644 100644 100644 ${hash} ${hash} ${path}\0`;

const encodeGitTransport = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const changedFile = (path: string): ChangedFile => ({
  path,
  status: "modified",
  staged: false,
  unstaged: true,
  additions: 1,
  deletions: 1,
  binary: false,
  patchable: true,
});

const advanceActorRevision = (memory: InMemoryFaultInjectableFake, revision: number): void => {
  const authority = memory.values.get(sessionHarnessKeys.actorAuthority) as SessionAuthority;
  const journalTail = memory.values.get(
    sessionHarnessKeys.actorJournalTail,
  ) as LifecycleJournalEvent;
  memory.values.set(sessionHarnessKeys.actorAuthority, { ...authority, revision });
  memory.values.set(sessionHarnessKeys.actorRevision, revision);
  memory.values.set(sessionHarnessKeys.actorJournalSequence, revision);
  memory.values.set(sessionHarnessKeys.actorJournalTail, {
    ...journalTail,
    sequence: revision,
    revision,
  });
};

const changeActorRuntimeGeneration = (
  memory: InMemoryFaultInjectableFake,
  revision: number,
): void => {
  advanceActorRevision(memory, revision);
  const authority = memory.values.get(sessionHarnessKeys.actorAuthority) as SessionAuthority;
  assert.ok(AuthorityStateSchema.guards.Stable(authority.state));
  assert.ok(StableStateSchema.guards.Warm(authority.state.stable));
  const stable = authority.state.stable;
  memory.values.set(sessionHarnessKeys.actorAuthority, {
    ...authority,
    revision,
    state: {
      _tag: "Stable",
      stable: {
        ...stable,
        readiness: {
          ...stable.readiness,
          runtime: { ...stable.readiness.runtime, runtimeGeneration: "runtime-generation-2" },
          supervisor: {
            ...stable.readiness.supervisor,
            runtimeGeneration: "runtime-generation-2",
          },
          transport: {
            ...stable.readiness.transport,
            runtimeGeneration: "runtime-generation-2",
          },
        },
      },
    },
  });
};

describe("session changed-files review", () => {
  it("reads one validated patch from a warm Cloudflare worktree without an operation lease", async () => {
    const path = "src/odd '; echo nope.ts";
    const file = changedFile(path);
    const patchCommand = gitPatchCommand(file);
    const trackedCommand = gitTrackedNumstatCommand([file]);
    const untrackedCommand = gitUntrackedNumstatCommand([file]);
    const harness = await createSessionHarness({
      rawPiContainerRunning: true,
      initialEntries: { [sessionHarnessKeys.actorFixtureSession]: makeSessionRecord() },
      commandStdout: (command) =>
        command === GIT_STATUS_COMMAND
          ? encodeGitTransport(statusFor(path))
          : command === trackedCommand
            ? encodeGitTransport(`1\t1\t${path}\0`)
            : command === untrackedCommand
              ? ""
              : command === patchCommand
                ? "@@ -1 +1 @@\n-old\n+new\n"
                : undefined,
    });

    const list = await harness.sandbox.listScottyChanges();
    const patch = await harness.sandbox.getScottyChangedFilePatch(path);

    expect(list.files).toEqual([changedFile(path)]);
    expect(patch.patch).toBe("@@ -1 +1 @@\n-old\n+new\n");
    expect(patch.truncated).toBe(false);
    expect(harness.commands).toContain(patchCommand);
    expect(harness.readRecord()?.operation).toBeNull();
  });

  it("rejects a path that is not in the freshly read current changes", async () => {
    const harness = await createSessionHarness({
      rawPiContainerRunning: true,
      initialEntries: { [sessionHarnessKeys.actorFixtureSession]: makeSessionRecord() },
      commandStdout: (command) =>
        command === GIT_STATUS_COMMAND ? encodeGitTransport(statusFor("src/app.ts")) : "",
    });

    await expect(
      harness.sandbox.getScottyChangedFilePatch("../../etc/passwd"),
    ).rejects.toMatchObject({
      code: "not_found",
      httpStatus: 404,
    });
    expect(harness.commands.some((command) => command.includes("../../etc/passwd"))).toBe(false);
  });

  it("allows activity-only actor revision changes during a Git read", async () => {
    const file = changedFile("src/app.ts");
    const trackedCommand = gitTrackedNumstatCommand([file]);
    const untrackedCommand = gitUntrackedNumstatCommand([file]);
    const initial = makeSessionRecord();
    const memory = new InMemoryFaultInjectableFake();
    let interleaved = false;
    const harness = await createSessionHarness({
      rawPiContainerRunning: true,
      sharedMemory: memory,
      initialEntries: {
        [sessionHarnessKeys.actorFixtureSession]: initial,
      },
      commandStdout: (command) => {
        if (command === GIT_STATUS_COMMAND) return encodeGitTransport(statusFor(file.path));
        if (command === trackedCommand) return encodeGitTransport(`1\t1\t${file.path}\0`);
        if (command === untrackedCommand && !interleaved) {
          interleaved = true;
          advanceActorRevision(memory, 2);
        }
        return "";
      },
    });

    await expect(harness.sandbox.listScottyChanges()).resolves.toMatchObject({
      files: [file],
    });
  });

  it("fails closed when the runtime generation changes during a Git read", async () => {
    const file = changedFile("src/app.ts");
    const trackedCommand = gitTrackedNumstatCommand([file]);
    const untrackedCommand = gitUntrackedNumstatCommand([file]);
    const memory = new InMemoryFaultInjectableFake();
    let interleaved = false;
    const harness = await createSessionHarness({
      rawPiContainerRunning: true,
      sharedMemory: memory,
      initialEntries: {
        [sessionHarnessKeys.actorFixtureSession]: makeSessionRecord(),
      },
      commandStdout: (command) => {
        if (command === GIT_STATUS_COMMAND) return encodeGitTransport(statusFor(file.path));
        if (command === trackedCommand) return encodeGitTransport(`1\t1\t${file.path}\0`);
        if (command === untrackedCommand && !interleaved) {
          interleaved = true;
          changeActorRuntimeGeneration(memory, 2);
        }
        return "";
      },
    });

    await expect(harness.sandbox.listScottyChanges()).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("returns not found after an activity-only revision while finding a missing patch", async () => {
    const initial = makeSessionRecord();
    const memory = new InMemoryFaultInjectableFake();
    const harness = await createSessionHarness({
      rawPiContainerRunning: true,
      sharedMemory: memory,
      initialEntries: {
        [sessionHarnessKeys.actorFixtureSession]: initial,
      },
      commandStdout: (command) => {
        if (command !== GIT_STATUS_COMMAND) return "";
        advanceActorRevision(memory, 2);
        return encodeGitTransport("");
      },
    });

    await expect(harness.sandbox.getScottyChangedFilePatch("src/app.ts")).rejects.toMatchObject({
      code: "not_found",
      httpStatus: 404,
    });
  });

  it.each([
    ["sleeping", makeSessionRecord({ status: "sleeping" })],
    [
      "failed",
      makeSessionRecord({
        status: "failed",
        failure: { code: "runtime_failed", message: "failed", recoverable: true },
      }),
    ],
    [
      "active lifecycle operation",
      makeSessionRecord({
        operation: {
          kind: "snapshot",
          nonce: "snapshot-nonce",
          startedAt: "2026-01-01T00:00:02.000Z",
        },
      }),
    ],
  ])("fails closed for %s sessions without touching Git", async (_label, record) => {
    const harness = await createSessionHarness({
      rawPiContainerRunning: true,
      initialEntries: { [sessionHarnessKeys.actorFixtureSession]: record },
    });

    await expect(harness.sandbox.listScottyChanges()).rejects.toMatchObject({ httpStatus: 409 });
    expect(harness.commands).toEqual([]);
  });
});
