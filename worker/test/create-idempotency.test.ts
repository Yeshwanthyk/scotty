import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { decideIdempotentCreate, type CreateIdempotencyMetadata } from "../src/create-idempotency";
import { makeSessionRecord } from "./support";

const metadata = {
  keyDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
} satisfies CreateIdempotencyMetadata;

describe("create idempotency", () => {
  it("replays the same normalized request without creating another Sandbox", () => {
    const existing = makeSessionRecord({
      id: "aaaaaaaaaaaa",
      status: "provisioning",
      branch: "scotty/aaaaaaaaaaaa",
    });
    assert.deepStrictEqual(decideIdempotentCreate(existing, Option.some(metadata), metadata), {
      kind: "replay",
      record: existing,
    });
  });

  it("rejects key reuse for different input or a vaporized tombstone", () => {
    assert.deepStrictEqual(
      decideIdempotentCreate(
        makeSessionRecord({ id: "aaaaaaaaaaaa", branch: "scotty/aaaaaaaaaaaa" }),
        Option.some(metadata),
        {
          ...metadata,
          inputDigest: "c".repeat(64),
        },
      ),
      { kind: "conflict" },
    );
    assert.deepStrictEqual(
      decideIdempotentCreate(
        makeSessionRecord({
          id: "aaaaaaaaaaaa",
          status: "gone",
          branch: "scotty/aaaaaaaaaaaa",
        }),
        Option.some(metadata),
        metadata,
      ),
      { kind: "conflict" },
    );
  });

  it("preserves legacy random-ID recreation only when no idempotency key is present", () => {
    assert.deepStrictEqual(
      decideIdempotentCreate(
        makeSessionRecord({
          id: "aaaaaaaaaaaa",
          status: "gone",
          branch: "scotty/aaaaaaaaaaaa",
        }),
        Option.none(),
        undefined,
      ),
      { kind: "create" },
    );
    assert.deepStrictEqual(
      decideIdempotentCreate(
        makeSessionRecord({ id: "aaaaaaaaaaaa", branch: "scotty/aaaaaaaaaaaa" }),
        Option.none(),
        undefined,
      ),
      {
        kind: "conflict",
      },
    );
  });
});
