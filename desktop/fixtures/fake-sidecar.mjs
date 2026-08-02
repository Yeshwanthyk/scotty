#!/usr/bin/env node
import { createInterface } from "node:readline";

const fleet = [
  {
    id: "alpha-session",
    title: "Desktop orchestrator",
    status: "warm",
    provider: "cloudflare",
    repo: "Yeshwanthyk/scotty",
    branch: "feat/desktop-codex-orchestrator",
    agentState: "working",
    updatedAt: "just now",
  },
  {
    id: "review-session",
    title: "Review migration gates",
    status: "warm",
    provider: "cloudflare",
    repo: "Yeshwanthyk/scotty",
    branch: "main",
    agentState: "waiting",
    updatedAt: "2m ago",
  },
  {
    id: "cold-session",
    title: "Archived deployment proof",
    status: "stopped",
    provider: "cloudflare",
    repo: "Yeshwanthyk/scotty",
    branch: "main",
    updatedAt: "yesterday",
  },
];
let selectedSessionId;
let draft = "";
let draftGeneration = 0;
let messages = [
  { role: "user", content: "Map the smallest complete desktop slice." },
  {
    role: "assistant",
    content:
      "The native shell can stay thin: session authority remains remote, while this viewport switches among live projections.",
  },
];

const live = () => ({
  epoch: "fixture-epoch",
  sequence: messages.length,
  sessionRevision: messages.length,
  isStreaming: selectedSessionId === "alpha-session",
  messages,
  activeTools:
    selectedSessionId === "alpha-session"
      ? [
          {
            id: "tool-1",
            name: "bash",
            arguments: { command: "cargo check --manifest-path desktop/Cargo.toml" },
          },
        ]
      : [],
  pendingUi:
    selectedSessionId === "review-session"
      ? [
          {
            id: "release-proof",
            method: "confirm",
            title: "Run the deployed canary?",
            message: "This uses the existing paired Scotty credential.",
          },
        ]
      : [],
  activity: selectedSessionId === "review-session" ? "waiting" : "working",
  sidecarTruncated: false,
});
const state = () => ({
  version: 1,
  fleet,
  fleetError: null,
  selectedSessionId,
  loading: false,
  selected:
    selectedSessionId === undefined
      ? undefined
      : {
          draft,
          draftGeneration,
          live: live(),
          unavailable: null,
          error: null,
          commandStatus: null,
        },
});
const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const publish = () => emit({ version: 1, type: "state", state: state() });

emit({ version: 1, type: "ready" });
publish();
createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "shutdown") {
    emit({ version: 1, type: "stopped" });
    process.exit(0);
  }
  if (command.type === "select") selectedSessionId = command.sessionId;
  else if (command.type === "close") selectedSessionId = undefined;
  else if (command.type === "set_draft") {
    draft = command.text;
    draftGeneration += 1;
  } else if (command.type === "submit") {
    messages = [...messages, { role: "user", content: command.text }];
    draft = "";
    draftGeneration += 2;
  } else if (command.type === "answer" && selectedSessionId === "review-session") {
    selectedSessionId = "alpha-session";
  }
  publish();
});
