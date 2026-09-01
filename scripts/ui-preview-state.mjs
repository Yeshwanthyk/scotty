import { commandIntentDigest } from "../protocol/pi-console-shared.mjs";

export const PREVIEW_SESSION_ID = "f0e1d2c3b4a5";

const historicalMessages = Array.from({ length: 14 }, (_, index) => {
  const number = index + 1;
  const toolCallId = `preview-history-tool-${number}`;
  return [
    {
      id: `preview-history-user-${number}`,
      role: "user",
      content: [{ type: "text", text: `Review interface pass ${number}.` }],
    },
    {
      id: `preview-history-assistant-${number}`,
      role: "assistant",
      model: number % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-luna",
      content: [
        { type: "thinking", thinking: `Checking the hierarchy for pass ${number}.` },
        {
          type: "toolCall",
          id: toolCallId,
          name: "read",
          arguments: { path: "worker/public/session/styles.css" },
        },
        { type: "text", text: `Completed interface review pass ${number}.` },
      ],
    },
    {
      id: `preview-history-result-${number}`,
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: `Verified interface pass ${number}.`,
    },
  ];
}).flat();

const initialMessages = [
  {
    id: "preview-user-initial",
    role: "user",
    content: [{ type: "text", text: "Clean up the session interface and prove it locally." }],
  },
  {
    id: "preview-assistant-initial",
    role: "assistant",
    model: "gpt-5.6-sol",
    content: [
      {
        type: "thinking",
        thinking: "Map the visual hierarchy before changing the interaction surface.",
      },
      {
        type: "toolCall",
        id: "preview-tool-initial",
        name: "read",
        arguments: { path: "worker/public/session" },
      },
      {
        type: "text",
        text: "I mapped the shell, composer, queue, and Changes surface. The local preview is ready for an interaction pass.",
      },
    ],
  },
  {
    id: "preview-tool-result-initial",
    role: "toolResult",
    toolCallId: "preview-tool-initial",
    toolName: "read",
    content: "Inspected the session shell, transcript, composer, and sidebar assets.",
  },
  ...historicalMessages,
  {
    id: "preview-user-final",
    role: "user",
    content: [{ type: "text", text: "Verify the finished workbench and its proof surfaces." }],
  },
  {
    id: "preview-evidence-call",
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "preview-evidence-tool",
        name: "scotty_browser_test",
        arguments: { route: `/s/${PREVIEW_SESSION_ID}` },
      },
    ],
  },
  {
    id: "preview-evidence-result",
    role: "toolResult",
    toolCallId: "preview-evidence-tool",
    toolName: "scotty_browser_test",
    content: {
      details: {
        jobId: "preview-evidence",
        status: "succeeded",
        summaryUrl: `/s/${PREVIEW_SESSION_ID}/evidence/preview-evidence`,
        completedSteps: 3,
        frameCount: 0,
        video: false,
      },
    },
  },
  {
    id: "preview-summary",
    role: "assistant",
    content:
      "The unified workbench is responsive and the interaction path passed locally. scotty-evidence:preview-evidence",
  },
];

const textMessage = (id, role, text) => ({
  id,
  role,
  content: [{ type: "text", text }],
});

export function createPreviewSession({
  schedule = (task, delay) => setTimeout(task, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  const epoch = "preview-epoch";
  const sessionRevision = 7;
  const messages = structuredClone(initialMessages);
  const queue = { steer: [], followUp: [] };
  const subscribers = new Set();
  const history = [];
  const timers = new Set();
  let sequence = 0;
  let turnNumber = 0;
  let active = false;

  const publish = (event) => {
    const envelope = { epoch, sequence: ++sequence, event };
    history.push(envelope);
    const frame = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const response of subscribers) response.write(frame);
    return envelope;
  };

  const publishQueue = () =>
    publish({
      type: "queue_update",
      steering: queue.steer.map(({ text }) => text),
      followUp: queue.followUp.map(({ text }) => text),
    });

  const later = (task, delay) => {
    let completedSynchronously = false;
    let timer;
    timer = schedule(() => {
      completedSynchronously = timer === undefined;
      if (timer !== undefined) timers.delete(timer);
      task();
    }, delay);
    if (!completedSynchronously) timers.add(timer);
    return timer;
  };

  const finishTurn = (assistant, prompt, toolCalls) => {
    publish({ type: "message_end", message: structuredClone(assistant) });
    for (const [index, tool] of toolCalls.entries()) {
      const toolResult = {
        id: `preview-tool-result-${turnNumber}-${index}`,
        role: "toolResult",
        toolCallId: tool.id,
        toolName: tool.name,
        content: tool.result,
      };
      messages.push(toolResult);
      publish({ type: "message_end", message: structuredClone(toolResult) });
    }
    active = false;
    publish({ type: "agent_end" });
    const next = queue.followUp.shift();
    if (next) {
      publishQueue();
      later(() => startTurn(next.text), 260);
    }
    return prompt;
  };

  const startTurn = (prompt) => {
    active = true;
    turnNumber += 1;
    const user = textMessage(`preview-user-${turnNumber}`, "user", prompt);
    const toolCalls = [
      {
        id: `preview-tool-${turnNumber}-read`,
        name: "read",
        result: "Found the active layout rules.",
      },
      {
        id: `preview-tool-${turnNumber}-edit`,
        name: "apply_patch",
        result: "Applied the compact activity hierarchy.",
      },
      {
        id: `preview-tool-${turnNumber}-browser`,
        name: "browser_test",
        result: "Verified the rendered desktop and mobile states.",
      },
    ];
    const assistant = {
      id: `preview-assistant-${turnNumber}`,
      role: "assistant",
      model: turnNumber % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-luna",
      content: [
        { type: "thinking", thinking: "" },
        {
          type: "toolCall",
          id: toolCalls[0].id,
          name: "read",
          arguments: { path: "worker/public/session/styles.css" },
        },
        { type: "text", text: "" },
      ],
    };
    messages.push(user, assistant);
    publish({ type: "message_start", message: structuredClone(user) });
    publish({ type: "agent_start" });
    publish({ type: "message_start", message: structuredClone(assistant) });

    const thinkingChunks = [
      "I’ll inspect the current hierarchy first. ",
      "Then I’ll compare the rendered state against the requested compact interaction.",
    ];
    publish({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    thinkingChunks.forEach((chunk, index) => {
      later(
        () => {
          assistant.content[0].thinking += chunk;
          publish({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: chunk },
          });
        },
        500 + index * 900,
      );
    });
    later(
      () =>
        publish({
          type: "tool_execution_start",
          toolCallId: toolCalls[0].id,
          toolName: "read",
          arguments: { path: "worker/public/session/styles.css" },
        }),
      2_400,
    );
    later(
      () =>
        publish({
          type: "tool_execution_update",
          toolCallId: toolCalls[0].id,
          toolName: "read",
          partialResult: "Inspecting composer, transcript, and responsive rules…",
        }),
      3_600,
    );
    later(() => {
      publish({
        type: "tool_execution_start",
        toolCallId: toolCalls[1].id,
        toolName: toolCalls[1].name,
        arguments: { path: "worker/public/session/styles.css" },
      });
      publish({
        type: "tool_execution_end",
        toolCallId: toolCalls[0].id,
        toolName: "read",
        result: toolCalls[0].result,
      });
    }, 4_800);
    later(() => {
      publish({
        type: "tool_execution_start",
        toolCallId: toolCalls[2].id,
        toolName: toolCalls[2].name,
        arguments: { route: "/s/preview-agent" },
      });
      publish({
        type: "tool_execution_end",
        toolCallId: toolCalls[1].id,
        toolName: toolCalls[1].name,
        result: toolCalls[1].result,
      });
    }, 6_000);
    later(
      () =>
        publish({
          type: "tool_execution_end",
          toolCallId: toolCalls[2].id,
          toolName: toolCalls[2].name,
          result: toolCalls[2].result,
        }),
      7_000,
    );

    const chunks = [
      "I’m applying that against the real local event path. ",
      "This response is arriving as ordered SSE deltas, ",
      "so queue, stop, reconnect, and completion can be reviewed in the actual interface.",
    ];
    chunks.forEach((chunk, index) => {
      later(
        () => {
          assistant.content[2].text += chunk;
          publish({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: chunk },
          });
          if (index === chunks.length - 1) finishTurn(assistant, prompt, toolCalls);
        },
        7_400 + index * 3_200,
      );
    });
  };

  const abort = () => {
    for (const timer of timers) cancel(timer);
    timers.clear();
    active = false;
    queue.steer.length = 0;
    queue.followUp.length = 0;
    publish({ type: "agent_abort" });
  };

  const acceptIntent = (intent) => {
    if (intent.type === "abort") return abort();
    const text = typeof intent.message === "string" ? intent.message.trim() : "";
    if (!text) return;
    if (!active && (intent.type === "prompt" || intent.type === "steer")) return startTurn(text);
    if (intent.type === "steer") {
      queue.steer.push({ text });
      publishQueue();
      later(() => {
        queue.steer.shift();
        publishQueue();
      }, 240);
      return;
    }
    queue.followUp.push({ text });
    publishQueue();
  };

  return {
    snapshot() {
      return {
        epoch,
        sessionRevision,
        baseSequence: sequence,
        sequence,
        state: { isStreaming: active },
        messages: structuredClone(messages),
        overlapEvents: [],
        activeTools: [],
        pendingUi: [],
        queue: structuredClone(queue),
      };
    },
    events() {
      return structuredClone(history);
    },
    subscribe(response, since = 0) {
      response.write(": connected\n\n");
      for (const envelope of history)
        if (envelope.sequence > since) response.write(`data: ${JSON.stringify(envelope)}\n\n`);
      subscribers.add(response);
      return () => subscribers.delete(response);
    },
    async command(envelope) {
      if (envelope?.epoch !== epoch || envelope?.expectedSessionRevision !== sessionRevision) {
        return {
          statusCode: 409,
          body: {
            status: "stale",
            expectedSessionRevision: envelope?.expectedSessionRevision,
            sessionRevision,
            retryable: false,
          },
        };
      }
      acceptIntent(envelope.intent ?? {});
      return {
        statusCode: 202,
        body: {
          epoch,
          commandId: envelope.commandId,
          commandDigest: await commandIntentDigest(envelope.intent),
          status: "accepted",
          response: { success: true },
        },
      };
    },
    close() {
      for (const timer of timers) cancel(timer);
      timers.clear();
      for (const response of subscribers) response.end();
      subscribers.clear();
    },
  };
}
