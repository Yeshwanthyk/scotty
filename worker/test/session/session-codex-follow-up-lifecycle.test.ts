import type { CodexFollowUps } from "../../src/session/codex-follow-ups";
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
import { assert, describe, it } from "@effect/vitest";

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

const queueKey = "scotty:codex-follow-ups";

describe("Codex follow-up lifecycle ownership", () => {
  it("keeps queued work through ordinary interruption and drains after terminal without a browser", async () => {
    let interrupted = false;
    let delivered = 0;
    const messages: unknown[] = [];
    const harness = await makeCodexHarness(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/interrupt") {
        interrupted = true;
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
      if (path === "/message") {
        delivered++;
        messages.push(await request.json());
        return Response.json(
          { generation: CODEX_GENERATION, threadId: CODEX_THREAD, turnId: "follow-up-turn" },
          { status: 202 },
        );
      }
      return Response.json(interrupted ? interruptedSnapshot() : runningSnapshot());
    });
    const accepted = await harness.sandbox.steerScottyCodexSession(
      "Run after interruption",
      "after-interrupt",
      "followUp",
    );
    assert.equal(accepted?.status, 202);
    const response = await harness.sandbox.interruptScottyCodexSession({
      turnId: CODEX_TURN,
      sessionRevision: 1,
    });
    assert.equal(response?.status, 202);
    assert.deepStrictEqual(harness.read<CodexFollowUps>(queueKey)?.pending, [
      { id: "after-interrupt", text: "Run after interruption" },
    ]);
    assert.ok(harness.schedules.some((schedule) => schedule.callback === "drainCodexFollowUps"));
    await harness.sandbox.drainCodexFollowUps();
    assert.equal(delivered, 1);
    assert.deepStrictEqual(messages, [
      {
        mode: "message",
        threadId: CODEX_THREAD,
        text: "Run after interruption",
        clientUserMessageId: "after-interrupt",
      },
    ]);
    assert.deepStrictEqual(harness.read<CodexFollowUps>(queueKey)?.pending, []);
  });

  it("clears pending and receipt authority on vaporize and stale callbacks cannot revive work", async () => {
    let posts = 0;
    const harness = await makeCodexHarness(async (request) => {
      if (new URL(request.url).pathname === "/message") posts++;
      return Response.json(runningSnapshot());
    });
    await harness.sandbox.steerScottyCodexSession("Must not revive", "gone-item", "followUp");
    assert.isDefined(harness.read(queueKey));
    const result = await harness.sandbox.vaporizeScottySession();
    assert.equal(result.status, "gone");
    assert.isUndefined(harness.read(queueKey));
    const afterGone = harness.schedules.length;
    await harness.sandbox.drainCodexFollowUps();
    assert.equal(posts, 0);
    assert.equal(harness.schedules.length, afterGone);
    assert.isUndefined(harness.read(queueKey));
  });

  it("preserves pending work while sleep stops the native runtime", async () => {
    let posts = 0;
    let saves = 0;
    const harness = await makeCodexHarness(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/save") {
        saves++;
        return Response.json({
          generation: CODEX_GENERATION,
          threadId: CODEX_THREAD,
          initialTurnId: CODEX_TURN,
        });
      }
      const generation = request.headers.get("x-scotty-codex-generation") ?? CODEX_GENERATION;
      if (path === "/message") {
        posts++;
        return Response.json(
          { generation, threadId: CODEX_THREAD, turnId: "after-resume-turn" },
          { status: 202 },
        );
      }
      return Response.json({
        ...(saves === 0 ? runningSnapshot() : interruptedSnapshot()),
        generation,
        turns: [{ id: CODEX_TURN, state: "aborted", user: "initial", assistant: "", tools: [] }],
      });
    });
    await harness.sandbox.steerScottyCodexSession("After resume", "sleep-item", "followUp");
    const result = await harness.sandbox.sleepScottySession();
    assert.equal(result.status, "sleeping");
    assert.equal(saves, 1);
    assert.deepStrictEqual(harness.read<CodexFollowUps>(queueKey)?.pending, [
      { id: "sleep-item", text: "After resume" },
    ]);
    await harness.sandbox.drainCodexFollowUps();
    assert.equal(posts, 0);
    assert.deepStrictEqual(harness.read<CodexFollowUps>(queueKey)?.pending, [
      { id: "sleep-item", text: "After resume" },
    ]);
  });
  it.each([
    { receiptFound: true, expectedOutcome: "confirmed" },
    { receiptFound: false, expectedOutcome: "unknown" },
  ])(
    "reconciles a prior-generation attempt without admitting new work when receiptFound=$receiptFound",
    async ({ receiptFound, expectedOutcome }) => {
      const messages: unknown[] = [];
      const harness = await makeCodexHarness(async (request) => {
        if (new URL(request.url).pathname === "/message") {
          messages.push(await request.json());
          return receiptFound
            ? Response.json(
                {
                  generation: CODEX_GENERATION,
                  threadId: CODEX_THREAD,
                  turnId: "already-accepted-turn",
                },
                { status: 202 },
              )
            : Response.json({ code: "idempotency_unknown" }, { status: 409 });
        }
        return Response.json(interruptedSnapshot());
      });
      harness.memory.values.set(queueKey, {
        pending: [
          {
            id: "old-attempt",
            text: "Prior delivery",
            attempt: { generation: "before-sleep", threadId: CODEX_THREAD },
          },
        ],
        receipts: [],
      });
      const outcome = await harness.sandbox.drainCodexFollowUps().then(
        () => "confirmed",
        () => "unknown",
      );
      assert.equal(outcome, expectedOutcome);
      assert.deepStrictEqual(messages, [
        {
          mode: "message",
          threadId: CODEX_THREAD,
          text: "Prior delivery",
          clientUserMessageId: "old-attempt",
          reconcileOnly: true,
        },
      ]);
      const queue = harness.read<CodexFollowUps>(queueKey);
      assert.deepStrictEqual(
        queue?.pending.map(({ id }) => id),
        receiptFound ? [] : ["old-attempt"],
      );
      assert.deepStrictEqual(
        queue?.receipts,
        receiptFound ? [{ id: "old-attempt", text: "Prior delivery" }] : [],
      );
    },
  );
});
