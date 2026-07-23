import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { SessionRecord } from "../src/contracts";
import { decideIdempotentCreate, type CreateIdempotencyMetadata } from "../src/create-idempotency";

const metadata = {
  keyDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
} satisfies CreateIdempotencyMetadata;

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 1,
  id: "aaaaaaaaaaaa",
  status: "warm",
  operation: null,
  repo: "anomalyco/rift",
  repoExistsAtCreate: true,
  defaultBranch: "dev",
  branch: "scotty/aaaaaaaaaaaa",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  hardCapAt: "2026-01-01T04:00:00.000Z",
  hardCapDurationSeconds: 14_400,
  ownedBackupIds: [],
  ...overrides,
});

describe("create idempotency", () => {
  it("replays the same normalized request without creating another Sandbox", () => {
    const existing = record({ status: "booting" });
    assert.deepStrictEqual(decideIdempotentCreate(existing, Option.some(metadata), metadata), {
      kind: "replay",
      record: existing,
    });
  });

  it("rejects key reuse for different input or a vaporized tombstone", () => {
    assert.deepStrictEqual(
      decideIdempotentCreate(record(), Option.some(metadata), {
        ...metadata,
        inputDigest: "c".repeat(64),
      }),
      { kind: "conflict" },
    );
    assert.deepStrictEqual(
      decideIdempotentCreate(record({ status: "gone" }), Option.some(metadata), metadata),
      { kind: "conflict" },
    );
  });

  it("preserves legacy random-ID recreation only when no idempotency key is present", () => {
    assert.deepStrictEqual(
      decideIdempotentCreate(record({ status: "gone" }), Option.none(), undefined),
      { kind: "create" },
    );
    assert.deepStrictEqual(decideIdempotentCreate(record(), Option.none(), undefined), {
      kind: "conflict",
    });
  });
});
