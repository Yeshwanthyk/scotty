import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { describe, it } from "node:test";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installationDeployment = join(repositoryRoot, "cli/src/installation-deployment.ts");
const alchemyRequire = createRequire(import.meta.resolve("alchemy"));
const runtimeRoot = dirname(alchemyRequire.resolve("@alchemy.run/cloudflare-runtime/package.json"));
const { Workerd, WorkerdLive } = await import(
  pathToFileURL(join(runtimeRoot, "dist/core/node/workerd/Workerd.mjs")).href
);
const workerdBinary = join(runtimeRoot, "node_modules/workerd/bin/workerd");

const unavailableWorkerdReason = await access(workerdBinary, constants.X_OK).then(
  () => undefined,
  () => `platform workerd binary is unavailable or not executable: ${workerdBinary}`,
);

describe("lazy workerd loading", () => {
  it(
    "evaluates the compiled installation deployment graph outside the project",
    { timeout: 120_000 },
    async () => {
      const buildRoot = await mkdtemp(join(tmpdir(), "scotty-workerd-lazy-build-"));
      const runRoot = await mkdtemp(join(tmpdir(), "scotty-workerd-lazy-run-"));
      const home = join(runRoot, "home");
      const cwd = join(runRoot, "empty-cwd");
      const fixture = join(buildRoot, "fixture.ts");
      const binary = join(buildRoot, process.platform === "win32" ? "fixture.exe" : "fixture");
      try {
        await Promise.all([mkdir(home), mkdir(cwd)]);
        await writeFile(
          fixture,
          [
            `import * as deployment from ${JSON.stringify(installationDeployment)};`,
            'if (typeof deployment.planInstallation !== "function") throw new Error("deployment graph missing");',
            'process.stdout.write("installation deployment imported\\n");',
            "",
          ].join("\n"),
        );
        const compiled = await execute("bun", [
          "build",
          fixture,
          "--compile",
          "--external",
          "workerd",
          "--outfile",
          binary,
        ]);
        assert.doesNotMatch(`${compiled.stdout}${compiled.stderr}`, /module not found|\$bunfs/u);

        const evaluated = spawnSync(binary, [], {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            NODE_PATH: "",
          },
        });
        assert.equal(evaluated.status, 0, evaluated.stderr);
        assert.equal(evaluated.stdout, "installation deployment imported\n");
        assert.equal(evaluated.stderr, "");
        assert.doesNotMatch(
          `${evaluated.stdout}${evaluated.stderr}`,
          /workerd|module not found|\$bunfs/iu,
        );
      } finally {
        await Promise.all([
          rm(buildRoot, { recursive: true, force: true }),
          rm(runRoot, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it(
    "builds WorkerdLive and serves a 200 pong response",
    { skip: unavailableWorkerdReason, timeout: 30_000 },
    async () => {
      const services = Layer.provide(WorkerdLive, NodeServices.layer);
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          const workerd = yield* Workerd;
          const ports = yield* workerd.serve({
            sockets: [
              {
                name: "test",
                address: "127.0.0.1:0",
                service: { name: "test" },
              },
            ],
            services: [
              {
                name: "test",
                worker: {
                  compatibilityDate: workerd.compatibilityDate,
                  modules: [
                    {
                      name: "main.js",
                      esModule: 'export default { fetch: () => new Response("pong") };',
                    },
                  ],
                },
              },
            ],
          });
          return yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${ports.test}`));
        }).pipe(Effect.provide(services), Effect.scoped),
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "pong");
    },
  );
});
