import { assert, describe, it } from "vitest";
import {
  composerPresentation,
  createSessionMemory,
  reconcileDelivery,
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
      deliveryControls: { hidden: true },
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
    assert.strictEqual(elements.hint.textContent, "Queued · sends after Pi finishes");
    assert.strictEqual(elements.hint.dataset.state, "queued");
    assert.isTrue(elements.sendButton.disabled);
    assert.isFalse(elements.deliveryControls.hidden);

    const ambiguous = composerPresentation({
      projection: { active: true },
      lane: { paused: "ambiguous", items: [{ state: "ambiguous" }] },
      draft: "might have arrived",
      deliveryMode: "steer",
      delivery: { kind: "steer", message: "might have arrived", status: "ambiguous" },
    });
    renderComposerPresentation(elements, ambiguous);
    assert.isFalse(elements.recovery.hidden);
    assert.isTrue(elements.sendButton.disabled);
    assert.strictEqual(
      elements.hint.textContent,
      "Delivery unknown · check the conversation before recovering",
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
});
