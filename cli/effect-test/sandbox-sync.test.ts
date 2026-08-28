import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { createDeterministicTarGz } from "../src/sandbox-archive.ts";
import { CliError, EXIT } from "../src/core.ts";
import type { BuiltSandboxBundle } from "../src/sandbox-bundle.ts";
import { synchronizeSandboxBundle } from "../src/sandbox-sync.ts";
import { HttpTransport } from "../src/services.ts";

const failure = (result: CliError | unknown): CliError => {
  assert.instanceOf(result, CliError);
  return result;
};

const sampleBuilt = (): BuiltSandboxBundle => {
  const built = createDeterministicTarGz([
    {
      path: "manifest.json",
      type: "file",
      modeClass: "regular",
      bytes: new TextEncoder().encode('{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
    },
  ]);
  return {
    digest: built.digest,
    bytes: built.archive.byteLength,
    fileCount: 1,
    manifest: { schemaVersion: 1, skills: [], piPackages: [] },
    archive: built.archive,
  };
};

const target = { host: "https://worker.example", token: "root-token" } as const;

describe("sandbox sync transport", () => {
  it.effect("skips upload when remote digest already matches", () =>
    Effect.gen(function* () {
      const built = sampleBuilt();
      let putCalls = 0;
      const layer = Layer.succeed(HttpTransport)({
        fetch: (input, init) =>
          Effect.sync(() => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.pathname === "/api/sandbox/configuration")
              return Response.json({
                schemaVersion: 1,
                revision: 2,
                activeDigest: built.digest,
              });
            if (url.pathname.startsWith("/api/sandbox/bundles/")) putCalls++;
            return Response.json(
              { error: { code: "not_found", message: "missing" } },
              { status: 404 },
            );
          }),
      });
      const remote = yield* synchronizeSandboxBundle({ target, built }).pipe(Effect.provide(layer));
      assert.strictEqual(remote.status, "synchronized");
      assert.strictEqual(remote.activeDigest, built.digest);
      assert.strictEqual(putCalls, 0);
    }),
  );

  it.effect("maps activation conflicts to sandbox_bundle_activation_conflict", () =>
    Effect.gen(function* () {
      const built = sampleBuilt();
      const layer = Layer.succeed(HttpTransport)({
        fetch: (input, init) =>
          Effect.sync(() => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.pathname === "/api/sandbox/configuration")
              return Response.json({ schemaVersion: 1, revision: 0, activeDigest: null });
            return Response.json(
              {
                error: {
                  code: "conflict",
                  message: "Sandbox configuration revision conflict",
                  hint: "Retry scotty sync.",
                },
              },
              { status: 409 },
            );
          }),
      });
      const result = yield* synchronizeSandboxBundle({ target, built }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      assert.strictEqual(failure(result).code, "sandbox_bundle_activation_conflict");
    }),
  );

  it.effect("maps fetch failures to sandbox_bundle_unavailable", () =>
    Effect.gen(function* () {
      const built = sampleBuilt();
      const layer = Layer.succeed(HttpTransport)({
        fetch: () =>
          Effect.tryPromise({
            try: () => Promise.reject(new TypeError("network down")),
            catch: () =>
              new CliError(
                "network_error",
                "Could not reach the Scotty Worker",
                "Check --host and your network, then retry.",
                EXIT.GENERIC,
              ),
          }),
      });
      const result = yield* synchronizeSandboxBundle({ target, built }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      assert.strictEqual(failure(result).code, "sandbox_bundle_unavailable");
    }),
  );
});
