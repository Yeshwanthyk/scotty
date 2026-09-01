import { assert, describe, it } from "vitest";
import {
  composerPresentation,
  createSessionMemory,
  currentActivity,
  reconcileDelivery,
  reconcileAcceptedDelivery,
  renderComposerPresentation,
  shouldSubmitComposerKey,
  type ComposerElements,
} from "../../../public/session/composer.js";

describe("session composer", () => {
  it("keeps drafts and recovery status scoped to their owning session", () => {
    const memory = createSessionMemory();
    memory.restoreDraft("agent-a", "retry only in A");
    memory.entry("agent-a").delivery = {
      kind: "follow_up",
      message: "retry only in A",
      status: "ambiguous",
    };

    assert.strictEqual(memory.entry("agent-b").draft, "");
    assert.isUndefined(memory.entry("agent-b").delivery);
    assert.strictEqual(memory.entry("agent-a").draft, "retry only in A");
    memory.entry("agent-b").draft = "new work in B";
    memory.restoreDraft("agent-a", "held A command");
    assert.strictEqual(memory.entry("agent-b").draft, "new work in B");
    assert.strictEqual(memory.entry("agent-a").draft, "held A command\n\nretry only in A");
  });

  it("submits Enter but preserves Shift+Enter and composition", () => {
    assert.isTrue(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false }));
    assert.isFalse(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, isComposing: false }));
    assert.isFalse(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true }));
    assert.isFalse(shouldSubmitComposerKey({ key: "Escape", shiftKey: false, isComposing: false }));
  });

  it("renders truthful DOM state for queued and ambiguous delivery", () => {
    const elements: ComposerElements = {
      recovery: { hidden: true },
      deliveryControls: { hidden: true, disabled: false },
      stopButton: { hidden: true, disabled: false },
      sendButton: { disabled: false, textContent: "" },
      hint: { dataset: {}, textContent: "" },
    };
    const queued = composerPresentation({
      projection: { active: true, queue: { steer: [], followUp: ["later"] } },
      lane: { items: [] },
      draft: "",
      deliveryMode: "follow_up",
      delivery: { kind: "follow_up", message: "later", status: "queued" },
    });
    renderComposerPresentation(elements, queued);
    assert.strictEqual(
      elements.hint.textContent,
      "Follow-up queued · sends after Pi finishes · “later”",
    );
    assert.strictEqual(elements.hint.dataset.state, "queued");
    assert.isTrue(elements.sendButton.disabled);
    assert.isFalse(elements.deliveryControls.hidden);

    const queuedWithDraft = composerPresentation({
      projection: { active: true, queue: { steer: [], followUp: ["later"] } },
      lane: { items: [] },
      draft: "another message",
      deliveryMode: "follow_up",
      delivery: { kind: "follow_up", message: "later", status: "queued" },
    });
    assert.isFalse(queuedWithDraft.sendDisabled);

    const ambiguous = composerPresentation({
      projection: { active: true },
      lane: { paused: "ambiguous", items: [{ state: "ambiguous" }] },
      draft: "might have arrived",
      deliveryMode: "steer",
      delivery: { kind: "steer", message: "might have arrived", status: "ambiguous" },
    });
    renderComposerPresentation(elements, ambiguous);
    assert.isFalse(elements.recovery.hidden);
    assert.isTrue(elements.deliveryControls.disabled);
    assert.isTrue(elements.sendButton.disabled);
    assert.strictEqual(
      elements.hint.textContent,
      "Delivery unknown · check the conversation before recovering",
    );
  });

  it("uses the state and action label matrix without enabling unavailable actions", () => {
    const cases = [
      {
        name: "loading",
        input: { projection: undefined, lane: { items: [] }, draft: "draft" },
        mode: "follow_up" as const,
        label: "Send",
        hint: "Loading session state…",
        disabled: true,
        deliveryDisabled: false,
      },
      {
        name: "idle empty",
        input: { projection: { active: false }, lane: { items: [] }, draft: "" },
        mode: "follow_up" as const,
        label: "Send",
        hint: "Pi is ready",
        disabled: true,
        deliveryDisabled: false,
      },
      {
        name: "idle typing",
        input: { projection: { active: false }, lane: { items: [] }, draft: "Hello" },
        mode: "follow_up" as const,
        label: "Send",
        hint: "Pi is ready",
        disabled: false,
        deliveryDisabled: false,
      },
      {
        name: "working follow-up",
        input: { projection: { active: true }, lane: { items: [] }, draft: "Later" },
        mode: "follow_up" as const,
        label: "Queue follow-up",
        hint: "Pi is working · Thinking",
        disabled: false,
        deliveryDisabled: false,
      },
      {
        name: "working steer",
        input: { projection: { active: true }, lane: { items: [] }, draft: "Adjust" },
        mode: "steer" as const,
        label: "Steer now",
        hint: "Pi is working · Thinking",
        disabled: false,
        deliveryDisabled: false,
      },
      {
        name: "submitting",
        input: {
          projection: { active: true },
          lane: { items: [{ state: "sending" }] },
          draft: "In flight",
        },
        mode: "follow_up" as const,
        label: "Submitting…",
        hint: "Submitting…",
        disabled: true,
        deliveryDisabled: true,
      },
    ] as const;

    for (const testCase of cases) {
      const presentation = composerPresentation({
        ...testCase.input,
        deliveryMode: testCase.mode,
      });
      assert.strictEqual(presentation.sendLabel, testCase.label, testCase.name);
      assert.strictEqual(presentation.hint, testCase.hint, testCase.name);
      assert.strictEqual(presentation.sendDisabled, testCase.disabled, testCase.name);
      assert.strictEqual(presentation.deliveryDisabled, testCase.deliveryDisabled, testCase.name);
    }
  });

  it("shows bounded current work and explains queued delivery", () => {
    const tools = new Map([["tool-1", { id: "tool-1", name: "bash", status: "running" }]]);
    assert.strictEqual(currentActivity({ active: true, tools }), "Running command");
    assert.strictEqual(
      composerPresentation({
        projection: { active: true, tools, queue: { steer: [], followUp: [] } },
        lane: { items: [] },
        draft: "",
        deliveryMode: "steer",
      }).hint,
      "Pi is working · Running command",
    );
    assert.strictEqual(
      composerPresentation({
        projection: { active: true, tools, queue: { steer: ["Fix this"], followUp: [] } },
        lane: { items: [] },
        draft: "",
        deliveryMode: "steer",
        delivery: {
          kind: "steer",
          message:
            "Explain the current action and then keep this intentionally long message bounded",
          status: "queued",
        },
      }).hint,
      "Steer queued · delivers after Running command · “Explain the current action and then keep this intent…”",
    );
  });

  it("names every command delivery phase without implying replay", () => {
    const cases = [
      ["accepted", "Accepted by Pi"],
      ["delivered", "Delivered to Pi"],
      ["stale", "Session refreshed · review and send again"],
      ["failed", "Failed · rejected by Pi"],
    ] as const;
    for (const [status, hint] of cases) {
      const presentation = composerPresentation({
        projection: { active: true },
        lane: { items: [] },
        draft: "held draft",
        deliveryMode: "follow_up",
        delivery: {
          kind: "follow_up",
          message: "held draft",
          status,
          detail: status === "stale" ? "refreshed" : "rejected by Pi",
        },
      });
      assert.strictEqual(presentation.hint, hint);
    }
    const submitting = composerPresentation({
      projection: { active: true },
      lane: { items: [{ state: "sending" }] },
      draft: "",
      deliveryMode: "follow_up",
    });
    assert.strictEqual(submitting.hint, "Submitting…");
    assert.strictEqual(submitting.sendLabel, "Submitting…");
    assert.isTrue(submitting.sendDisabled);
    assert.isTrue(submitting.deliveryDisabled);
  });

  it("moves accepted queue entries to queued and then delivered", () => {
    const accepted = { kind: "follow_up" as const, message: "later", status: "accepted" as const };
    const queued = reconcileDelivery(accepted, {
      active: true,
      queue: { steer: [], followUp: ["later"] },
    });
    assert.strictEqual(queued?.status, "queued");
    const delivered = reconcileDelivery(queued, {
      active: false,
      queue: { steer: [], followUp: [] },
    });
    assert.strictEqual(delivered?.status, "delivered");
  });

  it("does not regress queued or delivered mode commands when acceptance arrives last", () => {
    for (const kind of ["follow_up", "steer"] as const) {
      const accepted = { kind, message: "same command", status: "accepted" as const };
      const queuedProjection = {
        active: true,
        queue:
          kind === "steer"
            ? { steer: ["same command"], followUp: [] }
            : { steer: [], followUp: ["same command"] },
      };
      const queued = reconcileDelivery(accepted, queuedProjection);
      assert.strictEqual(queued?.status, "queued", kind);
      const receiptWhileQueued = reconcileAcceptedDelivery(queued, accepted, queuedProjection);
      assert.strictEqual(receiptWhileQueued?.status, "queued", kind);
      const receiptAfterQueueRemoval = reconcileAcceptedDelivery(queued, accepted, {
        active: true,
        queue: { steer: [], followUp: [] },
      });
      assert.strictEqual(receiptAfterQueueRemoval?.status, "delivered", kind);
      const delivered = reconcileDelivery(queued, {
        active: true,
        queue: { steer: [], followUp: [] },
      });
      assert.strictEqual(delivered?.status, "delivered", kind);
      const receiptAppliedLast = reconcileAcceptedDelivery(delivered, accepted, {
        active: true,
        queue: { steer: [], followUp: [] },
      });
      assert.strictEqual(receiptAppliedLast?.status, "delivered", kind);
      const repeatedSubmission = reconcileAcceptedDelivery(
        { ...accepted, status: "submitting" },
        accepted,
        { active: true, queue: { steer: [], followUp: [] } },
      );
      assert.strictEqual(repeatedSubmission?.status, "accepted", kind);
    }
  });

  it("recovers an accepted prompt from the authoritative transcript after reload", () => {
    const accepted = { kind: "prompt" as const, message: "Ship it", status: "accepted" as const };
    const delivered = reconcileDelivery(accepted, {
      active: true,
      messages: [{ id: "user-1", role: "user", content: [{ type: "text", text: "Ship it" }] }],
    });
    assert.strictEqual(delivered?.status, "delivered");
  });
});
