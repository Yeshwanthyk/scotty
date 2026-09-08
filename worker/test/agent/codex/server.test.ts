import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Predicate, Result, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CodexHostError } from "../../../src/agent/codex/errors";
import {
  CODEX_CONTROL_TOKEN_HEADER,
  CODEX_CONTROL_GENERATION_HEADER,
  CodexAdmission,
  CodexBridgeError,
  makeCodexRuntime,
  startCodexRuntime,
  readCodexSnapshot,
} from "../../../src/agent/codex/runtime";
import { makeCodexControl, serveCodexControl } from "../../../src/agent/codex/server";
import { consumeControlToken } from "../../../src/agent/codex/token-file";
import { managedPiAccessToken } from "../../../src/credentials/managed";

const token = "a".repeat(64);
const headers = {
  [CODEX_CONTROL_TOKEN_HEADER]: token,
  [CODEX_CONTROL_GENERATION_HEADER]: "generation-1",
};
const decodeAdmission = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexAdmission));
const decodeError = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String, outcome: Schema.String })),
);
const fixture = Effect.fnUntraced(function* () {
  const terminal = yield* Deferred.make<
    {
      readonly id: string;
      readonly status: "completed";
      readonly items: ReadonlyArray<{
        readonly type: "agentMessage";
        readonly id: string;
        readonly text: string;
      }>;
    },
    CodexHostError
  >();
  const closed =
    yield* Deferred.make<Effect.Success<Parameters<typeof makeCodexRuntime>[0]["stop"]>>();
  let ready = true;
  let calls = 0;
  let stops = 0;
  let failure: CodexHostError["code"] | null = null;
  const stop = yield* Effect.cached(
    Effect.gen(function* () {
      ready = false;
      stops++;
      yield* Deferred.fail(terminal, new CodexHostError({ code: "stopped" }));
      const receipt = {
        cleanup: "ambiguous",
        descendants: "unverified",
        parent: "exited",
        shutdown: "eof",
        exit: { code: 0, signal: null },
        failure,
      } as const;
      yield* Deferred.succeed(closed, receipt);
      return receipt;
    }),
  );
  const host: Parameters<typeof makeCodexRuntime>[0] = {
    prompt: () =>
      Effect.sync(() => {
        calls++;
        return { turnId: "turn", completed: Deferred.await(terminal) };
      }),
    steer: () => Effect.succeed({ turnId: "turn" }),
    interrupt: Deferred.await(terminal),
    stop,
    closed: Deferred.await(closed),
    drainEvents: () => [],
    inspect: () => ({
      ready,
      threadId: "thread",
      activeTurnId: null,
      failure,
      pid: ChildProcessSpawner.ProcessId(1),
      homes: { home: "/runtime/home", codexHome: "/runtime/codex-home", cwd: "/workspace" },
      settings: {
        thread: { id: "thread" },
        model: "gpt-5.4",
        modelProvider: "scotty-managed",
        cwd: "/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: "high",
      },
      discarded: 0,
      rejected: 0,
      stderrBytes: 0,
      eventCount: 0,
      tools: [],
      toolsTruncated: false,
      sequence: 0,
    }),
  };
  const runtime = yield* makeCodexRuntime(host, "generation-1");
  return {
    runtime,
    calls: () => calls,
    stops: () => stops,
    complete: Deferred.succeed(terminal, {
      id: "turn",
      status: "completed",
      items: [{ type: "agentMessage", id: "answer", text: "synthetic answer" }],
    }),
    fail: Effect.gen(function* () {
      failure = "unexpected_exit";
      ready = false;
      yield* Deferred.fail(terminal, new CodexHostError({ code: "unexpected_exit" }));
      yield* stop;
    }),
  };
});

const exchange = Effect.fnUntraced(function* (
  port: number,
  method: "GET" | "POST",
  path: string,
  body?: string,
  extra = headers,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.make(method)(`http://127.0.0.1:${port}${path}`, {
      headers: extra,
      ...(body === undefined ? {} : { body: HttpBody.text(body, "application/json") }),
    }),
  );
  return { status: response.status, text: yield* response.text };
});

const listening = Effect.fnUntraced(function* () {
  const f = yield* fixture();
  const address = yield* serveCodexControl(f.runtime, token, 0);
  assert.ok(Predicate.isTagged(address, "TcpAddress"));
  return { ...f, port: address.port };
});

describe("private Codex production HTTP adapter", () => {
  it.effect(
    "bounds chunked bodies before admission even when the native reader closes the socket",
    () =>
      Effect.gen(function* () {
        const f = yield* listening();
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .execute(
            HttpClientRequest.post(`http://127.0.0.1:${f.port}/prompt`, {
              headers,
              body: HttpBody.stream(
                Stream.make(new TextEncoder().encode("x".repeat(300000))),
                "application/json",
              ),
            }),
          )
          .pipe(Effect.result);
        assert.ok(Result.isFailure(response));
        assert.equal(f.calls(), 0);
        assert.equal((yield* exchange(f.port, "GET", "/health")).status, 200);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("executes launch, native JSONL adapter and HTTP read/stop with a synthetic child", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const workspace = `${root}/workspace`;
      yield* fs.makeDirectory(workspace);
      const binary = `${root}/synthetic-codex.mjs`;
      yield* fs.writeFileString(
        binary,
        `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{userAgent:'scotty-component/0.153.4 fixture',codexHome:process.env.CODEX_HOME,platformFamily:'unix',platformOs:process.platform === 'darwin' ? 'macos' : 'linux'}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'},model:'gpt-5.4',modelProvider:'scotty-managed',cwd:process.cwd(),approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'},reasoningEffort:'high'}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn',status:'inProgress',items:[]}}});
    send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn',status:'inProgress',items:[]}}});
    send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',id:'answer',text:'synthetic child answer'}]}}});
  }
});
`,
        { mode: 0o700 },
      );
      const runtime = yield* startCodexRuntime({
        generation: "generation-1",
        launch: {
          binary,
          runtimeDir: `${root}/runtime`,
          workspace,
          model: "gpt-5.4",
          effort: "high",
          credential: {
            sentinel: managedPiAccessToken("scotty-managed://openai/openai-codex/access"),
            expiresAt: Number.MAX_SAFE_INTEGER,
          },
        },
      });
      const address = yield* serveCodexControl(runtime, token, 0);
      assert.ok(Predicate.isTagged(address, "TcpAddress"));
      assert.equal((yield* exchange(address.port, "GET", "/health")).status, 200);
      const admission = yield* exchange(
        address.port,
        "POST",
        "/prompt",
        JSON.stringify({ threadId: "thread", text: "synthetic prompt" }),
      );
      assert.equal(admission.status, 202);
      const response = yield* exchange(address.port, "GET", "/snapshot");
      const snapshot = yield* readCodexSnapshot(response.text, {
        generation: "generation-1",
        threadId: "thread",
        turnId: "turn",
      });
      assert.deepEqual(snapshot.prompt, {
        status: "terminal",
        turnId: "turn",
        outcome: "completed",
        text: "synthetic child answer",
      });
      const receipt = yield* runtime.stop;
      assert.equal(receipt.shutdown, "eof");
      assert.equal(receipt.parent, "exited");
      assert.equal(receipt.cleanup, "ambiguous");
    }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
  );

  it.effect(
    "authenticates health, fences generation and returns native admission before terminal",
    () =>
      Effect.gen(function* () {
        const f = yield* listening();
        const health = yield* exchange(f.port, "GET", "/health");
        assert.equal(health.status, 200);
        const proof = yield* readCodexSnapshot(health.text, { generation: "generation-1" });
        assert.equal(proof.threadId, "thread");
        for (const bad of [
          { ...headers, [CODEX_CONTROL_TOKEN_HEADER]: "b".repeat(64) },
          { ...headers, [CODEX_CONTROL_TOKEN_HEADER]: "short" },
          { ...headers, [CODEX_CONTROL_GENERATION_HEADER]: "old" },
        ]) {
          const response = yield* exchange(
            f.port,
            "POST",
            "/prompt",
            JSON.stringify({ threadId: "thread", text: "hello" }),
            bad,
          );
          assert.ok([401, 409].includes(response.status));
          assert.equal(response.text.includes(token), false);
        }
        assert.equal(f.calls(), 0);
        const accepted = yield* exchange(
          f.port,
          "POST",
          "/prompt",
          JSON.stringify({ threadId: "thread", text: "hello" }),
        );
        assert.equal(accepted.status, 202);
        assert.deepEqual(yield* decodeAdmission(accepted.text), {
          generation: "generation-1",
          threadId: "thread",
          turnId: "turn",
        });
        const running = yield* exchange(f.port, "GET", "/snapshot");
        assert.equal(
          (yield* readCodexSnapshot(running.text, { generation: "generation-1" })).prompt.status,
          "running",
        );
        const steered = yield* exchange(
          f.port,
          "POST",
          "/message",
          JSON.stringify({
            mode: "steer",
            threadId: "thread",
            text: "adjust",
            expectedTurnId: "turn",
            clientUserMessageId: "steer-1",
          }),
        );
        assert.equal(steered.status, 202);
        assert.deepEqual(yield* decodeAdmission(steered.text), {
          generation: "generation-1",
          threadId: "thread",
          turnId: "turn",
        });
        const busy = yield* exchange(
          f.port,
          "POST",
          "/prompt",
          JSON.stringify({ threadId: "thread", text: "again" }),
        );
        assert.equal(busy.status, 409);
        assert.equal((yield* decodeError(busy.text)).error, "busy");
        yield* f.complete;
        yield* TestClock.adjust(1);
        const read = yield* exchange(f.port, "GET", "/snapshot");
        assert.deepEqual(
          (yield* readCodexSnapshot(read.text, { generation: "generation-1", threadId: "thread" }))
            .prompt,
          { status: "terminal", turnId: "turn", outcome: "completed", text: "synthetic answer" },
        );
        assert.equal(f.calls(), 1);
        const stopped = yield* exchange(f.port, "POST", "/stop");
        assert.equal(stopped.status, 200);
        assert.equal(stopped.text.includes('"cleanup":"ambiguous"'), true);
        assert.equal((yield* exchange(f.port, "GET", "/health")).status, 503);
        assert.equal((yield* exchange(f.port, "GET", "/snapshot")).status, 200);
        assert.equal(f.stops(), 1);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect(
    "rejects missing token on every route, URL credentials, wrong thread and invalid/oversized bodies",
    () =>
      Effect.gen(function* () {
        const f = yield* listening();
        for (const path of ["/health", "/snapshot", "/prompt", "/message", "/interrupt", "/stop"]) {
          const response = yield* exchange(f.port, "GET", path, undefined, {
            ...headers,
            [CODEX_CONTROL_TOKEN_HEADER]: "",
          });
          assert.equal(response.status, 401);
        }
        assert.equal((yield* exchange(f.port, "GET", `/snapshot?token=${token}`)).status, 404);
        for (const [body, status] of [
          [JSON.stringify({ threadId: "wrong", text: "hello" }), 409],
          ["not-json", 400],
          [JSON.stringify({ threadId: "thread", text: "x".repeat(300000) }), 400],
          [JSON.stringify({ threadId: "thread", text: "hello", extra: true }), 400],
        ] as const) {
          const result = yield* exchange(f.port, "POST", "/prompt", body);
          assert.equal(result.status, status);
        }
        assert.equal(f.calls(), 0);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("returns the completed race outcome without stopping the native host", () =>
    Effect.gen(function* () {
      const f = yield* listening();
      const admitted = yield* exchange(
        f.port,
        "POST",
        "/prompt",
        JSON.stringify({ threadId: "thread", text: "hello" }),
      );
      assert.equal(admitted.status, 202);
      yield* f.complete;
      yield* TestClock.adjust(1);
      const interrupted = yield* exchange(
        f.port,
        "POST",
        "/interrupt",
        JSON.stringify({ threadId: "thread", turnId: "turn" }),
      );
      assert.equal(interrupted.status, 202);
      assert.equal(JSON.parse(interrupted.text).status, "completed");
      assert.equal(f.stops(), 0);
      assert.equal((yield* exchange(f.port, "GET", "/health")).status, 200);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("host failure remains readable and unavailable, never a successful terminal", () =>
    Effect.gen(function* () {
      const f = yield* listening();
      yield* exchange(
        f.port,
        "POST",
        "/prompt",
        JSON.stringify({ threadId: "thread", text: "hello" }),
      );
      yield* f.fail;
      yield* TestClock.adjust(1);
      assert.equal((yield* exchange(f.port, "GET", "/health")).status, 503);
      const response = yield* exchange(f.port, "GET", "/snapshot");
      const proof = yield* readCodexSnapshot(response.text, { generation: "generation-1" });
      assert.equal(proof.failure, "unexpected_exit");
      assert.equal(proof.prompt.status, "failed");
      assert.equal(proof.cleanup?.cleanup, "ambiguous");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("maps invalid snapshot to a bounded typed error without leaking raw input", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const control = yield* makeCodexControl(
        {
          ...f.runtime,
          snapshot: Effect.fail(
            new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" }),
          ),
        },
        token,
      );
      const response = yield* control.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("http://localhost/snapshot", { headers })),
        ),
      );
      assert.equal(response.status, 502);
    }),
  );

  it.effect("bounds serialized responses even if a downstream snapshot exceeds its contract", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const control = yield* makeCodexControl(
        {
          ...f.runtime,
          snapshot: f.runtime.snapshot.pipe(
            Effect.map((proof) => ({ ...proof, failure: "x".repeat(600000) })),
          ),
        },
        token,
      );
      const response = yield* control.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("http://localhost/snapshot", { headers })),
        ),
      );
      assert.equal(response.status, 502);
      const body = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
      assert.deepEqual(yield* decodeError(body), {
        error: "invalid_snapshot",
        outcome: "ambiguous",
      });
      assert.ok(body.length < 100);
    }),
  );

  it.effect(
    "HTTP deadline returns ambiguity without pretending an admitted operation was cancelled",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const control = yield* makeCodexControl({ ...f.runtime, admit: () => Effect.never }, token);
        const responseFiber = yield* control.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/prompt", {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({ threadId: "thread", text: "hello" }),
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* TestClock.adjust(20001);
        const response = yield* Fiber.join(responseFiber);
        assert.equal(response.status, 504);
        const web = HttpServerResponse.toWeb(response);
        const body = yield* Effect.promise(() => web.text());
        assert.deepEqual(yield* decodeError(body), {
          error: "request_timeout",
          outcome: "ambiguous",
        });
      }),
  );
});

describe("native bounded private token-file ingress", () => {
  for (const mode of ["valid", "public", "symlink", "oversized", "workspace"] as const)
    it.effect(`handles ${mode} without credential output`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const workspace = `${root}/workspace`;
        const privateDir = `${root}/control`;
        yield* fs.makeDirectory(workspace, { mode: 0o700 });
        yield* fs.makeDirectory(privateDir, { mode: 0o700 });
        const path = `${mode === "workspace" ? workspace : privateDir}/token`;
        yield* fs.writeFileString(`${privateDir}/source`, token, { mode: 0o600 });
        if (mode === "symlink") yield* fs.symlink(`${privateDir}/source`, path);
        else
          yield* fs.writeFileString(path, mode === "oversized" ? token.repeat(100) : token, {
            mode: mode === "public" ? 0o644 : 0o600,
          });
        const result = yield* Effect.result(consumeControlToken(path, workspace));
        assert.equal(Result.isSuccess(result), mode === "valid");
        assert.equal(yield* fs.exists(path), mode !== "valid");
        assert.equal(yield* fs.exists(`${privateDir}/source`), true);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
});
