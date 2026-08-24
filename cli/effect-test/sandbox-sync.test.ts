import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { ScottyConfig } from "../../protocol/sandbox-config";
import { CliError } from "../src/core.ts";
import { buildSandboxBundle } from "../src/sandbox-prepare.ts";
import { synchronizeSandboxBundle } from "../src/sandbox-sync.ts";
import { HttpTransport } from "../src/services.ts";

const config: ScottyConfig = {
  schemaVersion: 1,
  installation: { name: "home", cloudflareAccountId: "account-1" },
  pi: {
    defaultProvider: "openai",
    defaultModel: "gpt-5.6-sol",
    defaultThinkingLevel: "medium",
  },
  plugins: [
    {
      id: "cloudflare",
      type: "compute-provider",
      enabled: true,
      source: { kind: "builtin", name: "cloudflare" },
    },
  ],
  sandboxSetup: { piExtensions: [], skills: [], sandboxTools: [] },
};

const CLIENT_CREDENTIAL = `scotty_client.0123456789ab.${"a".repeat(32)}`;
const target = { host: "https://worker.example", credential: CLIENT_CREDENTIAL } as const;

interface PreparedSnapshotBody {
  readonly pluginBundleDigest: string;
}

interface ActivationBody {
  readonly snapshotDigest: string;
  readonly configDigest: string;
}

const status = (revision: number, snapshotDigest: string | null, configDigest?: string) => ({
  schemaVersion: 1,
  installationName: revision === 0 ? null : "home",
  cloudflareAccountId: revision === 0 ? null : "account-1",
  revision,
  activeSnapshot:
    snapshotDigest === null
      ? null
      : {
          revision,
          snapshotDigest,
          configDigest: configDigest ?? `sha256:${"b".repeat(64)}`,
          syncId: `sync-${revision}`,
          activatedAt: "2026-08-24T00:00:00.000Z",
        },
});

describe("sandbox snapshot sync", () => {
  it.effect("does not upload when the active immutable snapshot already matches", () =>
    Effect.gen(function* () {
      const active = yield* buildSandboxBundle(config, 2);
      let putCalls = 0;
      let cookie: string | null = null;
      let authorization: string | null = null;
      const layer = Layer.succeed(HttpTransport)({
        fetch: (input, init) =>
          Effect.sync(() => {
            const request = new Request(input, init);
            if (request.method === "PUT") putCalls += 1;
            cookie = request.headers.get("cookie");
            authorization = request.headers.get("authorization");
            return Response.json(status(2, active.snapshotDigest, active.configDigest));
          }),
      });
      const synchronized = yield* synchronizeSandboxBundle({
        target,
        config,
        approveActivation: () => Effect.void,
      }).pipe(Effect.provide(layer));
      assert.strictEqual(synchronized.remote.status, "synchronized");
      assert.strictEqual(synchronized.remote.activeSnapshotDigest, active.snapshotDigest);
      assert.strictEqual(putCalls, 0);
      assert.strictEqual(cookie, `__Host-scotty=${CLIENT_CREDENTIAL}`);
      assert.strictEqual(authorization, null);
    }),
  );

  it.effect("prepares both immutable inputs before activation", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let preparedSnapshotDigest = "";
      let preparedPluginDigest = "";
      const layer = Layer.succeed(HttpTransport)({
        fetch: (input, init) =>
          Effect.promise(async () => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            calls.push(`${request.method} ${url.pathname}`);
            if (request.method === "GET") return Response.json(status(0, null));
            if (url.pathname.includes("/plugin-bundles/")) {
              preparedPluginDigest = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
              return Response.json({ ok: true });
            }
            if (url.pathname.includes("/snapshots/")) {
              preparedSnapshotDigest = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
              const body = JSON.parse(await request.text()) as PreparedSnapshotBody;
              return Response.json({
                snapshotDigest: preparedSnapshotDigest,
                pluginBundleDigest: body.pluginBundleDigest,
              });
            }
            const body = JSON.parse(await request.text()) as ActivationBody;
            return Response.json(status(1, body.snapshotDigest, body.configDigest));
          }),
      });
      const synchronized = yield* synchronizeSandboxBundle({
        target,
        config,
        approveActivation: (plan) =>
          Effect.sync(() => {
            calls.push("APPROVE");
            assert.strictEqual(plan.currentRevision, 0);
            assert.strictEqual(plan.nextRevision, 1);
            assert.strictEqual(plan.plugins[0]?.source, "builtin:cloudflare");
          }),
      }).pipe(Effect.provide(layer));
      assert.strictEqual(preparedPluginDigest, synchronized.built.pluginBundleDigest);
      assert.strictEqual(preparedSnapshotDigest, synchronized.built.snapshotDigest);
      assert.deepStrictEqual(
        calls.map((call) => call.split(" ")[0]),
        ["GET", "APPROVE", "PUT", "PUT", "POST"],
      );
    }),
  );

  it.effect("does not upload or activate when approval is refused", () =>
    Effect.gen(function* () {
      let mutationCalls = 0;
      const layer = Layer.succeed(HttpTransport)({
        fetch: (input, init) =>
          Effect.sync(() => {
            const request = new Request(input, init);
            if (request.method !== "GET") mutationCalls += 1;
            return Response.json(status(0, null));
          }),
      });
      const refused = new CliError("cancelled", "cancelled", "unchanged", 2);
      const failure = yield* synchronizeSandboxBundle({
        target,
        config,
        approveActivation: () => Effect.fail(refused),
      }).pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(failure, refused);
      assert.strictEqual(mutationCalls, 0);
    }),
  );

  it.effect("does not attempt activation when snapshot preparation fails", () =>
    Effect.gen(function* () {
      let activationCalls = 0;
      const oldDigest = `sha256:${"c".repeat(64)}`;
      const layer = Layer.succeed(HttpTransport)({
        fetch: (input, init) =>
          Effect.sync(() => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (request.method === "GET") return Response.json(status(4, oldDigest));
            if (url.pathname.includes("/plugin-bundles/")) return Response.json({ ok: true });
            if (url.pathname.endsWith("/activate")) activationCalls += 1;
            return Response.json(
              { error: { code: "upstream", message: "snapshot write failed", hint: "retry" } },
              { status: 502 },
            );
          }),
      });
      const error = yield* synchronizeSandboxBundle({
        target,
        config,
        approveActivation: () => Effect.void,
      }).pipe(Effect.provide(layer), Effect.flip);
      assert.ok(error instanceof CliError);
      assert.strictEqual(error.code, "sandbox_bundle_upload_failed");
      assert.strictEqual(activationCalls, 0);
    }),
  );
});
