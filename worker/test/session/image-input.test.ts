import { assert, describe, it } from "@effect/vitest";
import { createSessionIdempotency, parseCreateInput } from "../../src/session/contracts";
import {
  confirmSidecarFollowUp,
  emptySidecarFollowUps,
  enqueueSidecarFollowUp,
} from "../../src/session/sidecar-follow-ups";
import { Result, Schema } from "effect";
import { SidecarFollowUpSchema } from "../../src/session/sidecar-follow-ups";
import { sha256Hex } from "../../src/shared/digest";
import type { PiConsoleImage } from "../../../protocol/agents/pi/pi-console";

const decodeFollowUp = Schema.decodeUnknownResult(SidecarFollowUpSchema);
const image: PiConsoleImage = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
const input = {
  title: "Image task",
  prompt: "Inspect this",
  provider: "cloudflare",
  repo: "owner/project",
};

describe("session image admission", () => {
  it("preserves valid images and rejects malformed image payloads", () => {
    assert.deepEqual(parseCreateInput({ ...input, images: [image] }).images, [image]);
    assert.throws(() => parseCreateInput({ ...input, images: [{ ...image, data: "not base64" }] }));
    assert.throws(() =>
      parseCreateInput({ ...input, images: [{ ...image, mimeType: "image/svg+xml" }] }),
    );
  });

  it("includes image contents in create retry identity and preserves text-only identity", async () => {
    const key = "image-create-retry";
    const plain = await createSessionIdempotency(key, parseCreateInput(input));
    const empty = await createSessionIdempotency(key, parseCreateInput({ ...input, images: [] }));
    const original = await createSessionIdempotency(
      key,
      parseCreateInput({ ...input, images: [image] }),
    );
    const changed = await createSessionIdempotency(
      key,
      parseCreateInput({ ...input, images: [{ ...image, data: "d29ybGQ=" }] }),
    );
    assert.deepEqual(plain, empty);
    assert.isDefined(original);
    assert.isDefined(changed);
    assert.equal(original.keyDigest, changed.keyDigest);
    assert.notEqual(original.inputDigest, changed.inputDigest);
    assert.notDeepEqual(original, plain);
  });

  it("retains queued images and receipts distinguish changed-image retries without image bytes", async () => {
    const item = {
      id: "follow-up-image",
      text: "Inspect this",
      images: [image],
      imageDigest: await sha256Hex(JSON.stringify([image])),
    };
    const changedImages = [{ ...image, data: "d29ybGQ=" }];
    const changedDigest = await sha256Hex(JSON.stringify(changedImages));
    const admitted = enqueueSidecarFollowUp(emptySidecarFollowUps(), item);
    assert.equal(admitted.status, "queued");
    assert.deepEqual(admitted.queue.pending[0]?.images, [image]);
    const confirmed = confirmSidecarFollowUp(admitted.queue, item.id);
    assert.deepEqual(confirmed.pending, []);
    assert.deepEqual(confirmed.receipts[0], {
      id: item.id,
      text: item.text,
      imageDigest: item.imageDigest,
    });
    assert.notInclude(JSON.stringify(confirmed), image.data);
    for (const queue of [admitted.queue, confirmed]) {
      assert.equal(enqueueSidecarFollowUp(queue, item).status, "replay");
      assert.equal(
        enqueueSidecarFollowUp(queue, {
          ...item,
          images: changedImages,
          imageDigest: changedDigest,
        }).status,
        "conflict",
      );
      assert.equal(
        enqueueSidecarFollowUp(queue, { id: item.id, text: item.text }).status,
        "conflict",
      );
    }
  });
  it("rejects persisted image follow-ups without their retry digest", () => {
    assert.ok(
      Result.isFailure(decodeFollowUp({ id: "missing-digest", text: "Inspect", images: [image] })),
    );
    assert.ok(Result.isSuccess(decodeFollowUp({ id: "legacy", text: "No image" })));
  });
  it("bounds queued image bytes without dropping already admitted content", () => {
    const images = [{ ...image, data: "a".repeat(4 * 1024 * 1024) }];
    const first = enqueueSidecarFollowUp(emptySidecarFollowUps(), {
      id: "first",
      text: "First",
      imageDigest: "a".repeat(64),
      images,
    });
    assert.equal(first.status, "queued");
    const second = enqueueSidecarFollowUp(first.queue, {
      id: "second",
      text: "Second",
      images,
      imageDigest: "a".repeat(64),
    });
    assert.equal(second.status, "full");
    assert.strictEqual(second.queue, first.queue);
    assert.equal(second.queue.pending.length, 1);
    const confirmed = confirmSidecarFollowUp(first.queue, "first");
    assert.equal(
      enqueueSidecarFollowUp(confirmed, {
        id: "second",
        text: "Second",
        images,
        imageDigest: "a".repeat(64),
      }).status,
      "queued",
    );
  });
});
