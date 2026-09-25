import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Deferred, Effect, FileSystem, Option, Queue, Schema, Scope, Stream } from "effect";
import {
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeModelIdentifier,
  ClaudeReasoningEffort,
} from "../../../../protocol/agents/claude/claude-model-capabilities";
import type { PiConsoleImage } from "../../../../protocol/agents/pi/pi-console";
import { parseManagedHandle } from "../../../../protocol/credentials/credentials";
import type { CanonicalConversationTool } from "../../../../protocol/session/conversation";
import { CloudSettingsEnvironmentSchema } from "../../../../protocol/settings/cloud-settings";
import { SandboxDigestSchema } from "../../sandbox/config-contracts";
import { sidecarChildEnvironment } from "../sidecar/environment";
import { SidecarAbsolutePath, SidecarBridgeError, type SidecarCleanup } from "../sidecar/protocol";
import { makeSidecarRuntime, type SidecarHost, type SidecarTurnTerminal } from "../sidecar/runtime";
import type { SidecarStart } from "../sidecar/server";
import { ClaudeHostError } from "./errors";
import {
  type ClaudeSavedState,
  importClaudeSavedState,
  readClaudeSavedState,
  writeClaudeSavedState,
} from "./persistence";

const managedHandle = (provider: string, slot: string) =>
  Schema.String.check(
    Schema.makeFilter((value) => {
      const handle = parseManagedHandle(value);
      return (
        Option.isSome(handle) && handle.value.provider === provider && handle.value.slot === slot
      );
    }),
  );

export const ClaudeLaunch = Schema.Struct({
  agentInstructionsPath: SidecarAbsolutePath,
  environment: Schema.optionalKey(CloudSettingsEnvironmentSchema),
  sandboxBundleDigest: Schema.optionalKey(SandboxDigestSchema),
  runtimeDir: SidecarAbsolutePath,
  workspace: SidecarAbsolutePath,
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)),
  githubHandle: Schema.optionalKey(managedHandle("github", "git-https")),
  model: ClaudeModelIdentifier,
  effort: ClaudeReasoningEffort,
  resumeSessionId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  credential: Schema.Struct({ sentinel: managedHandle("anthropic", "access") }),
}).check(
  Schema.makeFilter(
    (launch) => launch.agentInstructionsPath === `${launch.runtimeDir}.agent-instructions.md`,
    { expected: "an agent instructions file in the private runtime directory" },
  ),
);
type ClaudeLaunch = typeof ClaudeLaunch.Type;

type UserContent = Exclude<SDKUserMessage["message"]["content"], string>[number];
const userMessage = (
  text: string,
  images: ReadonlyArray<PiConsoleImage> = [],
  priority?: "next",
): SDKUserMessage => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      ...images.map(
        (image): UserContent => ({
          type: "image",
          source: { type: "base64", media_type: image.mimeType, data: image.data },
        }),
      ),
      { type: "text", text },
    ],
  },
  ...(priority === undefined ? {} : { priority }),
});

// Snapshots carry every tool of the turn; keep each display field bounded.
const DISPLAY_LIMIT = 4096;
const bounded = (text: string) =>
  text.length <= DISPLAY_LIMIT ? text : `${text.slice(0, DISPLAY_LIMIT)}…`;

type AssistantContent = Extract<SDKMessage, { type: "assistant" }>["message"]["content"];
type ToolResult = Extract<UserContent, { type: "tool_result" }>;
const toolResultText = (block: ToolResult) =>
  typeof block.content === "string"
    ? block.content
    : (block.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
const resultDiagnostic = (message: Extract<SDKMessage, { type: "result" }>) =>
  message.subtype === "success" && !message.is_error
    ? null
    : bounded(message.subtype === "success" ? message.result : message.errors.join("; ")) ||
      message.subtype;

interface Turn {
  readonly id: string;
  readonly done: Deferred.Deferred<SidecarTurnTerminal, ClaudeHostError>;
  text: string;
  interrupted: boolean;
}

/** Runs Claude Code through the Agent SDK as one streaming-input session per generation. */
const startClaudeHost = Effect.fnUntraced(function* (
  launch: ClaudeLaunch,
  saved: ClaudeSavedState | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const home = `${launch.runtimeDir}/home`;
  const configDir = `${launch.runtimeDir}/claude`;
  const instructions = yield* Effect.gen(function* () {
    yield* fs.makeDirectory(launch.runtimeDir, { mode: 0o700 });
    for (const directory of [home, configDir]) yield* fs.makeDirectory(directory, { mode: 0o700 });
    if (launch.sandboxBundleDigest !== undefined) {
      const skills = `${launch.workspace}/.scotty/sandbox/${launch.sandboxBundleDigest}/skills`;
      if (yield* fs.exists(skills)) yield* fs.symlink(skills, `${configDir}/skills`);
    }
    if (saved !== undefined) yield* importClaudeSavedState(configDir, saved);
    return yield* fs.readFileString(launch.agentInstructionsPath);
  }).pipe(Effect.mapError(() => new ClaudeHostError({ code: "isolation_setup_failed" })));

  const threadId = launch.resumeSessionId ?? crypto.randomUUID();
  const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done>();
  const session = query({
    prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
    options: {
      cwd: launch.workspace,
      model: launch.model,
      effort: launch.effort,
      ...(launch.resumeSessionId === undefined ? { sessionId: threadId } : { resume: threadId }),
      systemPrompt: { type: "preset", preset: "claude_code", append: instructions },
      // The Session container is the sandbox boundary; there is no one to answer prompts.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: {
        ...(yield* sidecarChildEnvironment({ ...launch, home })),
        CLAUDE_CONFIG_DIR: configDir,
        // Egress swaps this sentinel for the real token on api.anthropic.com only.
        CLAUDE_CODE_OAUTH_TOKEN: launch.credential.sentinel,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        IS_SANDBOX: "1",
      },
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => session.close()));

  let initialized = false;
  let running = true;
  let stopping = false;
  let failure: string | null = null;
  let turnFailureDiagnostic: string | null = null;
  let sequence = 0;
  let tools: Array<CanonicalConversationTool> = [];
  let turn: Turn | undefined;
  const exited = yield* Deferred.make<void>();

  const observeAssistant = (current: Turn, content: AssistantContent) => {
    for (const block of content)
      if (block.type === "text")
        current.text = current.text === "" ? block.text : `${current.text}\n\n${block.text}`;
      else if (block.type === "tool_use")
        tools.push({
          id: block.id,
          state: "running",
          label: block.name,
          invocation: bounded(JSON.stringify(block.input)),
        });
  };
  const observeToolResults = (content: ReadonlyArray<UserContent>) => {
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const settled = {
        state: block.is_error === true ? "failed" : "completed",
        output: bounded(toolResultText(block)),
      } as const;
      tools = tools.map((tool) => (tool.id === block.tool_use_id ? { ...tool, ...settled } : tool));
    }
  };
  const observe = (message: SDKMessage) =>
    Effect.suspend(() => {
      sequence += 1;
      const current = turn;
      if (current === undefined) return Effect.void;
      // Subagent traffic stays inside its Task tool; only the main thread is projected.
      if (message.type === "assistant" && message.parent_tool_use_id === null)
        observeAssistant(current, message.message.content);
      else if (message.type === "user" && typeof message.message.content !== "string")
        observeToolResults(message.message.content);
      // A steer queued behind the result continues the same Scotty turn.
      else if (message.type === "result" && (message.queued_turn_count ?? 0) === 0) {
        turn = undefined;
        turnFailureDiagnostic = resultDiagnostic(message);
        const terminal: SidecarTurnTerminal = {
          id: current.id,
          status: current.interrupted
            ? "interrupted"
            : turnFailureDiagnostic === null
              ? "completed"
              : "failed",
          text: current.text,
        };
        return Deferred.succeed(current.done, terminal);
      }
      return Effect.void;
    });
  yield* Stream.fromAsyncIterable(
    session,
    () => new ClaudeHostError({ code: "transport_failed" }),
  ).pipe(
    Stream.runForEach(observe),
    Effect.catch(() =>
      Effect.sync(() => {
        failure = "transport_failed";
      }),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        running = false;
        if (turn !== undefined)
          yield* Deferred.fail(turn.done, new ClaudeHostError({ code: "transport_failed" }));
        yield* Deferred.succeed(exited, undefined);
      }),
    ),
    Effect.forkIn(scope),
  );
  yield* Effect.tryPromise({
    try: () => session.initializationResult(),
    catch: () => new ClaudeHostError({ code: "startup_failed" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new ClaudeHostError({ code: "startup_failed" })),
    }),
  );
  initialized = true;

  const ready = () => initialized && running && failure === null;
  const receipt = (
    parent: SidecarCleanup["parent"],
    shutdown: SidecarCleanup["shutdown"],
  ): SidecarCleanup => ({
    cleanup: "ambiguous",
    descendants: "unverified",
    parent,
    shutdown,
    exit: null,
    failure: shutdown === "unexpected" ? "unexpected_exit" : null,
  });
  const awaitExit = Deferred.await(exited).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.map(Option.isSome),
  );
  const stop = Effect.gen(function* () {
    const unexpected = !running && !stopping;
    stopping = true;
    yield* Queue.end(input);
    if (yield* awaitExit) return receipt("exited", unexpected ? "unexpected" : "eof");
    session.close();
    return receipt((yield* awaitExit) ? "exited" : "unverified", "forced");
  });

  const host: SidecarHost<ClaudeHostError> = {
    agent: "claude",
    version: CLAUDE_AGENT_SDK_VERSION,
    threadId,
    settings: { model: launch.model, effort: launch.effort, workspace: launch.workspace },
    inspect: () => ({
      ready: ready(),
      failure,
      failureDiagnostic: null,
      turnFailureDiagnostic,
      tools,
      sequence,
    }),
    prompt: Effect.fnUntraced(function* (text, _clientUserMessageId, images) {
      if (!ready()) return yield* new ClaudeHostError({ code: "not_ready" });
      if (turn !== undefined) return yield* new ClaudeHostError({ code: "turn_busy" });
      const current: Turn = {
        id: crypto.randomUUID(),
        done: yield* Deferred.make<SidecarTurnTerminal, ClaudeHostError>(),
        text: "",
        interrupted: false,
      };
      tools = [];
      turnFailureDiagnostic = null;
      turn = current;
      yield* Queue.offer(input, userMessage(text, images));
      return { turnId: current.id, completed: Deferred.await(current.done) };
    }),
    steer: Effect.fnUntraced(function* (text, expectedTurnId, _clientUserMessageId, images) {
      if (turn?.id !== expectedTurnId) return yield* new ClaudeHostError({ code: "turn_mismatch" });
      yield* Queue.offer(input, userMessage(text, images, "next"));
      return { turnId: expectedTurnId };
    }),
    interrupt: Effect.gen(function* () {
      const current = turn;
      if (current === undefined) return yield* new ClaudeHostError({ code: "no_active_turn" });
      current.interrupted = true;
      yield* Effect.tryPromise({
        try: () => session.interrupt(),
        catch: () => new ClaudeHostError({ code: "transport_failed" }),
      });
      const terminal = yield* Deferred.await(current.done);
      return { id: terminal.id, status: terminal.status };
    }),
    stop,
    closed: Deferred.await(exited).pipe(
      Effect.map(() => receipt("exited", stopping ? "eof" : "unexpected")),
    ),
    settleHistory: (history) => history,
    releaseEvents: () => {},
    persist: (history) =>
      writeClaudeSavedState(launch.workspace, configDir, history).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
  };
  return host;
});

export const startClaudeRuntime = Effect.fnUntraced(function* ({
  generation,
  launch,
  restore,
}: SidecarStart<ClaudeLaunch>) {
  if (restore?.threadId !== launch.resumeSessionId)
    return yield* new SidecarBridgeError({ code: "invalid_request", outcome: "rejected" });
  const saved =
    restore === undefined ? undefined : yield* readClaudeSavedState(launch.workspace, restore);
  const host = yield* startClaudeHost(launch, saved);
  return yield* makeSidecarRuntime(host, generation, saved?.history);
});
