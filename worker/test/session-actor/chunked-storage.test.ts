import { rejects } from "node:assert/strict";
import { assert, describe, it } from "@effect/vitest";
import {
  ChunkedStorageFailure,
  deleteChunkedJson,
  readChunkedJson,
  writeChunkedJson,
} from "../../src/session/chunked-storage";

const makeStorage = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key: string): Promise<unknown> => values.get(key),
    put: async (key: string, value: unknown): Promise<void> => {
      assert.isAtMost(new TextEncoder().encode(JSON.stringify(value)).length, 128 * 1024);
      values.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => values.delete(key),
  };
};

describe("chunked native session storage", () => {
  it("round trips image-bearing metadata within the native per-value limit", async () => {
    const storage = makeStorage();
    const value = {
      prompt: "Compare these pictures",
      images: [{ data: "a".repeat(7_000_000), mimeType: "image/png" }],
    };
    await writeChunkedJson(storage, "metadata", value);
    assert.isAbove(storage.values.size, 1);
    assert.deepEqual(await readChunkedJson(storage, "metadata"), value);
    await writeChunkedJson(storage, "metadata", { prompt: "small" });
    assert.equal(storage.values.size, 1);
    assert.deepEqual(await readChunkedJson(storage, "metadata"), { prompt: "small" });
    await deleteChunkedJson(storage, "metadata");
    assert.equal(storage.values.size, 0);
  });

  it("reads legacy inline values and removes every chunk on delete", async () => {
    const storage = makeStorage();
    storage.values.set("queue", { pending: [] });
    assert.deepEqual(await readChunkedJson(storage, "queue"), { pending: [] });
    await writeChunkedJson(storage, "queue", { text: "😀".repeat(100_000) });
    assert.deepEqual(await readChunkedJson(storage, "queue"), { text: "😀".repeat(100_000) });
    await deleteChunkedJson(storage, "queue");
    assert.equal(storage.values.size, 0);
    assert.isUndefined(await readChunkedJson(storage, "queue"));
  });

  it("rejects missing chunks and malformed manifests", async () => {
    const storage = makeStorage();
    await writeChunkedJson(storage, "queue", { text: "a".repeat(100_000) });
    storage.values.delete("queue:chunk:1");
    await rejects(readChunkedJson(storage, "queue"), ChunkedStorageFailure);
    storage.values.set("queue", { _tag: "ScottyChunkedJsonV1", chunks: 1_000_000, characters: 1 });
    await rejects(readChunkedJson(storage, "queue"), ChunkedStorageFailure);
  });

  it("rejects oversized writes before altering the existing value", async () => {
    const storage = makeStorage();
    storage.values.set("queue", { pending: [] });
    await rejects(
      writeChunkedJson(storage, "queue", { text: "a".repeat(16 * 1024 * 1024) }),
      ChunkedStorageFailure,
    );
    assert.deepEqual(await readChunkedJson(storage, "queue"), { pending: [] });
  });
});
