import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLfRecordParser } from "../worker/container/scotty-jsonl.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervisorPath = path.join(root, "worker/container/scotty-pi-session.mjs");

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test("LF record parser preserves JSON Unicode separators and chunk boundaries", () => {
  const records = [];
  const parser = createLfRecordParser((record) => records.push(record.toString("utf8")));
  const unicodeSeparators = `${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2029)}`;
  const first = `{"first":"line${unicodeSeparators}safe"}`;
  const input = Buffer.from(`${first}\n{"second":2}\r\n{"final":true}`);
  parser.push(input.subarray(0, 7));
  parser.push(input.subarray(7, input.length - 5));
  parser.push(input.subarray(input.length - 5));
  parser.end();

  assert.deepEqual(records, [first, '{"second":2}', '{"final":true}']);
});

async function waitForReady(url, supervisor, readStderr) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const response = await fetch(`${url}/health`).catch(() => undefined);
    if (response?.status === 200) return;
    if (supervisor.exitCode !== null)
      throw new Error(
        `supervisor exited with code ${supervisor.exitCode}: ${readStderr() || "no stderr"}`,
      );
    await delay(20);
  }
  throw new Error(`supervisor did not become ready: ${readStderr() || "no stderr"}`);
}

test("Pi session supervisor hydrates, replays commands, and owns extension UI", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "scotty-pi-session-"));
  const piHome = path.join(work, ".pi-agent");
  const fakePi = path.join(work, "fake-pi");
  const tokenFile = path.join(work, "pi-session.token");
  const transportToken = "a".repeat(64);
  await mkdir(piHome, { recursive: true });
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const sessionFile = path.join(piHome, "sessions", "workspace", `${sessionId}.jsonl`);
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, "");
  await writeFile(path.join(piHome, "initial-prompt"), "Start the task");
  await writeFile(tokenFile, transportToken);
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
const messages = [];
let model = { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" };
let thinkingLevel = "high";
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdout.write("{malformed}\\n");
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state")
    output({ id: command.id, type: "response", command: command.type, success: true, data: {
      sessionId: ${JSON.stringify(sessionId)}, isStreaming: false, steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time", messageCount: messages.length, pendingMessageCount: 0,
      model, thinkingLevel, sessionFile: ${JSON.stringify(sessionFile)}
    }});
  else if (command.type === "get_messages")
    output({ id: command.id, type: "response", command: command.type, success: true, data: { messages } });
  else if (command.type === "get_available_models")
    output({ id: command.id, type: "response", command: command.type, success: true, data: {
      models: [model, { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" }]
    }});
  else if (command.type === "get_available_thinking_levels")
    output({ id: command.id, type: "response", command: command.type, success: true, data: {
      levels: ["off", "low", "high"]
    }});
  else if (command.type === "get_commands")
    output({ id: command.id, type: "response", command: command.type, success: true, data: {
      commands: [
        { name: "subagents", description: "Inspect agents", source: "extension" },
        { name: "workflows", description: "Inspect workflows", source: "extension" }
      ]
    }});
  else if (command.type === "set_model") {
    model = { provider: command.provider, id: command.modelId, name: command.modelId };
    output({ id: command.id, type: "response", command: command.type, success: true, data: model });
  } else if (command.type === "set_thinking_level") {
    thinkingLevel = command.level;
    output({ id: command.id, type: "response", command: command.type, success: true });
  }
  else if (command.type === "prompt") {
    if (command.message === "Oversized dialog") {
      output({ id: command.id, type: "response", command: command.type, success: true });
      output({ type: "extension_ui_request", id: "oversized-1", method: "select", title: "Too many", options: Array.from({ length: 101 }, (_, index) => String(index)) });
      return;
    }
    if (command.message === "Race-safe follow-up" && command.streamingBehavior !== "followUp") {
      output({ id: command.id, type: "response", command: command.type, success: false, error: "Agent is already processing a prompt" });
      return;
    }
    const respond = () => {
      const message = { role: "user", content: command.message, timestamp: Date.now() };
      messages.push(message);
      output({ id: command.id, type: "response", command: command.type, success: true });
      output({ type: "message_start", message });
      output({ type: "message_end", message });
      output({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Choose", options: ["A", "B"] });
    };
    if (command.message === "Concurrent once") setTimeout(respond, 75);
    else respond();
  } else if (command.type === "steer")
    output({ id: command.id, type: "response", command: command.type, success: true });
  else if (command.type === "abort") {
    output({ id: command.id, type: "response", command: command.type, success: true });
    output({ type: "agent_end" });
  }
});
`,
  );
  await chmod(fakePi, 0o755);
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const supervisor = spawn(process.execPath, [supervisorPath], {
    cwd: work,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piHome,
      SCOTTY_PI_BINARY: fakePi,
      SCOTTY_PI_SESSION_PORT: String(port),
      SCOTTY_PI_SESSION_TOKEN_FILE: tokenFile,
      SCOTTY_WORKSPACE: work,
      SCOTTY_PI_EXPECTED_PROVIDER: "openai-codex",
      SCOTTY_PI_EXPECTED_MODEL: "gpt-5.4",
      SCOTTY_PI_EXPECTED_EFFORT: "high",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  supervisor.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  t.after(() => {
    supervisor.kill("SIGTERM");
  });

  await waitForReady(url, supervisor, () => stderr);
  assert.equal(
    await access(tokenFile).then(
      () => false,
      () => true,
    ),
    true,
  );
  assert.equal(
    await readFile(path.join(piHome, "initial-prompt.consumed"), "utf8"),
    "Start the task",
  );
  assert.equal(await readFile(path.join(piHome, "scotty-session-id"), "utf8"), `${sessionId}\n`);

  assert.equal((await fetch(`${url}/snapshot`)).status, 401);
  const transportHeaders = { "x-scotty-pi-session": transportToken };
  const snapshot = await (await fetch(`${url}/snapshot`, { headers: transportHeaders })).json();
  assert.equal(snapshot.state.sessionId, sessionId);
  const eventResponse = await fetch(`${url}/events?since=0`, { headers: transportHeaders });
  const eventReader = eventResponse.body.getReader();
  const eventChunk = await eventReader.read();
  await eventReader.cancel();
  assert.match(new TextDecoder().decode(eventChunk.value), /scotty_protocol_error/u);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].role, "user");
  assert.equal(snapshot.messages[0].content, "Start the task");
  assert.deepEqual(
    snapshot.capabilities.models.map((availableModel) => availableModel.id),
    ["gpt-5.4", "claude-sonnet-4"],
  );
  assert.deepEqual(snapshot.capabilities.thinkingLevels, ["off", "low", "high"]);
  assert.deepEqual(
    snapshot.capabilities.commands.map((command) => command.name),
    ["subagents", "workflows"],
  );
  assert.equal(snapshot.pendingUi[0].id, "ask-1");

  let commandSequence = 0;
  const commandEnvelope = (intent) => ({
    epoch: snapshot.epoch,
    commandId: `123e4567-e89b-42d3-a456-${String(++commandSequence).padStart(12, "0")}`,
    expectedSessionRevision: 7,
    intent,
  });

  const setModel = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(
      commandEnvelope({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4" }),
    ),
  });
  assert.equal(setModel.status, 202);
  assert.equal((await setModel.json()).response.data.id, "claude-sonnet-4");

  const setThinking = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(commandEnvelope({ type: "set_thinking_level", level: "low" })),
  });
  assert.equal(setThinking.status, 202);
  const changedSnapshot = await (
    await fetch(`${url}/snapshot`, { headers: transportHeaders })
  ).json();
  assert.equal(changedSnapshot.state.model.id, "claude-sonnet-4");
  assert.equal(changedSnapshot.state.thinkingLevel, "low");

  const steer = commandEnvelope({
    type: "prompt",
    message: "Focus on tests",
    streamingBehavior: "steer",
  });
  const first = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(steer),
  });
  assert.equal(first.status, 202);
  const receipt = await first.json();
  const replay = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(steer),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), receipt);
  const replayedSnapshot = await (
    await fetch(`${url}/snapshot`, { headers: transportHeaders })
  ).json();
  assert.equal(
    replayedSnapshot.messages.filter(
      (message) => message.role === "user" && message.content === "Focus on tests",
    ).length,
    1,
  );

  const concurrentCommand = {
    epoch: snapshot.epoch,
    commandId: "123e4567-e89b-42d3-a456-426614174000",
    expectedSessionRevision: 7,
    intent: { type: "prompt", message: "Concurrent once" },
  };
  const concurrentFirst = fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(concurrentCommand),
  });
  await delay(10);
  const concurrentSame = fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(concurrentCommand),
  });
  const concurrentConflict = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      ...concurrentCommand,
      intent: { type: "prompt", message: "Conflicting write" },
    }),
  });
  const [concurrentFirstResponse, concurrentSameResponse] = await Promise.all([
    concurrentFirst,
    concurrentSame,
  ]);
  assert.equal(concurrentFirstResponse.status, 202);
  assert.equal(concurrentSameResponse.status, 202);
  assert.deepEqual(await concurrentSameResponse.json(), await concurrentFirstResponse.json());
  assert.equal(concurrentConflict.status, 409);
  assert.deepEqual(await concurrentConflict.json(), {
    status: "error",
    code: "command_id_conflict",
    retryable: false,
  });
  const concurrentSnapshot = await (
    await fetch(`${url}/snapshot`, { headers: transportHeaders })
  ).json();
  assert.equal(
    concurrentSnapshot.messages.filter((message) => message.content === "Concurrent once").length,
    1,
  );
  assert.equal(
    concurrentSnapshot.messages.filter((message) => message.content === "Conflicting write").length,
    0,
  );

  const followUp = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(
      commandEnvelope({
        type: "prompt",
        message: "Race-safe follow-up",
        streamingBehavior: "followUp",
      }),
    ),
  });
  assert.equal(followUp.status, 202);

  const abort = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      epoch: snapshot.epoch,
      commandId: "123e4567-e89b-42d3-a456-426614174001",
      expectedSessionRevision: 7,
      intent: { type: "abort" },
    }),
  });
  assert.equal(abort.status, 202);
  const afterAbort = await (await fetch(`${url}/snapshot`, { headers: transportHeaders })).json();
  assert.deepEqual(afterAbort.pendingUi, []);
  assert.deepEqual(afterAbort.activeTools, []);
  assert.deepEqual(afterAbort.queue, { steer: [], followUp: [] });

  await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(commandEnvelope({ type: "prompt", message: "Oversized dialog" })),
  });
  const afterOversizedDialog = await (
    await fetch(`${url}/snapshot`, { headers: transportHeaders })
  ).json();
  assert.deepEqual(afterOversizedDialog.pendingUi, []);
  assert.equal(JSON.stringify(afterOversizedDialog).includes("oversized-1"), false);

  await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(commandEnvelope({ type: "prompt", message: "Ask again" })),
  });
  const answerCommand = commandEnvelope({
    type: "extension_ui_response",
    id: "ask-1",
    value: "A",
  });
  const answer = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(answerCommand),
  });
  assert.equal(answer.status, 202);
  assert.deepEqual(await answer.json(), {
    epoch: snapshot.epoch,
    status: "delivered",
    commandId: answerCommand.commandId,
    commandDigest: await import("../protocol/pi-console-shared.mjs").then(
      ({ commandIntentDigest }) =>
        commandIntentDigest({ type: "extension_ui_response", id: "ask-1", value: "A" }),
    ),
    response: {
      type: "response",
      command: "extension_ui_response",
      delivery: "unconfirmed",
    },
  });
  const pendingAfterDelivery = await (
    await fetch(`${url}/snapshot`, { headers: transportHeaders })
  ).json();
  assert.equal(pendingAfterDelivery.pendingUi[0].id, "ask-1");
  assert.equal(pendingAfterDelivery.pendingUiAuthority.status, "partial");
  const duplicateAnswer = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify(
      commandEnvelope({ type: "extension_ui_response", id: "ask-1", value: "B" }),
    ),
  });
  assert.equal(duplicateAnswer.status, 409);
  assert.deepEqual(await duplicateAnswer.json(), {
    status: "error",
    code: "extension_ui_response_already_delivered",
    retryable: false,
  });
  const quiesce = await fetch(`${url}/quiesce`, {
    method: "POST",
    headers: transportHeaders,
  });
  assert.equal(quiesce.status, 200);
  assert.deepEqual(await quiesce.json(), { status: "quiesced" });
  const quiescedHealth = await fetch(`${url}/health`);
  assert.equal(quiescedHealth.status, 409);
  assert.deepEqual(await quiescedHealth.json(), { status: "quiescing" });
  assert.equal(stderr, "");
});

test("Pi session supervisor resumes the exact session it previously owned", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "scotty-pi-continuity-"));
  const piHome = path.join(work, ".pi-agent");
  const sessionId = "123e4567-e89b-42d3-a456-426614174001";
  const sessionFile = path.join(piHome, "sessions", "workspace", `${sessionId}.jsonl`);
  const fakePi = path.join(work, "fake-pi");
  const argsFile = path.join(work, "pi-args.json");
  const tokenFile = path.join(work, "pi-session.token");
  const transportToken = "b".repeat(64);
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, "");
  await writeFile(path.join(piHome, "scotty-session-id"), `${sessionId}\n`);
  await writeFile(tokenFile, transportToken);
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") output({ id: command.id, type: "response", command: command.type, success: true, data: {
    sessionId: ${JSON.stringify(sessionId)}, sessionFile: ${JSON.stringify(sessionFile)}, isStreaming: false,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", messageCount: 0,
    pendingMessageCount: 0, model: null, thinkingLevel: "off"
  }});
  else if (command.type === "get_messages") output({ id: command.id, type: "response", command: command.type, success: true, data: { messages: [] }});
  else if (command.type === "get_available_models") output({ id: command.id, type: "response", command: command.type, success: true, data: { models: [] }});
  else if (command.type === "get_available_thinking_levels") output({ id: command.id, type: "response", command: command.type, success: true, data: { levels: [] }});
  else if (command.type === "get_commands") output({ id: command.id, type: "response", command: command.type, success: true, data: { commands: [] }});
});
`,
  );
  await chmod(fakePi, 0o755);
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const supervisor = spawn(process.execPath, [supervisorPath], {
    cwd: work,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piHome,
      SCOTTY_PI_BINARY: fakePi,
      SCOTTY_PI_SESSION_PORT: String(port),
      SCOTTY_PI_SESSION_TOKEN_FILE: tokenFile,
      SCOTTY_WORKSPACE: work,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  supervisor.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  t.after(() => supervisor.kill("SIGTERM"));

  await waitForReady(url, supervisor, () => stderr);
  assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [
    "--mode",
    "rpc",
    "--session",
    sessionId,
  ]);
  assert.equal(stderr, "");
});

for (const [key, value] of [
  ["SCOTTY_PI_EXPECTED_PROVIDER", "other"],
  ["SCOTTY_PI_EXPECTED_MODEL", "other"],
  ["SCOTTY_PI_EXPECTED_EFFORT", "low"],
])
  test(
    `Pi supervisor rejects ${key} mismatch before consuming initial prompt`,
    { timeout: 10000 },
    async (t) => {
      const work = await mkdtemp(path.join(tmpdir(), "scotty-pi-selection-"));
      const piHome = path.join(work, ".pi-agent");
      await mkdir(piHome);
      const tokenFile = path.join(piHome, "token");
      await writeFile(tokenFile, "selection-test-token-".repeat(3), { mode: 0o600 });
      const promptPath = path.join(piHome, "initial-prompt");
      await writeFile(promptPath, "Do not consume this prompt");
      const fakePi = path.join(work, "pi.mjs");
      await writeFile(
        fakePi,
        `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(${JSON.stringify(path.join(work, "commands"))}, line + "\\n");
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { model: { provider: "openai-codex", id: "gpt-5.4" }, thinkingLevel: "high" } }) + "\\n");
});
`,
      );
      await chmod(fakePi, 0o755);
      const supervisor = spawn(process.execPath, [supervisorPath], {
        cwd: work,
        env: {
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: piHome,
          SCOTTY_PI_BINARY: fakePi,
          SCOTTY_PI_SESSION_PORT: String(await unusedPort()),
          SCOTTY_PI_SESSION_TOKEN_FILE: tokenFile,
          SCOTTY_WORKSPACE: work,
          [key]: value,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      t.after(() => supervisor.kill("SIGKILL"));
      await once(supervisor, "exit");
      assert.equal(await readFile(promptPath, "utf8"), "Do not consume this prompt");
      const commands = (await readFile(path.join(work, "commands"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(
        commands.map((command) => command.type),
        ["get_state"],
      );
    },
  );

for (const fixture of [
  {
    name: "Hatch descriptor rejection",
    extensionPath: "/opt/scotty/pi-packages/sources/scotty-hatch/index.ts",
    error: "Scotty Hatch restore request failed with HTTP 403",
    failure: { phase: "descriptor", httpStatus: 403 },
  },
  {
    name: "unclassified Hatch error",
    extensionPath: "/opt/scotty/pi-packages/sources/scotty-hatch/index.ts",
    error: "PRIVATE_ERROR_MUST_NOT_ESCAPE",
    failure: { phase: "unknown" },
  },
  {
    name: "unrelated extension error",
    extensionPath: "/opt/scotty/pi-packages/sources/another-extension/index.ts",
    error: "Scotty Hatch restore request failed with HTTP 403",
    failure: undefined,
  },
])
  test(`Pi readiness does not mask ${fixture.name}`, { timeout: 10000 }, async (t) => {
    const work = await mkdtemp(path.join(tmpdir(), "scotty-hatch-startup-"));
    const piHome = path.join(work, ".pi-agent");
    await mkdir(piHome);
    const tokenFile = path.join(piHome, "token");
    await writeFile(tokenFile, "synthetic-health-token".repeat(3), { mode: 0o600 });
    const promptPath = path.join(piHome, "initial-prompt");
    await writeFile(promptPath, "Initial task");
    const fakePi = path.join(work, "pi.mjs");
    await writeFile(
      fakePi,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
const output = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "get_state") output(${JSON.stringify({ type: "extension_error", event: "session_start", extensionPath: fixture.extensionPath, error: fixture.error })});
  output({ id: command.id, type: "response", command: command.type, success: true, data: {} });
});
`,
    );
    await chmod(fakePi, 0o755);
    const port = await unusedPort();
    const supervisor = spawn(process.execPath, [supervisorPath], {
      cwd: work,
      env: {
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: piHome,
        SCOTTY_PI_BINARY: fakePi,
        SCOTTY_PI_SESSION_PORT: String(port),
        SCOTTY_PI_SESSION_TOKEN_FILE: tokenFile,
        SCOTTY_WORKSPACE: work,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(async () => {
      supervisor.kill("SIGTERM");
      await once(supervisor, "exit");
    });
    let observed;
    for (let attempt = 0; attempt < 250; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
      if (response) {
        const body = await response.json();
        if (body.status === "ready" || body.status === "failed") {
          observed = { status: response.status, body };
          break;
        }
      }
      await delay(20);
    }
    assert.ok(observed);
    if (fixture.failure) {
      assert.deepEqual(observed, {
        status: 503,
        body: { status: "failed", reason: "hatch_restore_failed", hatchRestore: fixture.failure },
      });
      assert.equal(await readFile(promptPath, "utf8"), "Initial task");
      assert.equal(JSON.stringify(observed).includes(fixture.error), false);
    } else {
      assert.equal(observed.status, 200);
      assert.equal(observed.body.status, "ready");
    }
  });
