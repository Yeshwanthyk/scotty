#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { access, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createLfRecordParser } from "./scotty-jsonl.mjs";
import {
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_EVENTS,
  PI_CONSOLE_MAX_MESSAGES,
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  commandIntentDigest,
  completeSnapshotOverlap,
  createPendingUiTracker,
  createProjectionReducer,
  filterRemoteCommands,
  normalizeCommand,
  normalizeExtensionUiEvent,
  sanitizeRemoteEvent,
  sanitizeRemoteString,
  sanitizeRemoteValue,
  shouldEmitSseHeartbeat,
} from "./scotty-pi-protocol.mjs";

const port = Number.parseInt(process.env.SCOTTY_PI_SESSION_PORT ?? "43117", 10);
const workspace = process.env.SCOTTY_WORKSPACE ?? process.cwd();
const piHome = process.env.PI_CODING_AGENT_DIR;
const piBinary = process.env.SCOTTY_PI_BINARY ?? "pi";
const tokenFile = process.env.SCOTTY_PI_SESSION_TOKEN_FILE;
const epoch = randomUUID();
const maxEvents = PI_CONSOLE_MAX_EVENTS;
const maxReceipts = 200;
const maxBodyBytes = PI_CONSOLE_MAX_COMMAND_BYTES;
const requestTimeoutMs = 30_000;
const blockingUiMethods = new Set(["select", "confirm", "input", "editor"]);
const pendingUiSettlementEvents = new Set([
  "agent_abort",
  "agent_aborted",
  "agent_end",
  "agent_settled",
  "turn_abort",
  "turn_aborted",
  "turn_end",
]);
const snapshotAttempts = 3;

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
const receipts = new Map();
const inFlightCommands = new Map();
const projectionReducer = createProjectionReducer();
const pendingUi = createPendingUiTracker({
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: (timer) => clearTimeout(timer),
  onExpire: (id) => appendEvent({ type: "scotty_extension_ui_expired", id }),
  onOverflow: (id) =>
    child.stdin.write(
      `${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`,
    ),
});

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
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > PI_CONSOLE_MAX_RESPONSE_BYTES) {
    status = 502;
    body = JSON.stringify({ error: "response_too_large" });
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
};

const writeSse = (response, envelope) => {
  response.write(`id: ${envelope.sequence}\n`);
  response.write(`data: ${JSON.stringify(envelope)}\n\n`);
};

const appendEvent = (event) => {
  const envelope = { epoch, sequence: ++sequence, event: sanitizeRemoteEvent(event) };
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
  const normalizedMessage = normalizeExtensionUiEvent(message);
  if (normalizedMessage === undefined) return;
  projectionReducer.reduce(normalizedMessage);
  if (
    normalizedMessage?.type === "extension_ui_request" &&
    typeof normalizedMessage.id === "string" &&
    blockingUiMethods.has(normalizedMessage.method)
  ) {
    if (quiescing)
      child.stdin.write(
        `${JSON.stringify({ type: "extension_ui_response", id: normalizedMessage.id, cancelled: true })}\n`,
      );
    else pendingUi.track(normalizedMessage);
  }
  if (
    normalizedMessage?.type === "extension_ui_response" ||
    normalizedMessage?.type === "extension_ui_cancelled" ||
    normalizedMessage?.type === "extension_ui_closed"
  )
    pendingUi.remove(normalizedMessage.id);
  if (pendingUiSettlementEvents.has(normalizedMessage?.type)) pendingUi.clear();
  appendEvent(normalizedMessage);
};

const stdoutRecords = createLfRecordParser((record) => {
  const text = record.toString("utf8");
  if (!text.trim()) return;
  try {
    handlePiMessage(JSON.parse(text));
  } catch {
    stdoutBuffer = `${stdoutBuffer}${text}\n`.slice(-8_192);
    appendEvent({ type: "scotty_protocol_error", stream: "stdout" });
  }
});
child.stdout.on("data", (chunk) => stdoutRecords.push(chunk));
child.stdout.on("end", () => stdoutRecords.end());

child.stderr.on("data", (chunk) => {
  stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
});

child.on("exit", (code, signal) => {
  ready = false;
  pendingUi.clear();
  projectionReducer.clearVolatile();
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

const projectSnapshotModels = (modelsResponse) => {
  const models =
    modelsResponse?.success === false
      ? []
      : (modelsResponse?.data?.models ?? modelsResponse?.models ?? []);
  return (Array.isArray(models) ? models : []).slice(0, 100).map((model) => ({
    provider: sanitizeRemoteString(String(model?.provider ?? "unknown")) || "unknown",
    id: sanitizeRemoteString(String(model?.id ?? "unknown")) || "unknown",
    ...(typeof model?.name === "string" ? { name: sanitizeRemoteString(model.name) } : {}),
  }));
};
const projectSnapshotThinkingLevels = (thinkingLevelsResponse) =>
  thinkingLevelsResponse?.success === false
    ? []
    : (thinkingLevelsResponse?.data?.levels ?? thinkingLevelsResponse?.levels ?? [])
        .filter(
          (level) =>
            typeof level === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(level),
        )
        .slice(0, 20);
const projectSnapshotCommands = (commandsResponse) =>
  filterRemoteCommands(
    commandsResponse?.success === false
      ? []
      : (commandsResponse?.data?.commands ?? commandsResponse?.commands ?? []),
  );
const projectSnapshotCapabilities = (modelsResponse, thinkingLevelsResponse, commandsResponse) => ({
  models: projectSnapshotModels(modelsResponse),
  thinkingLevels: projectSnapshotThinkingLevels(thinkingLevelsResponse),
  commands: projectSnapshotCommands(commandsResponse),
});

const projectSnapshotResponse = ({
  snapshotEpoch,
  baseSequence,
  endSequence,
  stateResponse,
  messagesResponse,
  overlapEvents,
  projection,
  pendingUi,
  modelsResponse,
  thinkingLevelsResponse,
  commandsResponse,
}) => {
  const rawMessages = messagesResponse.data?.messages ?? messagesResponse.messages ?? [];
  const messages = Array.isArray(rawMessages) ? rawMessages.slice(-PI_CONSOLE_MAX_MESSAGES) : [];
  const sanitizedState = sanitizeRemoteValue(
    stateResponse.data ?? stateResponse.state ?? stateResponse,
  );
  const sanitizedMessages = sanitizeRemoteValue(messages);
  return {
    epoch: snapshotEpoch,
    baseSequence,
    sequence: endSequence,
    state: sanitizedState.value,
    messages: sanitizedMessages.value,
    overlapEvents,
    activeTools: projection.activeTools,
    queue: projection.queue,
    pendingUi,
    pendingUiAuthority: {
      status: "partial",
      reason: "pi_0_83_signal_cancellation_unobservable",
    },
    extensionSurface: projection.extensionSurface,
    capabilities: projectSnapshotCapabilities(
      modelsResponse,
      thinkingLevelsResponse,
      commandsResponse,
    ),
    truncated: {
      messages: Array.isArray(rawMessages) && rawMessages.length > PI_CONSOLE_MAX_MESSAGES,
      values: sanitizedState.truncated || sanitizedMessages.truncated,
    },
  };
};

const snapshotAttempt = async () => {
  const baseSequence = sequence;
  const [
    stateResponse,
    messagesResponse,
    modelsResponse,
    thinkingLevelsResponse,
    commandsResponse,
  ] = await Promise.all([
    sendRpc({ type: "get_state" }),
    sendRpc({ type: "get_messages" }),
    sendRpc({ type: "get_available_models" }).catch(() => undefined),
    sendRpc({ type: "get_available_thinking_levels" }).catch(() => undefined),
    sendRpc({ type: "get_commands" }).catch(() => undefined),
  ]);
  if (stateResponse.success === false || messagesResponse.success === false)
    throw new Error("Pi RPC snapshot failed");
  const endSequence = sequence;
  const overlapEvents = completeSnapshotOverlap(events, baseSequence, endSequence);
  if (!overlapEvents) return undefined;
  return projectSnapshotResponse({
    snapshotEpoch: epoch,
    baseSequence,
    endSequence,
    stateResponse,
    messagesResponse,
    overlapEvents,
    projection: projectionReducer.snapshot(),
    pendingUi: pendingUi.values(),
    modelsResponse,
    thinkingLevelsResponse,
    commandsResponse,
  });
};

const snapshot = async () => {
  for (let attempt = 0; attempt < snapshotAttempts; attempt += 1) {
    const value = await snapshotAttempt();
    if (value) return value;
  }
  throw new Error("scotty_snapshot_overlap_unavailable");
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

const commandError = (status, code) => ({
  status,
  body: {
    status: "error",
    code,
    retryable: false,
  },
});

const executeCommand = async (normalized, digest, receiptKey) => {
  if (
    normalized.command.type === "extension_ui_response" &&
    (typeof normalized.command.id !== "string" || !pendingUi.has(normalized.command.id))
  )
    return commandError(409, "extension_ui_not_pending");
  if (
    normalized.command.type === "extension_ui_response" &&
    pendingUi.isDelivered(normalized.command.id)
  )
    return commandError(409, "extension_ui_response_already_delivered");

  let rpcResponse;
  if (normalized.command.type === "extension_ui_response") {
    await sendRpcWithoutResponse(normalized.command);
    pendingUi.markDelivered(normalized.command.id);
    rpcResponse = {
      type: "response",
      command: "extension_ui_response",
      delivery: "unconfirmed",
    };
  } else {
    const rpcId = `ui-${normalized.commandId}`;
    rpcResponse = await sendRpc(normalized.command, rpcId);
  }
  if (normalized.command.type === "abort" && rpcResponse.success !== false) {
    pendingUi.clear();
    projectionReducer.clearVolatile();
  }
  const response = sanitizeRemoteValue(rpcResponse).value;
  const receipt = {
    epoch,
    status:
      normalized.command.type === "extension_ui_response"
        ? "delivered"
        : rpcResponse.success === false
          ? "rejected"
          : "accepted",
    commandId: normalized.commandId,
    commandDigest: digest,
    response,
  };
  rememberReceipt(receiptKey, receipt);
  return { status: rpcResponse.success === false ? 409 : 202, body: receipt };
};

const handleCommand = async (body) => {
  if (quiescing) return commandError(409, "pi_quiescing");
  const normalized = normalizeCommand(body, epoch);
  if (!normalized.ok)
    return commandError(normalized.error === "scotty_epoch_changed" ? 409 : 400, normalized.error);
  const digest = await commandIntentDigest(normalized.intent);
  const receiptKey = `${epoch}:${normalized.commandId}`;
  const replay = receipts.get(receiptKey);
  if (replay) {
    if (replay.commandDigest !== digest) return commandError(409, "command_id_conflict");
    return { status: 200, body: replay };
  }
  const inFlight = inFlightCommands.get(receiptKey);
  if (inFlight) {
    if (inFlight.digest !== digest) return commandError(409, "command_id_conflict");
    return inFlight.promise;
  }

  const promise = executeCommand(normalized, digest, receiptKey);
  const flight = { digest, promise };
  inFlightCommands.set(receiptKey, flight);
  try {
    return await promise;
  } finally {
    if (inFlightCommands.get(receiptKey) === flight) inFlightCommands.delete(receiptKey);
  }
};

const handleHealth = (_request, response) =>
  jsonResponse(
    response,
    ready ? 200 : 503,
    ready
      ? { status: "ready", epoch }
      : { status: "starting", stderr: stderrTail ? "available" : "empty" },
  );

const handleSnapshot = async (_request, response) => {
  if (!ready) return jsonResponse(response, 503, { error: "pi_not_ready" });
  return jsonResponse(response, 200, await snapshot());
};

const handleEvents = (request, response, url) => {
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
    if (Number.isFinite(since) && since > 0 && events.length > 0 && events[0].sequence > since + 1)
      writeSse(response, {
        epoch,
        sequence,
        event: { type: "scotty_replay_gap" },
      });
    for (const envelope of events)
      if (envelope.sequence > (Number.isFinite(since) ? since : 0)) writeSse(response, envelope);
  }
  subscribers.add(response);
  const heartbeat = shouldEmitSseHeartbeat(request.headers)
    ? setInterval(() => response.write(": keepalive\n\n"), 15_000)
    : undefined;
  request.on("close", () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    subscribers.delete(response);
  });
};

const handleCommandRoute = async (request, response) => {
  if (!ready) return jsonResponse(response, 503, { error: "pi_not_ready" });
  const result = await handleCommand(await readJsonBody(request));
  return jsonResponse(response, result.status, result.body);
};

const handleQuiesceRoute = async (_request, response) => {
  if (!ready) return jsonResponse(response, 503, { error: "pi_not_ready" });
  await quiesce();
  return jsonResponse(response, 200, { status: "quiesced" });
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/health")
      return handleHealth(request, response);
    if (!hasTransportCapability(request))
      return jsonResponse(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && url.pathname === "/snapshot")
      return await handleSnapshot(request, response);
    if (request.method === "GET" && url.pathname === "/events")
      return handleEvents(request, response, url);
    if (request.method === "POST" && url.pathname === "/command")
      return await handleCommandRoute(request, response);
    if (request.method === "POST" && url.pathname === "/quiesce")
      return await handleQuiesceRoute(request, response);
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
