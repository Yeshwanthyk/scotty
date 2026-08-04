#!/usr/bin/env node
import { createInterface } from "node:readline";

const fleet = [
  {
    id: "alpha-session",
    title: "Desktop orchestrator",
    status: "warm",
    provider: "cloudflare",
    repo: "example/scotty",
    defaultBranch: "main",
    branch: "feat/desktop-codex-orchestrator",
    backupId: null,
    agentState: "working",
    createdAt: "2026-08-02T18:00:00.000Z",
    updatedAt: "2026-08-02T20:00:00.000Z",
    hardCapAt: "2026-08-03T00:00:00.000Z",
    projectedAt: "2026-08-02T20:00:00.000Z",
    ageSeconds: 7200,
    capRemainingSeconds: 14400,
    failure: null,
  },
  {
    id: "review-session",
    title: "Review migration gates",
    status: "warm",
    provider: "cloudflare",
    repo: "example/scotty",
    defaultBranch: "main",
    branch: "main",
    backupId: "backup-review",
    agentState: "waiting",
    createdAt: "2026-08-02T18:00:00.000Z",
    updatedAt: "2026-08-02T19:58:00.000Z",
    hardCapAt: "2026-08-03T00:00:00.000Z",
    projectedAt: "2026-08-02T20:00:00.000Z",
    ageSeconds: 7200,
    capRemainingSeconds: 14400,
    failure: null,
  },
  {
    id: "cold-session",
    title: "Archived deployment proof",
    status: "sleeping",
    provider: "cloudflare",
    repo: "example/scotty",
    defaultBranch: "main",
    branch: "main",
    backupId: "backup-cold",
    agentState: null,
    createdAt: "2026-08-01T18:00:00.000Z",
    updatedAt: "2026-08-01T20:00:00.000Z",
    hardCapAt: "2026-08-02T00:00:00.000Z",
    projectedAt: "2026-08-02T20:00:00.000Z",
    ageSeconds: 93600,
    capRemainingSeconds: 0,
    failure: null,
  },
];
let selectedSessionId;
let draft = "";
let draftGeneration = 0;
let commandStatus = null;
let transcript = [
  {
    kind: "user",
    id: "user-1",
    text: "Map the smallest complete desktop slice.",
    imageCount: 0,
  },
  {
    kind: "assistant",
    id: "assistant-1",
    text: "The native shell can stay thin: session authority remains remote, while this viewport switches among live projections.",
  },
];

const live = () => ({
  epoch: "fixture-epoch",
  sequence: transcript.length,
  sessionRevision: transcript.length,
  isStreaming: selectedSessionId === "alpha-session",
  transcript: [
    ...transcript,
    ...(selectedSessionId === "alpha-session"
      ? [
          {
            kind: "tool",
            id: "tool-1",
            name: "bash",
            summary: "Ran command",
            detail: "cargo check --manifest-path desktop/Cargo.toml",
            status: "running",
            result: null,
          },
        ]
      : []),
  ],
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
  version: 2,
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
          commandStatus,
        },
});
const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const publish = () => emit({ version: 2, type: "state", state: state() });

emit({ version: 2, type: "ready" });
publish();
createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "shutdown") {
    emit({ version: 2, type: "stopped" });
    process.exit(0);
  }
  if (command.type === "select") selectedSessionId = command.sessionId;
  else if (command.type === "close") selectedSessionId = undefined;
  else if (command.type.endsWith("_sandbox")) {
    const action = command.type.replace("_sandbox", "");
    const sessionId = command.sessionId ?? "fixture-created";
    emit({
      version: 2,
      type: "operation",
      requestId: command.requestId,
      action,
      sessionId,
      status: "started",
      message: `${action} started`,
    });
    if (command.type === "create_sandbox") {
      fleet.unshift({
        ...fleet[0],
        id: sessionId,
        title: command.title,
        repo: command.repo,
        branch: `scotty/${sessionId}`,
        status: "booting",
        agentState: null,
      });
    } else if (command.type === "rename_sandbox") {
      const target = fleet.find((session) => session.id === sessionId);
      if (target) target.title = command.title;
    } else if (command.type === "snapshot_sandbox") {
      const target = fleet.find((session) => session.id === sessionId);
      if (target) target.backupId = "fixture-backup";
    } else if (command.type === "resume_sandbox") {
      const target = fleet.find((session) => session.id === sessionId);
      if (target) target.status = "warm";
    } else if (command.type === "vaporize_sandbox") {
      const index = fleet.findIndex((session) => session.id === sessionId);
      if (index >= 0) fleet.splice(index, 1);
      if (selectedSessionId === sessionId) selectedSessionId = undefined;
    }
    emit({
      version: 2,
      type: "operation",
      requestId: command.requestId,
      action,
      sessionId,
      status: "succeeded",
      message: `${action} completed`,
    });
  } else if (command.type === "set_draft") {
    draft = command.text;
    draftGeneration += 1;
  } else if (command.type === "submit") {
    const imageCount = Array.isArray(command.images) ? command.images.length : 0;
    const text = command.text.trim();
    transcript = [
      ...transcript,
      { kind: "user", id: `user-${transcript.length}`, text, imageCount },
    ];
    draft = "";
    draftGeneration += 2;
    commandStatus = "Command accepted";
  } else if (command.type === "answer" && selectedSessionId === "review-session") {
    selectedSessionId = "alpha-session";
  }
  publish();
});
