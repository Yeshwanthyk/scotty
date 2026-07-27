import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Match } from "effect";
import { EXIT, main, type CliDependencies } from "../scotty";
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
                    version: 1,
                    sessionId: "session-a",
                    operationId: "ensure-initial",
                  }),
                ),
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
                        version: 1,
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
                        version: 1,
                        sessionId: "session-a",
                        operationId: "stop",
                      }),
                    ),
                  ),
                  Match.when("stop", () =>
                    webSocket.send(
                      JSON.stringify({
                        _tag: "EnsureRuntime",
                        version: 1,
                        sessionId: "session-a",
                        operationId: "ensure-restored",
                      }),
                    ),
                  ),
                  Match.when("ensure-restored", () =>
                    webSocket.send(
                      JSON.stringify({
                        _tag: "ExecRuntime",
                        version: 1,
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
                        version: 1,
                        sessionId: "session-a",
                        operationId: "remove",
                      }),
                    ),
                  ),
                  Match.when("remove", () => webSocket.close(1000, "complete")),
                  Match.option,
                );
              },
            }),
          );
        },
      },
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const dependencies: Partial<CliDependencies> = {
      env: { SCOTTY_RUNNER_TOKEN: "runner-secret" },
      home: root,
      cwd: root,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };

    try {
      const exitCode = await main(
        [
          "runner",
          "serve",
          "--name",
          "slumbers",
          "--root",
          root,
          "--isolation",
          "process",
          "--host",
          `http://127.0.0.1:${server.port}`,
        ],
        dependencies,
      );

      expect(exitCode).toBe(EXIT.OK);
      expect(pathname).toBe("/api/runners/slumbers/connect");
      expect(authorization).toBe("Bearer runner-secret");
      expect(stdout.join("")).toBe('{"runner":"slumbers","status":"connected"}\n');
      expect(stderr).toEqual([]);
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
      server.stop(true);
    }
  });
});
