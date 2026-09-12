import { CODEX_VERSION } from "../../../protocol/codex-app-server";
import { CodexSnapshot } from "../../src/agent/codex/runtime";
import type { SessionActorMetadata } from "../../src/session-actor/metadata";
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
  warmWork?: "evidence" | "hatch" | "down",
): Promise<SessionHarness> => {
  const harness = await createSessionHarness({
    containerPlacementId,
    initialEntries: {
      [sessionHarnessKeys.actorFixtureSession]: makeSessionRecord({
        id: SESSION_ID,
        ...(warmWork === undefined
          ? {}
          : {
              operation: {
                kind: warmWork,
                nonce: "warm-work-read",
                startedAt: "2026-01-01T00:00:01.000Z",
              },
            }),
      }),
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

const queueKey = "scotty:codex-follow-ups";

describe("DO-owned Codex follow-ups", () => {
  for (const workKind of ["evidence", "hatch"] as const)
    it(`reads the same live Codex generation during ${workKind} warm work`, async () => {
      let nativeReads = 0;
      const harness = await makeCodexHarness(
        async () => {
          nativeReads++;
          return Response.json(runningSnapshot());
        },
        CODEX_INCARNATION,
        workKind,
      );
      const conversation = await harness.sandbox.readScottyCodexConversation();
      expect(conversation?.transport.sessionRevision).toBe(1);
      expect(conversation?.runtimeStopped).toBe(false);
      expect(conversation?.messageAdmissionAvailable).toBe(false);
      expect(conversation?.turns[0]?.id).toBe(CODEX_TURN);
      expect((await harness.sandbox.steerScottyCodexSession("later"))?.status).toBe(409);
      expect(nativeReads).toBe(1);
    });

  it("does not read Codex during Down warm work", async () => {
    const harness = await makeCodexHarness(
      async () => Response.json(runningSnapshot()),
      CODEX_INCARNATION,
      "down",
    );
    await expect(harness.sandbox.readScottyCodexConversation()).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("rejects a warm-work conversation read when the actor revision changes mid-read", async () => {
    let harness: SessionHarness;
    harness = await makeCodexHarness(
      async () => {
        const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
        if (authority !== undefined)
          harness.memory.values.set(sessionHarnessKeys.actorAuthority, {
            ...authority,
            revision: authority.revision + 1,
          });
        return Response.json(runningSnapshot());
      },
      CODEX_INCARNATION,
      "evidence",
    );
    await expect(harness.sandbox.readScottyCodexConversation()).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("queues during an active turn, survives reconstruction, and admits once after terminal", async () => {
    let active = true;
    let posts = 0;
    const posted: unknown[] = [];
    const native = async (request: Request) => {
      if (new URL(request.url).pathname === "/message") {
        posts += 1;
        posted.push(await request.json());
        return Response.json(
          { generation: CODEX_GENERATION, threadId: CODEX_THREAD, turnId: "next-turn" },
          { status: 202 },
        );
      }
      return Response.json(active ? runningSnapshot() : interruptedSnapshot());
    };
    const first = await makeCodexHarness(native);
    const accepted = await first.sandbox.steerScottyCodexSession(
      "Check the tests",
      "queued-1",
      "followUp",
    );
    expect(accepted?.status).toBe(202);
    await first.sandbox.drainCodexFollowUps();
    expect(posts).toBe(0);
    const conversation = await first.sandbox.readScottyCodexConversation();
    expect(conversation?.messageAdmissionAvailable).toBe(true);
    expect(conversation?.queue.followUp).toEqual([{ id: "queued-1", text: "Check the tests" }]);
    const restored = await createSessionHarness({
      containerPlacementId: CODEX_INCARNATION,
      initialEntries: Object.fromEntries(first.memory.values),
      containerFetch: native,
    });
    active = false;
    await restored.sandbox.drainCodexFollowUps();
    await restored.sandbox.drainCodexFollowUps();
    expect(posts).toBe(1);
    expect(posted).toEqual([
      expect.objectContaining({
        mode: "message",
        clientUserMessageId: "queued-1",
        text: "Check the tests",
      }),
    ]);
    const replay = await restored.sandbox.steerScottyCodexSession(
      "Check the tests",
      "queued-1",
      "followUp",
    );
    expect(replay?.status).toBe(202);
    expect(restored.read(queueKey)).toMatchObject({
      pending: [],
      receipts: [{ id: "queued-1", text: "Check the tests" }],
    });
  });

  it("retains a lost reply and reconciles the same message ID while the admitted turn runs", async () => {
    let posts = 0;
    const posted: unknown[] = [];
    let admitted = false;
    const harness = await makeCodexHarness(async (request) => {
      if (new URL(request.url).pathname === "/message") {
        posts += 1;
        posted.push(await request.json());
        if (!admitted) {
          admitted = true;
          throw new Error("reply lost after admission");
        }
        return Response.json(
          { generation: CODEX_GENERATION, threadId: CODEX_THREAD, turnId: CODEX_TURN },
          { status: 202 },
        );
      }
      return Response.json(admitted ? runningSnapshot() : interruptedSnapshot());
    });
    await harness.sandbox.steerScottyCodexSession("Check again", "queued-lost", "followUp");
    await expect(harness.sandbox.drainCodexFollowUps()).rejects.toBeDefined();
    expect(harness.read(queueKey)).toMatchObject({ pending: [{ id: "queued-lost" }] });
    await harness.sandbox.drainCodexFollowUps();
    expect(posts).toBe(2);
    expect(posted).toEqual([
      expect.objectContaining({ mode: "message", clientUserMessageId: "queued-lost" }),
      expect.objectContaining({ mode: "message", clientUserMessageId: "queued-lost" }),
    ]);
    expect(harness.read(queueKey)).toMatchObject({ pending: [] });
  });

  it("rejects a reused ID with different text and requires a stable client ID", async () => {
    const harness = await makeCodexHarness(async () => Response.json(runningSnapshot()));
    expect(
      (await harness.sandbox.steerScottyCodexSession("one", "same-id", "followUp"))?.status,
    ).toBe(202);
    expect(
      (await harness.sandbox.steerScottyCodexSession("two", "same-id", "followUp"))?.status,
    ).toBe(409);
    expect(
      (await harness.sandbox.steerScottyCodexSession("one", undefined, "followUp"))?.status,
    ).toBe(400);
  });
});
