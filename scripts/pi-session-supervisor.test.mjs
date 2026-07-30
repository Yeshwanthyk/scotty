import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

async function waitForReady(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${url}/health`).catch(() => undefined);
    if (response?.status === 200) return;
    await delay(20);
  }
  throw new Error("supervisor did not become ready");
}

test("Pi session supervisor hydrates, replays commands, and owns extension UI", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "scotty-pi-session-"));
  const piHome = path.join(work, ".pi-agent");
  const fakePi = path.join(work, "fake-pi");
  const tokenFile = path.join(work, "pi-session.token");
  const transportToken = "a".repeat(64);
  await mkdir(piHome, { recursive: true });
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
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state")
    output({ id: command.id, type: "response", command: command.type, success: true, data: {
      sessionId: "pi-session-1", isStreaming: false, steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time", messageCount: messages.length, pendingMessageCount: 0,
      model, thinkingLevel
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
  else if (command.type === "set_model") {
    model = { provider: command.provider, id: command.modelId, name: command.modelId };
    output({ id: command.id, type: "response", command: command.type, success: true, data: model });
  } else if (command.type === "set_thinking_level") {
    thinkingLevel = command.level;
    output({ id: command.id, type: "response", command: command.type, success: true });
  }
  else if (command.type === "prompt") {
    if (command.message === "Race-safe follow-up" && command.streamingBehavior !== "followUp") {
      output({ id: command.id, type: "response", command: command.type, success: false, error: "Agent is already processing a prompt" });
      return;
    }
    messages.push({ role: "user", content: command.message });
    output({ id: command.id, type: "response", command: command.type, success: true });
    output({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Choose", options: ["A", "B"] });
  } else if (command.type === "steer")
    output({ id: command.id, type: "response", command: command.type, success: true });
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
  t.after(() => {
    supervisor.kill("SIGTERM");
  });

  await waitForReady(url);
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

  assert.equal((await fetch(`${url}/snapshot`)).status, 401);
  const transportHeaders = { "x-scotty-pi-session": transportToken };
  const snapshot = await (await fetch(`${url}/snapshot`, { headers: transportHeaders })).json();
  assert.equal(snapshot.state.sessionId, "pi-session-1");
  assert.deepEqual(snapshot.messages, [{ role: "user", content: "Start the task" }]);
  assert.deepEqual(
    snapshot.capabilities.models.map((availableModel) => availableModel.id),
    ["gpt-5.4", "claude-sonnet-4"],
  );
  assert.deepEqual(snapshot.capabilities.thinkingLevels, ["off", "low", "high"]);
  assert.equal(snapshot.pendingUi[0].id, "ask-1");

  const setModel = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      commandId: "model-1",
      command: { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4" },
    }),
  });
  assert.equal(setModel.status, 202);
  assert.equal((await setModel.json()).response.data.id, "claude-sonnet-4");

  const setThinking = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      commandId: "thinking-1",
      command: { type: "set_thinking_level", level: "low" },
    }),
  });
  assert.equal(setThinking.status, 202);
  const changedSnapshot = await (
    await fetch(`${url}/snapshot`, { headers: transportHeaders })
  ).json();
  assert.equal(changedSnapshot.state.model.id, "claude-sonnet-4");
  assert.equal(changedSnapshot.state.thinkingLevel, "low");

  const steer = {
    commandId: "steer-1",
    command: { type: "steer", message: "Focus on tests" },
  };
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

  const followUp = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      commandId: "follow-up-1",
      command: {
        type: "prompt",
        message: "Race-safe follow-up",
        streamingBehavior: "followUp",
      },
    }),
  });
  assert.equal(followUp.status, 202);

  const answer = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      commandId: "answer-1",
      command: { type: "extension_ui_response", id: "ask-1", value: "A" },
    }),
  });
  assert.equal(answer.status, 202);
  const duplicateAnswer = await fetch(`${url}/command`, {
    method: "POST",
    headers: { ...transportHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      commandId: "answer-2",
      command: { type: "extension_ui_response", id: "ask-1", value: "B" },
    }),
  });
  assert.equal(duplicateAnswer.status, 409);
  assert.equal(stderr, "");
});
