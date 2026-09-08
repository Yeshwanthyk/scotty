import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import {
  CODEX_MAX_MESSAGE_BYTES,
  CODEX_MAX_TEXT_BYTES,
  decodeCodexClientMessage,
  decodeCodexInitializeResponse,
  decodeCodexInterruptResponse,
  decodeCodexNotification,
  decodeCodexSteerResponse,
  decodeCodexThreadStartResponse,
  decodeCodexTurnStartResponse,
  rejectCodexServerRequest,
} from "../../../protocol/codex-app-server";

const initialize = {
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "scotty", version: "slice-1" },
    capabilities: { experimentalApi: false },
  },
};
const start = {
  id: "start",
  method: "thread/start",
  params: {
    model: "synthetic-model",
    modelProvider: "synthetic",
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ephemeral: true,
  },
};
const turn = {
  id: 2,
  method: "turn/start",
  params: { threadId: "thread-1", input: [{ type: "text", text: "hello" }], effort: "high" },
};
const steer = {
  id: 3,
  method: "turn/steer",
  params: {
    threadId: "thread-1",
    clientUserMessageId: "message-1",
    input: [{ type: "text", text: "continue" }],
    expectedTurnId: "turn-1",
  },
};
const started = { id: "turn-1", status: "inProgress", items: [], error: null };
const terminal = (status: string, error: unknown = null) => ({
  method: "turn/completed",
  params: { threadId: "thread-1", turn: { id: "turn-1", status, items: [], error } },
});
const delta = (text: string) => ({
  method: "item/agentMessage/delta",
  params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: text },
});

const threadResult = {
  thread: { id: "thread-1", path: "/do-not-project", turns: [] },
  model: "synthetic-model",
  modelProvider: "synthetic",
  cwd: "/workspace",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" },
  reasoningEffort: null,
};

// Native 0.153.4 records from the audit's run-high/transcript.json, without field edits.
const nativeNotifications = [
  '{"method":"turn/started","params":{"threadId":"01a0751b-178e-7a11-8df3-17abc4c9c02e","turn":{"id":"01a0751b-17aa-7d32-b994-c88bd49fcc28","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":1788671104,"completedAt":null,"durationMs":null}},"emittedAtMs":1788671104945}',
  '{"method":"item/agentMessage/delta","params":{"threadId":"01a0751b-178e-7a11-8df3-17abc4c9c02e","turnId":"01a0751b-17aa-7d32-b994-c88bd49fcc28","itemId":"msg-audit","delta":"AUDIT_SYNTHETIC_OK"},"emittedAtMs":1788671104958}',
  '{"method":"turn/completed","params":{"threadId":"01a0751b-178e-7a11-8df3-17abc4c9c02e","turn":{"id":"01a0751b-17aa-7d32-b994-c88bd49fcc28","items":[{"type":"agentMessage","id":"msg-audit","text":"AUDIT_SYNTHETIC_OK","phase":null,"memoryCitation":null,"delivery":null,"questions":null}],"itemsView":"summary","status":"completed","error":null,"startedAt":1788671104,"completedAt":1788671104,"durationMs":18}},"emittedAtMs":1788671104958}',
  '{"method":"turn/started","params":{"threadId":"01a0751b-178e-7a11-8df3-17abc4c9c02e","turn":{"id":"01a0751b-17c8-7f90-af91-6c0c1149a099","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":1788671104,"completedAt":null,"durationMs":null}},"emittedAtMs":1788671104968}',
  '{"method":"turn/completed","params":{"threadId":"01a0751b-178e-7a11-8df3-17abc4c9c02e","turn":{"id":"01a0751b-17c8-7f90-af91-6c0c1149a099","items":[],"itemsView":"notLoaded","status":"interrupted","error":null,"startedAt":1788671104,"completedAt":1788671104,"durationMs":11}},"emittedAtMs":1788671104980}',
];

describe("Codex 0.153.4 bounded protocol subset", () => {
  it("carries astra and all six efforts without changing the exact YOLO contract", () => {
    assert.ok(
      Result.isSuccess(
        decodeCodexClientMessage(
          JSON.stringify({
            ...start,
            params: { ...start.params, model: "gpt-6-astra" },
          }),
        ),
      ),
    );
    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      assert.ok(
        Result.isSuccess(
          decodeCodexClientMessage(
            JSON.stringify({
              ...turn,
              params: { ...turn.params, effort },
            }),
          ),
        ),
      );
      assert.ok(
        Result.isSuccess(
          decodeCodexThreadStartResponse(
            JSON.stringify({
              id: 1,
              result: { ...threadResult, model: "gpt-6-astra", reasoningEffort: effort },
            }),
          ),
        ),
      );
    }
  });
  it("accepts unmodified native envelopes and projects only owned fields", () => {
    const decoded = nativeNotifications.map((line) =>
      Result.getOrThrow(decodeCodexNotification(line)),
    );
    assert.deepStrictEqual(
      decoded.map((message) => message.emittedAtMs),
      [1788671104945, 1788671104958, 1788671104958, 1788671104968, 1788671104980],
    );
    assert.deepStrictEqual(
      decoded.map((message) => message.method),
      [
        "turn/started",
        "item/agentMessage/delta",
        "turn/completed",
        "turn/started",
        "turn/completed",
      ],
    );
    assert.deepStrictEqual(
      decoded.map((message) =>
        message.method === "item/agentMessage/delta"
          ? message.params.delta
          : message.method === "turn/started" || message.method === "turn/completed"
            ? message.params.turn.status
            : "unexpected",
      ),
      ["inProgress", "AUDIT_SYNTHETIC_OK", "completed", "inProgress", "interrupted"],
    );
    for (const message of decoded) {
      assert.notInclude(JSON.stringify(message), "itemsView");
      assert.notInclude(JSON.stringify(message), "memoryCitation");
      assert.deepStrictEqual(Object.keys(message).sort(), ["emittedAtMs", "method", "params"]);
    }
  });

  it("bounds optional signed i64 metadata without opening unrelated envelope keys", () => {
    for (const message of [
      delta("x"),
      { method: "turn/started", params: { threadId: "thread-1", turn: started } },
      terminal("completed"),
    ]) {
      assert.isTrue(Result.isSuccess(decodeCodexNotification(JSON.stringify(message))));
      for (const emittedAtMs of [0, 1234, -1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
        const envelope = { ...message, emittedAtMs };
        assert.deepStrictEqual<unknown>(
          Result.getOrThrow(decodeCodexNotification(JSON.stringify(envelope))),
          envelope,
        );
      }
      for (const emittedAtMs of [
        null,
        "1234",
        true,
        {},
        [],
        0.5,
        Number.MIN_SAFE_INTEGER - 1,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        assert.deepStrictEqual<unknown>(
          Result.getFailure(decodeCodexNotification(JSON.stringify({ ...message, emittedAtMs }))),
          Result.getFailure(Result.fail("invalid_message")),
        );
      }
      for (const extra of [
        { id: 1 },
        { jsonrpc: "2.0" },
        { trace: {} },
        { result: {} },
        { emitted_at_ms: 1234 },
        { unexpected: true },
      ]) {
        assert.isTrue(
          Result.isFailure(
            decodeCodexNotification(JSON.stringify({ ...message, emittedAtMs: 1234, ...extra })),
          ),
        );
      }
      for (const literal of ["1e309", "-1e309"]) {
        const line = JSON.stringify({ ...message, emittedAtMs: "TIMESTAMP" }).replace(
          '"TIMESTAMP"',
          literal,
        );
        assert.isTrue(Result.isFailure(decodeCodexNotification(line)));
      }
    }
    const line = JSON.stringify({ ...delta("x"), emittedAtMs: 1234 });
    assert.isTrue(
      Result.isSuccess(decodeCodexNotification(line.padEnd(CODEX_MAX_MESSAGE_BYTES, " "))),
    );
    assert.deepStrictEqual<unknown>(
      Result.getFailure(decodeCodexNotification(line.padEnd(CODEX_MAX_MESSAGE_BYTES + 1, " "))),
      Result.getFailure(Result.fail("message_too_large")),
    );
    assert.isTrue(
      Result.isFailure(decodeCodexInterruptResponse('{"id":1,"result":{},"emittedAtMs":1234}')),
    );
    assert.isTrue(
      Result.isFailure(rejectCodexServerRequest('{"id":1,"method":"approval","emittedAtMs":1234}')),
    );
  });

  it("accepts the explicit component handshake, start, text turn and interrupt", () => {
    for (const message of [
      initialize,
      { method: "initialized" },
      start,
      turn,
      steer,
      { id: 4, method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
    ]) {
      assert.deepStrictEqual<unknown>(
        Result.getOrThrow(decodeCodexClientMessage(JSON.stringify(message))),
        message,
      );
    }
  });

  it("accepts the fenced steer request and only the native turn acknowledgment", () => {
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(decodeCodexClientMessage(JSON.stringify(steer))),
      steer,
    );
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(decodeCodexSteerResponse('{"id":3,"result":{"turnId":"turn-1"}}')),
      { id: 3, result: { turnId: "turn-1" } },
    );
    for (const response of [
      '{"id":3,"result":{"turnId":""}}',
      '{"id":3,"result":{"status":"completed"}}',
    ])
      assert.isTrue(Result.isFailure(decodeCodexSteerResponse(response)));
  });

  it("rejects speculative capabilities, ambient defaults, extra fields and non-text input", () => {
    for (const message of [
      { ...initialize, jsonrpc: "2.0" },
      { ...initialize, params: { ...initialize.params, capabilities: { experimentalApi: true } } },
      { method: "initialized", id: 1 },
      { ...start, params: {} },
      ...["read-only", "workspace-write", "external-sandbox", "unknown", null].map((sandbox) => ({
        ...start,
        params: { ...start.params, sandbox },
      })),
      ...["on-request", "untrusted", null].map((approvalPolicy) => ({
        ...start,
        params: { ...start.params, approvalPolicy },
      })),
      { ...start, params: { ...start.params, config: { api_key: "synthetic-secret" } } },
      { ...turn, params: { ...turn.params, input: [] } },
      { ...turn, params: { ...turn.params, input: [{ type: "image", url: "file:///x" }] } },
      { ...turn, params: { ...turn.params, input: [{ type: "text", text: "" }] } },
      { id: 4, method: "thread/resume", params: { threadId: "x" } },
    ])
      assert.isTrue(Result.isFailure(decodeCodexClientMessage(JSON.stringify(message))));
  });

  it("decodes version-specific initialize fields and strips unowned payload fields", () => {
    const result = {
      userAgent: "codex/0.153.4",
      codexHome: "/isolated/codex",
      platformFamily: "unix",
      platformOs: "macos",
    };
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(
        decodeCodexInitializeResponse(
          JSON.stringify({ id: 1, result: { ...result, token: "synthetic-secret" } }),
        ),
      ),
      { id: 1, result },
    );
    assert.isTrue(
      Result.isFailure(
        decodeCodexInitializeResponse('{"id":1,"result":{"userAgent":"old-shape"}}'),
      ),
    );
    assert.isTrue(Result.isFailure(decodeCodexInitializeResponse('{"id":1,"result":null}')));
  });

  it("retains settings readback but not thread history or arbitrary config", () => {
    const decoded = Result.getOrThrow(
      decodeCodexThreadStartResponse(
        JSON.stringify({
          id: "start",
          result: { ...threadResult, config: { token: "synthetic-secret" } },
        }),
      ),
    );
    assert.deepStrictEqual<unknown>(decoded, {
      id: "start",
      result: { ...threadResult, thread: { id: "thread-1" } },
    });
    for (const sandbox of [
      { type: "readOnly", networkAccess: false },
      { type: "workspaceWrite", networkAccess: true },
      { type: "externalSandbox", networkAccess: "enabled" },
      { type: "externalSandbox", networkAccess: "restricted" },
      { type: "dangerFullAccess", networkAccess: false },
      { type: "unknown" },
      {},
      null,
      undefined,
    ]) {
      assert.isTrue(
        Result.isFailure(
          decodeCodexThreadStartResponse(
            JSON.stringify({ id: "start", result: { ...threadResult, sandbox } }),
          ),
        ),
      );
    }
  });

  it("rejects absent or approval-enabled policy readback", () => {
    for (const approvalPolicy of [undefined, null, "on-request", "untrusted", "unknown"]) {
      assert.isTrue(
        Result.isFailure(
          decodeCodexThreadStartResponse(
            JSON.stringify({ id: "start", result: { ...threadResult, approvalPolicy } }),
          ),
        ),
      );
    }
  });

  it("keeps accepted turn and interrupt acknowledgement separate from terminal evidence", () => {
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(
        decodeCodexTurnStartResponse(JSON.stringify({ id: 2, result: { turn: started } })),
      ),
      { id: 2, result: { turn: started } },
    );
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(decodeCodexInterruptResponse('{"id":3,"result":{}}')),
      { id: 3, result: {} },
    );
    assert.isTrue(
      Result.isFailure(decodeCodexInterruptResponse('{"id":3,"result":{"status":"interrupted"}}')),
    );
    assert.isTrue(
      Result.isFailure(decodeCodexNotification(JSON.stringify(terminal("inProgress")))),
    );
    assert.isTrue(
      Result.isFailure(
        decodeCodexTurnStartResponse(
          JSON.stringify({ id: 2, result: { turn: { ...started, status: "completed" } } }),
        ),
      ),
    );
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(
        decodeCodexNotification(
          JSON.stringify({
            method: "turn/started",
            params: { threadId: "thread-1", turn: started },
          }),
        ),
      ),
      { method: "turn/started", params: { threadId: "thread-1", turn: started } },
    );
  });

  it("decodes text deltas and final message summary without speculative item parity", () => {
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(decodeCodexNotification(JSON.stringify(delta("hello")))),
      delta("hello"),
    );
    const message = terminal("completed");
    const item = { type: "agentMessage", id: "item-1", text: "answer", phase: "final_answer" };
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(
        decodeCodexNotification(
          JSON.stringify({
            ...message,
            params: {
              ...message.params,
              turn: {
                ...message.params.turn,
                items: [{ ...item, memoryCitation: { private: "discard" } }],
              },
            },
          }),
        ),
      ),
      {
        ...message,
        params: { ...message.params, turn: { ...message.params.turn, items: [item] } },
      },
    );
    assert.isTrue(
      Result.isFailure(decodeCodexNotification('{"method":"tool/progress","params":{}}')),
    );
    assert.isTrue(
      Result.isFailure(
        decodeCodexNotification(
          JSON.stringify({
            ...delta("x"),
            params: { threadId: "thread-1", turnId: "turn-1", delta: "x" },
          }),
        ),
      ),
    );
  });

  it("requires honest terminal failure information and rejects unknown statuses", () => {
    for (const message of [
      terminal("completed"),
      terminal("interrupted"),
      terminal("failed", { message: "synthetic failure" }),
    ]) {
      assert.deepStrictEqual<unknown>(
        Result.getOrThrow(decodeCodexNotification(JSON.stringify(message))),
        message,
      );
    }
    for (const message of [
      terminal("failed"),
      terminal("completed", { message: "failure" }),
      terminal("unknown"),
    ]) {
      assert.isTrue(Result.isFailure(decodeCodexNotification(JSON.stringify(message))));
    }
  });

  it("rejects non-object acknowledgements, nonempty started items and oversized terminal summaries", () => {
    for (const result of [null, [], "ok", 1, true]) {
      assert.isTrue(
        Result.isFailure(decodeCodexInterruptResponse(JSON.stringify({ id: 1, result }))),
      );
    }
    const item = { type: "agentMessage", id: "item-1", text: "answer" };
    assert.isTrue(
      Result.isFailure(
        decodeCodexTurnStartResponse(
          JSON.stringify({ id: 2, result: { turn: { ...started, items: [item] } } }),
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decodeCodexTurnStartResponse(
          JSON.stringify({
            id: 2,
            result: { turn: { ...started, error: { message: "not accepted" } } },
          }),
        ),
      ),
    );
    const message = terminal("completed");
    assert.isTrue(
      Result.isFailure(
        decodeCodexNotification(
          JSON.stringify({
            ...message,
            params: { ...message.params, turn: { ...message.params.turn, items: [item, item] } },
          }),
        ),
      ),
    );
  });

  it("preserves request identity without coercion and bounds numeric IDs", () => {
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(decodeCodexInterruptResponse('{"id":"3","result":{}}')),
      { id: "3", result: {} },
    );
    for (const id of [null, true, {}, [], 0.5, Number.MAX_SAFE_INTEGER + 1, "", "x".repeat(257)]) {
      assert.isTrue(
        Result.isFailure(decodeCodexInterruptResponse(JSON.stringify({ id, result: {} }))),
      );
    }
  });

  it("rejects ambiguous envelopes and malformed JSON without echoing input", () => {
    for (const line of [
      "{synthetic-secret",
      "null",
      "[]",
      '{"id":1,"result":{},"error":{"code":1,"message":"x"}}',
      '{"id":1,"method":"turn/start","result":{}}',
      '{"id":1,"result":{}}\n{"id":2,"result":{}}',
    ]) {
      assert.deepStrictEqual<unknown>(
        Result.getFailure(decodeCodexInterruptResponse(line)),
        Result.getFailure(Result.fail("invalid_message")),
      );
    }
    assert.deepStrictEqual<unknown>(
      Result.getOrThrow(
        decodeCodexInterruptResponse(
          '{"id":1,"error":{"code":-32600,"message":"rejected","data":{"secret":"synthetic-secret"}}}',
        ),
      ),
      { id: 1, error: { code: -32600, message: "rejected" } },
    );
  });

  it("rejects every server request without reflecting method, params, trace or secrets", () => {
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/call",
      "account/chatgptAuthTokens/refresh",
      "future/unknown",
    ]) {
      assert.deepStrictEqual<unknown>(
        Result.getOrThrow(
          rejectCodexServerRequest(
            JSON.stringify({
              id: 0,
              method,
              params: { secret: "synthetic-secret" },
              trace: { secret: "synthetic-secret" },
            }),
          ),
        ),
        { id: 0, error: { code: -32601, message: "Unsupported server request" } },
      );
    }
    for (const request of [
      { method: "approve" },
      { id: null, method: "approve" },
      { id: 1, method: "approve", result: {} },
    ]) {
      assert.isTrue(Result.isFailure(rejectCodexServerRequest(JSON.stringify(request))));
    }
  });

  it("bounds UTF-8 fields and whole records before parsing, including ignored payloads", () => {
    assert.isTrue(
      Result.isSuccess(
        decodeCodexNotification(JSON.stringify(delta("x".repeat(CODEX_MAX_TEXT_BYTES)))),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decodeCodexNotification(JSON.stringify(delta("x".repeat(CODEX_MAX_TEXT_BYTES + 1)))),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decodeCodexNotification(
          JSON.stringify(delta("界".repeat(Math.floor(CODEX_MAX_TEXT_BYTES / 3) + 1))),
        ),
      ),
    );
    const exact = '{"id":1,"result":{}}'.padEnd(CODEX_MAX_MESSAGE_BYTES, " ");
    assert.isTrue(Result.isSuccess(decodeCodexInterruptResponse(exact)));
    assert.deepStrictEqual<unknown>(
      Result.getFailure(decodeCodexInterruptResponse(`${exact} `)),
      Result.getFailure(Result.fail("message_too_large")),
    );
    assert.isTrue(
      Result.isFailure(
        rejectCodexServerRequest(
          JSON.stringify({ id: 1, method: "unknown", params: "x".repeat(CODEX_MAX_MESSAGE_BYTES) }),
        ),
      ),
    );
  });
});
