#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { access, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const port = Number.parseInt(process.env.SCOTTY_PI_SESSION_PORT ?? "43117", 10);
const workspace = process.env.SCOTTY_WORKSPACE ?? process.cwd();
const piHome = process.env.PI_CODING_AGENT_DIR;
const piBinary = process.env.SCOTTY_PI_BINARY ?? "pi";
const tokenFile = process.env.SCOTTY_PI_SESSION_TOKEN_FILE;
const epoch = randomUUID();
const maxEvents = 2_000;
const maxReceipts = 200;
const maxBodyBytes = 64 * 1024;
const requestTimeoutMs = 30_000;
const blockingUiMethods = new Set(["select", "confirm", "input", "editor"]);
const commandTypes = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "extension_ui_response",
  "set_model",
  "set_thinking_level",
]);

if (!Number.isInteger(port) || port < 1024 || port > 65_535)
  throw new Error("SCOTTY_PI_SESSION_PORT must be a valid unprivileged port");
if (!piHome) throw new Error("PI_CODING_AGENT_DIR is required");
if (!tokenFile) throw new Error("SCOTTY_PI_SESSION_TOKEN_FILE is required");

const transportToken = (await readFile(tokenFile, "utf8")).trim();
if (transportToken.length < 32) throw new Error("Pi session capability is invalid");
await unlink(tokenFile);

let sequence = 0;
let ready = false;
let closing = false;
let quiescing = false;
let stdoutBuffer = "";
let stderrTail = "";
const events = [];
const subscribers = new Set();
const pendingRequests = new Map();
const pendingUi = new Map();
const receipts = new Map();

const initialPromptPath = resolve(piHome, "initial-prompt");
const consumedPromptPath = resolve(piHome, "initial-prompt.consumed");
const hasInitialPrompt = await access(initialPromptPath).then(
  () => true,
  () => false,
);
const piArgs = ["--mode", "rpc"];
if (!hasInitialPrompt) piArgs.push("--continue");

const childEnv = { ...process.env };
delete childEnv.SCOTTY_PI_BINARY;
delete childEnv.SCOTTY_PI_SESSION_TOKEN_FILE;
const child = spawn(piBinary, piArgs, {
  cwd: workspace,
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});

const jsonResponse = (response, status, value) => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
};

const writeSse = (response, envelope) => {
  response.write(`id: ${envelope.sequence}\n`);
  response.write(`data: ${JSON.stringify(envelope)}\n\n`);
};

const appendEvent = (event) => {
  const envelope = { epoch, sequence: ++sequence, event };
  events.push(envelope);
  if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
  for (const response of subscribers) writeSse(response, envelope);
  return envelope;
};

const rememberReceipt = (commandId, receipt) => {
  receipts.delete(commandId);
  receipts.set(commandId, receipt);
  while (receipts.size > maxReceipts) receipts.delete(receipts.keys().next().value);
};

const sendRpc = (command, id = `scotty-${randomUUID()}`) =>
  new Promise((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      rejectRequest(new Error(`Pi RPC request timed out: ${command.type}`));
    }, requestTimeoutMs);
    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolveRequest(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        rejectRequest(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      pendingRequests.delete(id);
      rejectRequest(error);
    });
  });

const sendRpcWithoutResponse = (command) =>
  new Promise((resolveRequest, rejectRequest) => {
    child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) rejectRequest(error);
      else resolveRequest();
    });
  });

const handlePiMessage = (message) => {
  if (typeof message?.id === "string" && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);
    pending.resolve(message);
    return;
  }
  if (
    message?.type === "extension_ui_request" &&
    typeof message.id === "string" &&
    blockingUiMethods.has(message.method)
  ) {
    if (quiescing)
      child.stdin.write(
        `${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`,
      );
    else pendingUi.set(message.id, message);
  }
  appendEvent(message);
};

createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handlePiMessage(JSON.parse(trimmed));
  } catch {
    stdoutBuffer = `${stdoutBuffer}${trimmed}\n`.slice(-8_192);
    appendEvent({ type: "scotty_protocol_error", stream: "stdout" });
  }
});

child.stderr.on("data", (chunk) => {
  stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
});

child.on("exit", (code, signal) => {
  ready = false;
  appendEvent({ type: "scotty_process_exit", code, signal });
  for (const pending of pendingRequests.values())
    pending.reject(new Error("Pi RPC process exited"));
  pendingRequests.clear();
  if (!closing) setTimeout(() => process.exit(code ?? 1), 10);
});

child.on("error", (error) => {
  ready = false;
  stderrTail = `${stderrTail}${error.message}`.slice(-8_192);
});

const readJsonBody = async (request) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const hasTransportCapability = (request) => {
  const supplied = request.headers["x-scotty-pi-session"];
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(transportToken);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const snapshot = async () => {
  const baseSequence = sequence;
  const [stateResponse, messagesResponse, modelsResponse, thinkingLevelsResponse] =
    await Promise.all([
      sendRpc({ type: "get_state" }),
      sendRpc({ type: "get_messages" }),
      sendRpc({ type: "get_available_models" }).catch(() => undefined),
      sendRpc({ type: "get_available_thinking_levels" }).catch(() => undefined),
    ]);
  if (stateResponse.success === false || messagesResponse.success === false)
    throw new Error("Pi RPC snapshot failed");
  const endSequence = sequence;
  return {
    epoch,
    sequence: endSequence,
    state: stateResponse.data ?? stateResponse.state ?? stateResponse,
    messages: messagesResponse.data?.messages ?? messagesResponse.messages ?? [],
    capabilities: {
      models:
        modelsResponse?.success === false
          ? []
          : (modelsResponse?.data?.models ?? modelsResponse?.models ?? []),
      thinkingLevels:
        thinkingLevelsResponse?.success === false
          ? []
          : (thinkingLevelsResponse?.data?.levels ?? thinkingLevelsResponse?.levels ?? []),
    },
    events: events.filter(
      (envelope) => envelope.sequence > baseSequence && envelope.sequence <= endSequence,
    ),
    pendingUi: [...pendingUi.values()],
  };
};

const quiesce = async () => {
  quiescing = true;
  for (const request of pendingUi.values())
    await sendRpcWithoutResponse({
      type: "extension_ui_response",
      id: request.id,
      cancelled: true,
    });
  pendingUi.clear();
  let stateResponse = await sendRpc({ type: "get_state" });
  if (stateResponse.success === false) throw new Error("Pi RPC quiesce state failed");
  if (stateResponse.data?.isStreaming) {
    const abortResponse = await sendRpc({ type: "abort" });
    if (abortResponse.success === false) throw new Error("Pi RPC abort failed");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    stateResponse = await sendRpc({ type: "get_state" });
    if (stateResponse.success === true && !stateResponse.data?.isStreaming) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Pi RPC quiesce timed out");
};

const handleCommand = async (body) => {
  if (quiescing) return { status: 409, body: { error: "pi_quiescing" } };
  if (
    typeof body?.commandId !== "string" ||
    body.commandId.length < 1 ||
    body.commandId.length > 100 ||
    !body?.command ||
    !commandTypes.has(body.command.type)
  )
    return { status: 400, body: { error: "invalid_command" } };
  const replay = receipts.get(body.commandId);
  if (replay) return { status: 200, body: replay };

  if (
    body.command.type === "extension_ui_response" &&
    (typeof body.command.id !== "string" || !pendingUi.has(body.command.id))
  )
    return { status: 409, body: { error: "extension_ui_not_pending" } };

  let response;
  if (body.command.type === "extension_ui_response") {
    await sendRpcWithoutResponse(body.command);
    pendingUi.delete(body.command.id);
    response = { type: "response", command: "extension_ui_response", success: true };
  } else {
    const rpcId = `ui-${body.commandId}`;
    response = await sendRpc(body.command, rpcId);
  }
  const receipt = {
    status: response.success === false ? "rejected" : "accepted",
    commandId: body.commandId,
    response,
  };
  rememberReceipt(body.commandId, receipt);
  return { status: response.success === false ? 409 : 202, body: receipt };
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(
        response,
        ready ? 200 : 503,
        ready
          ? { status: "ready", epoch }
          : { status: "starting", stderr: stderrTail ? "available" : "empty" },
      );
    }
    if (!hasTransportCapability(request))
      return jsonResponse(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && url.pathname === "/snapshot") {
      if (!ready) return jsonResponse(response, 503, { error: "pi_not_ready" });
      return jsonResponse(response, 200, await snapshot());
    }
    if (request.method === "GET" && url.pathname === "/events") {
      if (!ready) return jsonResponse(response, 503, { error: "pi_not_ready" });
      response.writeHead(200, {
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      });
      const requestedEpoch = url.searchParams.get("epoch");
      const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
      if (requestedEpoch && requestedEpoch !== epoch)
        writeSse(response, {
          epoch,
          sequence,
          event: { type: "scotty_epoch_changed" },
        });
      else {
        if (
          Number.isFinite(since) &&
          since > 0 &&
          events.length > 0 &&
          events[0].sequence > since + 1
        )
          writeSse(response, {
            epoch,
            sequence,
            event: { type: "scotty_replay_gap" },
          });
        for (const envelope of events)
          if (envelope.sequence > (Number.isFinite(since) ? since : 0))
            writeSse(response, envelope);
      }
      subscribers.add(response);
      const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        subscribers.delete(response);
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/command") {
      if (!ready) return jsonResponse(response, 503, { error: "pi_not_ready" });
      const result = await handleCommand(await readJsonBody(request));
      return jsonResponse(response, result.status, result.body);
    }
    if (request.method === "POST" && url.pathname === "/quiesce") {
      if (!ready) return jsonResponse(response, 503, { error: "pi_not_ready" });
      await quiesce();
      return jsonResponse(response, 200, { status: "quiesced" });
    }
    return jsonResponse(response, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request_failed";
    const status = message === "request_too_large" ? 413 : 502;
    return jsonResponse(response, status, { error: message });
  }
});

const close = (signal) => {
  if (closing) return;
  closing = true;
  ready = false;
  server.close();
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
  child.once("exit", () => {
    clearTimeout(force);
    process.exit(0);
  });
};

process.on("SIGTERM", () => close("SIGTERM"));
process.on("SIGINT", () => close("SIGINT"));

server.listen(port, "0.0.0.0", async () => {
  try {
    const stateResponse = await sendRpc({ type: "get_state" });
    if (stateResponse.success === false) throw new Error("Pi RPC state initialization failed");
    if (hasInitialPrompt) {
      const initialPrompt = await readFile(initialPromptPath, "utf8");
      await rename(initialPromptPath, consumedPromptPath);
      const promptResponse = await sendRpc({ type: "prompt", message: initialPrompt });
      if (promptResponse.success === false) throw new Error("Pi rejected the initial prompt");
    }
    ready = true;
  } catch (error) {
    stderrTail = `${stderrTail}${error instanceof Error ? error.message : String(error)}`.slice(
      -8_192,
    );
    close("SIGTERM");
  }
});
