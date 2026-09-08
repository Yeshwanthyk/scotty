import { CODEX_VERSION } from "../../../protocol/codex-app-server";
import { CodexSnapshot } from "../../src/agent/codex/runtime";
import type { SessionActorMetadata } from "../../src/session-actor/metadata";
import type { LifecycleJournalEvent } from "../../src/session-actor/journal";
import type { SessionAuthority } from "../../src/session-actor/authority";
import {
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
  type HarnessOptions,
  type SessionHarness,
} from "../support/session-harness";
import { makeSessionRecord } from "../support";
import { describe, expect, it } from "vitest";

const CODEX_SELECTION = {
  agent: "codex",
  model: "gpt-5.4",
  effort: "high",
} as const;
const CODEX_TOKEN = "c".repeat(64);
const CODEX_GENERATION = "runtime-1";
const CODEX_THREAD = "runtime-1";
const CODEX_TURN = "transport-runtime-1";
const CODEX_INCARNATION = "container-runtime-1";

type CodexPrompt = (typeof CodexSnapshot.Type)["prompt"];

const codexSnapshot = (prompt: CodexPrompt): typeof CodexSnapshot.Type => ({
  generation: CODEX_GENERATION,
  threadId: CODEX_THREAD,
  version: CODEX_VERSION,
  settings: {
    model: CODEX_SELECTION.model,
    effort: CODEX_SELECTION.effort,
    workspace: `/workspace/${SESSION_ID}`,
    modelProvider: "scotty-managed",
    approvalPolicy: "never",
    sandbox: "dangerFullAccess",
  },
  ready: true,
  failure: null,
  prompt,
  cleanup: null,
});

const runningSnapshot = (): typeof CodexSnapshot.Type =>
  codexSnapshot({ status: "running", turnId: CODEX_TURN });
const interruptedSnapshot = (): typeof CodexSnapshot.Type =>
  codexSnapshot({
    status: "terminal",
    turnId: CODEX_TURN,
    outcome: "interrupted",
    text: "",
  });

const makeCodexHarness = async (
  containerFetch: HarnessOptions["containerFetch"],
  containerPlacementId = CODEX_INCARNATION,
): Promise<SessionHarness> => {
  const harness = await createSessionHarness({
    containerPlacementId,
    initialEntries: {
      [sessionHarnessKeys.actorFixtureSession]: makeSessionRecord({ id: SESSION_ID }),
    },
    containerFetch,
  });
  const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
  const metadata = harness.read<SessionActorMetadata>(sessionHarnessKeys.actorMetadata);
  if (authority === undefined || metadata === undefined)
    throw new Error("Codex fixture did not seed actor state");
  harness.memory.values.set(sessionHarnessKeys.actorAuthority, {
    ...authority,
    session: { ...authority.session, selection: CODEX_SELECTION },
  });
  harness.memory.values.set(sessionHarnessKeys.actorMetadata, {
    ...metadata,
    selection: CODEX_SELECTION,
    codexControl: { token: CODEX_TOKEN, initialPrompt: "Investigate the failing build" },
  });
  return harness;
};

const advanceAuthorityRevision = (harness: SessionHarness, revision: number): void => {
  const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
  const journalTail = harness.read<LifecycleJournalEvent>(sessionHarnessKeys.actorJournalTail);
  if (authority === undefined || journalTail === undefined)
    throw new Error("Codex fixture authority is unavailable");
  harness.memory.values.set(sessionHarnessKeys.actorAuthority, { ...authority, revision });
  harness.memory.values.set(sessionHarnessKeys.actorRevision, revision);
  harness.memory.values.set(sessionHarnessKeys.actorJournalSequence, revision);
  harness.memory.values.set(sessionHarnessKeys.actorJournalTail, {
    ...journalTail,
    sequence: revision,
    revision,
  });
};

describe("Sandbox Codex interrupt authority", () => {
  it("rejects a stale session revision before contacting the native runtime", async () => {
    const requests: Request[] = [];
    const harness = await makeCodexHarness(async (request) => {
      requests.push(request.clone());
      throw new Error("stale interrupt must not reach Codex");
    });

    const response = await harness.sandbox.interruptScottyCodexSession({
      turnId: CODEX_TURN,
      sessionRevision: 2,
    });

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      id: SESSION_ID,
      status: "stale",
      reason: "session_revision_changed",
      expectedSessionRevision: 2,
      sessionRevision: 1,
      retryable: false,
    });
    expect(requests).toHaveLength(0);
  });

  it("rejects a changed container incarnation before native admission", async () => {
    const requests: Request[] = [];
    const harness = await makeCodexHarness(async (request) => {
      requests.push(request.clone());
      throw new Error("incarnation mismatch must not reach Codex");
    }, "container-runtime-2");

    const response = await harness.sandbox.interruptScottyCodexSession({
      turnId: CODEX_TURN,
      sessionRevision: 1,
    });

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "conflict", message: "Codex runtime generation is no longer current" },
    });
    expect(requests).toHaveLength(0);
  });

  it("returns stale after a native interrupt when Session authority changes during dispatch", async () => {
    let harness: SessionHarness;
    let snapshotCalls = 0;
    const requests: Request[] = [];
    harness = await makeCodexHarness(async (request) => {
      requests.push(request.clone());
      const pathname = new URL(request.url).pathname;
      if (pathname === "/snapshot") {
        snapshotCalls += 1;
        return Response.json(snapshotCalls < 3 ? runningSnapshot() : interruptedSnapshot());
      }
      if (pathname === "/interrupt") {
        advanceAuthorityRevision(harness, 2);
        return Response.json(
          {
            generation: CODEX_GENERATION,
            threadId: CODEX_THREAD,
            turnId: CODEX_TURN,
            status: "interrupted",
          },
          { status: 202 },
        );
      }
      throw new Error(`unexpected Codex path: ${pathname}`);
    });

    const response = await harness.sandbox.interruptScottyCodexSession({
      turnId: CODEX_TURN,
      sessionRevision: 1,
    });

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      id: SESSION_ID,
      status: "stale",
      reason: "session_revision_changed",
      expectedSessionRevision: 1,
      sessionRevision: 2,
      retryable: false,
    });
    expect(snapshotCalls).toBe(3);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/snapshot",
      "/snapshot",
      "/interrupt",
      "/snapshot",
    ]);
  });
});
