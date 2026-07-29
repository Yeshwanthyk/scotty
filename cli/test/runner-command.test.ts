import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Match } from "effect";
import type { RunnerFrame, RunnerResponse } from "../../protocol/runner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "scotty-runner-command-"));
  temporaryDirectories.push(path);
  return path;
};

describe("runner serve", () => {
  test("connects outbound and completes the local retained-workspace lifecycle", async () => {
    const root = await temporaryDirectory();
    const responses: RunnerResponse[] = [];
    const completed = Promise.withResolvers<void>();
    let authorization: string | null = null;
    let pathname = "";

    const server = Bun.serve({
      port: 0,
      fetch: (request, bunServer) => {
        const url = new URL(request.url);
        pathname = url.pathname;
        authorization = request.headers.get("authorization");
        if (bunServer.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open: () => undefined,
        message: (webSocket, message) => {
          const frame = JSON.parse(String(message)) as RunnerFrame;
          Match.value(frame).pipe(
            Match.tagsExhaustive({
              RunnerHello: () =>
                webSocket.send(
                  JSON.stringify({
                    _tag: "EnsureRuntime",
                    version: 2,
                    sessionId: "session-a",
                    operationId: "ensure-initial",
                  }),
                ),
              RunnerProbeAck: () => undefined,
              RunnerProtocolRejected: () => undefined,
              RunnerFailure: (response) => {
                responses.push(response);
                return undefined;
              },
              RunnerSuccess: (response) => {
                responses.push(response);
                return Match.value(response.operationId).pipe(
                  Match.when("ensure-initial", () =>
                    webSocket.send(
                      JSON.stringify({
                        _tag: "ExecRuntime",
                        version: 2,
                        sessionId: "session-a",
                        operationId: "write-marker",
                        argv: [
                          process.execPath,
                          "-e",
                          "require('node:fs').writeFileSync('marker.txt', 'retained')",
                        ],
                      }),
                    ),
                  ),
                  Match.when("write-marker", () =>
                    webSocket.send(
                      JSON.stringify({
                        _tag: "StopRuntime",
                        version: 2,
                        sessionId: "session-a",
                        operationId: "stop",
                      }),
                    ),
                  ),
                  Match.when("stop", () =>
                    webSocket.send(
                      JSON.stringify({
                        _tag: "EnsureRuntime",
                        version: 2,
                        sessionId: "session-a",
                        operationId: "ensure-restored",
                      }),
                    ),
                  ),
                  Match.when("ensure-restored", () =>
                    webSocket.send(
                      JSON.stringify({
                        _tag: "ExecRuntime",
                        version: 2,
                        sessionId: "session-a",
                        operationId: "read-marker",
                        argv: [
                          process.execPath,
                          "-e",
                          "process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))",
                        ],
                      }),
                    ),
                  ),
                  Match.when("read-marker", () =>
                    webSocket.send(
                      JSON.stringify({
                        _tag: "RemoveRuntime",
                        version: 2,
                        sessionId: "session-a",
                        operationId: "remove",
                      }),
                    ),
                  ),
                  Match.when("remove", () => completed.resolve()),
                  Match.option,
                );
              },
            }),
          );
        },
      },
    });

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "scotty.ts"),
        "runner",
        "serve",
        "--name",
        "example-runner",
        "--root",
        root,
        "--isolation",
        "process",
        "--host",
        `http://127.0.0.1:${server.port}`,
      ],
      {
        cwd: join(import.meta.dir, "..", ".."),
        env: { ...process.env, SCOTTY_RUNNER_TOKEN: "runner-secret" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    try {
      await completed.promise;
      expect(pathname).toBe("/api/runners/example-runner/connect");
      expect(authorization).toBe("Bearer runner-secret");
      expect(responses.map((response) => response.operationId)).toEqual([
        "ensure-initial",
        "write-marker",
        "stop",
        "ensure-restored",
        "read-marker",
        "remove",
      ]);
      const read = responses.find((response) => response.operationId === "read-marker");
      expect(read).toMatchObject({
        _tag: "RunnerSuccess",
        result: { _tag: "ExecRuntimeResult", stdout: "retained" },
      });
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      server.stop(true);
    }
    expect(await new Response(child.stdout).text()).toBe(
      '{"runner":"example-runner","status":"connected"}\n',
    );
    expect(await new Response(child.stderr).text()).toBe("");
  }, 10_000);
});
