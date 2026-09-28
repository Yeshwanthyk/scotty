// Synthetic sessions in the exact Codex app-server shapes (surveyed 2026-09-28 from two weeks of
// real rollouts, structure only), written as Scotty event logs so they go through the real fold.
import { decodeSessionEvent, type SessionEvent } from "../../src/session/events.ts";

type Json = Record<string, unknown>;

export type Spec =
  | { type: "think"; summary?: string[] }
  | { type: "say"; text: string; phase?: "commentary" | "final_answer" }
  | {
      type: "cmd";
      command: string;
      output: string;
      exitCode?: number;
      actions?: Json[];
      ms?: number;
    }
  | { type: "patch"; changes: { path: string; kind: "add" | "delete" | "update"; diff: string }[] }
  | { type: "mcp"; server: string; tool: string; args: Json; result: string; failed?: boolean }
  | { type: "web"; query?: string; url?: string }
  | { type: "agent"; tool: "spawnAgent" | "wait"; prompt?: string }
  | { type: "image"; path: string }
  | { type: "plan"; steps: [string, "pending" | "inProgress" | "completed"][] }
  | { type: "diff"; diff: string }
  | { type: "error"; message: string; info: string; retry?: boolean }
  | { type: "compact" };

type TurnSpec = {
  prompt: string;
  items: Spec[];
  end?: "completed" | "interrupted" | "failed" | "open";
  seconds?: number;
};

export type DummySpec = {
  id: string;
  title: string;
  repo: string;
  minutesAgo: number;
  turns: TurnSpec[];
  // Where the session is left: stopped after its turns, waiting on the owner, or failed at boot.
  after?: "stopped" | "waiting" | "boot-failed";
};

const read = (path: string) => ({
  type: "read",
  command: `sed -n '1,200p' ${path}`,
  name: path.split("/").at(-1),
  path,
});
const search = (query: string, path = ".") => ({
  type: "search",
  command: `rg -n "${query}" ${path}`,
  query,
  path,
});
const listFiles = (path = ".") => ({ type: "listFiles", command: `rg --files ${path}`, path });

export function codexLog(spec: DummySpec): SessionEvent[] {
  const thread = `01a0f0${spec.id.slice(0, 2)}-0000-7000-8000-${spec.id.slice(-12)}`;
  const events: SessionEvent[] = [];
  let at = Date.now() - spec.minutesAgo * 60_000;
  let n = 0;
  let item = 0;
  const push = (event: Json) =>
    events.push(decodeSessionEvent({ seq: events.length + 1, at, ...event }));
  const sup = (event: Json) => push({ src: "supervisor", gen: 1, n: ++n, ...event });
  const agent = (method: string, params: Json) => {
    at += 40;
    sup({
      kind: "agent.event",
      agentKind: "codex",
      event: { method, params: { threadId: thread, ...params }, emittedAtMs: at },
    });
  };
  const words = (text: string) => text.match(/\S+\s*/g) ?? [text];

  push({
    src: "api",
    kind: "created",
    agentKind: "codex",
    repo: spec.repo,
    baseBranch: "main",
    branch: `scotty/${spec.id}`,
    title: spec.title,
    prompt: spec.turns[0]?.prompt ?? "",
    image: "default",
  });
  push({ src: "session", kind: "container.start", gen: 1 });
  at += 3400;
  sup({
    kind: "sup.hello",
    version: "step-2",
    boot: `b00700${spec.id.slice(0, 2)}-0000-4000-8000-000000000000`,
  });
  if (spec.after === "boot-failed") {
    at += 15_000;
    sup({ kind: "sup.error", code: "workspace", message: "workspace command failed" });
    at += 8000;
    push({ src: "api", kind: "container.stopped", gen: 1 });
    push({ src: "supervisor", kind: "socket.closed", gen: 1 });
    return events;
  }
  at += 1600;
  sup({
    kind: "workspace.ready",
    base: "main",
    branch: `scotty/${spec.id}`,
    commit: "4f37cf512cdbfb48f6ef8f5ea64f2f6bf51097cf",
    ms: 1580,
    retried: [],
  });
  sup({ kind: "agent.ready", agentKind: "codex", session: thread });

  spec.turns.forEach((turn, index) => {
    const turnId = `01a0f0${spec.id.slice(0, 2)}-${String(index).padStart(4, "0")}-7000-8000-000000000000`;
    const req =
      index === 0
        ? "initial:1"
        : `5eed${spec.id.slice(0, 4)}-0000-4000-8000-${String(index).padStart(12, "0")}`;
    if (index > 0) {
      at += 45_000;
      push({
        src: "api",
        kind: "prompt.requested",
        req,
        turn: String(index),
        text: turn.prompt,
        images: [],
      });
    }
    at += 900;
    sup({ kind: "prompt.delivered", req });
    const started = at;
    const perItem = ((turn.seconds ?? 40) * 1000) / Math.max(turn.items.length, 1);
    agent("turn/started", {
      turn: {
        id: turnId,
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        error: null,
        startedAt: Math.floor(at / 1000),
        completedAt: null,
        durationMs: null,
      },
    });
    const user = {
      type: "userMessage",
      id: `${turnId}-u`,
      clientId: null,
      content: [{ type: "text", text: turn.prompt, text_elements: [] }],
    };
    agent("item/started", { item: user, turnId, startedAtMs: at });
    agent("item/completed", { item: user, turnId, completedAtMs: at });
    let error: Json | null = null;
    for (const entry of turn.items) {
      at += perItem;
      const id = `${entry.type}_${spec.id.slice(0, 6)}_${++item}`;
      const lifecycle = (started: Json, completed: Json, between: () => void = () => {}) => {
        agent("item/started", { item: started, turnId, startedAtMs: at });
        between();
        agent("item/completed", { item: completed, turnId, completedAtMs: at });
      };
      switch (entry.type) {
        case "think": {
          const empty = { type: "reasoning", id: `rs_${id}`, summary: [], content: [] };
          lifecycle(empty, { ...empty, summary: entry.summary ?? [] }, () =>
            (entry.summary ?? []).forEach((part, summaryIndex) =>
              words(part).forEach((delta) =>
                agent("item/reasoning/summaryTextDelta", {
                  turnId,
                  itemId: `rs_${id}`,
                  delta,
                  summaryIndex,
                }),
              ),
            ),
          );
          break;
        }
        case "say": {
          const message = {
            type: "agentMessage",
            id: `msg_${id}`,
            text: "",
            phase: entry.phase ?? "final_answer",
            memoryCitation: null,
            delivery: null,
            questions: null,
          };
          const last =
            index === spec.turns.length - 1 && turn.end === "open" && entry === turn.items.at(-1);
          agent("item/started", { item: message, turnId, startedAtMs: at });
          words(entry.text).forEach((delta) =>
            agent("item/agentMessage/delta", { turnId, itemId: `msg_${id}`, delta }),
          );
          if (!last)
            agent("item/completed", {
              item: { ...message, text: entry.text },
              turnId,
              completedAtMs: at,
            });
          break;
        }
        case "cmd": {
          const command = `/bin/sh -lc '${entry.command.replaceAll("'", `'"'"'`)}'`;
          const actions = entry.actions ?? [{ type: "unknown", command: entry.command }];
          const base = {
            type: "commandExecution",
            id: `call_${id}`,
            pluginId: null,
            scriptPath: null,
            command,
            cwd: "/workspace/repo",
            processId: String(2000 + item),
            source: "unifiedExecStartup",
            status: "inProgress",
            commandActions: actions,
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          const failed = (entry.exitCode ?? 0) !== 0;
          lifecycle(
            base,
            {
              ...base,
              status: failed ? "failed" : "completed",
              aggregatedOutput: entry.output,
              exitCode: entry.exitCode ?? 0,
              durationMs: entry.ms ?? 840,
            },
            () =>
              entry.output.split(/(?<=\n)/).forEach((delta) =>
                agent("item/commandExecution/outputDelta", {
                  turnId,
                  itemId: `call_${id}`,
                  delta,
                }),
              ),
          );
          break;
        }
        case "patch": {
          const changes = entry.changes.map((change) => ({
            path: `/workspace/repo/${change.path}`,
            kind:
              change.kind === "update"
                ? { type: "update", move_path: null }
                : { type: change.kind },
            diff: change.diff,
          }));
          const base = { type: "fileChange", id: `call_${id}`, changes, status: "inProgress" };
          lifecycle(base, { ...base, status: "completed" });
          break;
        }
        case "mcp": {
          const base = {
            type: "mcpToolCall",
            id: `call_${id}`,
            server: entry.server,
            tool: entry.tool,
            status: "inProgress",
            arguments: entry.args,
            result: null,
            error: null,
            durationMs: null,
          };
          lifecycle(base, {
            ...base,
            status: entry.failed ? "failed" : "completed",
            result: entry.failed
              ? null
              : { content: [{ type: "text", text: entry.result }], structuredContent: null },
            error: entry.failed ? { message: entry.result } : null,
            durationMs: 1320,
          });
          break;
        }
        case "web": {
          const action = entry.url
            ? { type: "openPage", url: entry.url }
            : { type: "search", query: entry.query, queries: [entry.query] };
          const base = {
            type: "webSearch",
            id: `ws_${id}`,
            query: entry.query ?? "",
            action: null,
          };
          lifecycle(base, { ...base, action });
          break;
        }
        case "agent": {
          const base = {
            type: "collabAgentToolCall",
            id: `call_${id}`,
            tool: entry.tool,
            status: "inProgress",
            senderThreadId: thread,
            receiverThreadIds: [],
            prompt: entry.prompt ?? null,
            model: null,
            reasoningEffort: null,
            agentsStates: {},
          };
          lifecycle(base, { ...base, status: "completed", receiverThreadIds: [`${thread}-sub`] });
          break;
        }
        case "image": {
          const base = { type: "imageView", id: `iv_${id}`, path: `/workspace/repo/${entry.path}` };
          lifecycle(base, base);
          break;
        }
        case "plan":
          agent("turn/plan/updated", {
            turnId,
            explanation: null,
            plan: entry.steps.map(([step, status]) => ({ step, status })),
          });
          break;
        case "diff":
          agent("turn/diff/updated", { turnId, diff: entry.diff });
          break;
        case "error":
          error = { message: entry.message, codexErrorInfo: entry.info, additionalDetails: null };
          agent("error", { turnId, error, willRetry: entry.retry === true });
          if (entry.retry === true) error = null;
          break;
        case "compact": {
          const base = { type: "contextCompaction", id: `cc_${id}` };
          lifecycle(base, base);
          break;
        }
      }
    }
    if (turn.end === "open") return;
    at += 600;
    const state = turn.end ?? "completed";
    agent("turn/completed", {
      turn: {
        id: turnId,
        items: [],
        itemsView: "summary",
        status: state,
        error,
        startedAt: Math.floor(started / 1000),
        completedAt: Math.floor(at / 1000),
        durationMs: at - started,
      },
    });
    sup({ kind: "turn.ended", turn: String(index), codexTurn: turnId, state });
    at += 500;
    push({ src: "session", kind: "save.done", turn: String(index) });
  });
  if ((spec.after ?? "stopped") === "stopped" && spec.turns.at(-1)?.end !== "open") {
    at += 30_000;
    push({ src: "api", kind: "container.stopped", gen: 1 });
    push({ src: "supervisor", kind: "socket.closed", gen: 1 });
  }
  return events;
}

const routerDiff = `@@ -12,9 +12,14 @@ export function SessionRow({ session }: Props) {
   const state = sessionState(session);
-  const label = state === "running" ? "Running" : "Stopped";
+  const label = labels[state];
+  const working = state === "working";
   return (
-    <Link to="/s/$sessionId" params={{ sessionId: session.id }} className="row">
-      <span className="dot" data-state={state} />
+    <Link
+      to="/s/$sessionId"
+      params={{ sessionId: session.id }}
+      className="row"
+      aria-current={active ? "page" : undefined}
+    >
+      {working ? <Spinner /> : <span className="dot" data-state={state} />}
       <span className="title">{session.title}</span>
       <span className="meta">{label}</span>
     </Link>
`;

const statusFile = `export type SessionState = "working" | "waiting" | "stopped" | "failed";

export const labels: Record<SessionState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  stopped: "Stopped",
  failed: "Failed",
};
`;

const testOutput = `
> storefront@0.4.0 test
> vitest run

 RUN  v3.2.4 /workspace/repo

 ✓ src/cart/total.test.ts (6 tests) 4ms
 ✓ src/cart/discount.test.ts (9 tests) 7ms
 ❯ src/checkout/tax.test.ts (4 tests | 1 failed) 12ms
   ✓ rounds half cents up
   ✓ applies the state rate
   × exempts gift cards 6ms
   ✓ handles zero-rated items

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/checkout/tax.test.ts > exempts gift cards
AssertionError: expected 1.2 to be +0
 ❯ src/checkout/tax.test.ts:31:42
     29|   it("exempts gift cards", () => {
     30|     const line = { sku: "GIFT-25", price: 25, giftCard: true };
     31|     expect(taxFor([line], "CA")).toBe(0);
       |                                          ^

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 18 passed (19)
   Duration  412ms
`;

const taxDiff = `@@ -8,7 +8,9 @@ const rates: Record<string, number> = { CA: 0.0725, NY: 0.04, OR: 0 };
 export function taxFor(lines: readonly Line[], state: string): number {
   const rate = rates[state] ?? 0;
-  const taxable = lines.reduce((sum, line) => sum + line.price, 0);
+  const taxable = lines
+    .filter((line) => !line.giftCard)
+    .reduce((sum, line) => sum + line.price, 0);
   return Math.round(taxable * rate * 100) / 100;
 }
`;

const longAnswer = `Found it. Gift cards were taxed because \`taxFor\` summed every line, including stored-value items.

## What changed

- \`src/checkout/tax.ts\` now skips lines with \`giftCard: true\` before applying the rate.
- The failing test passes; the other **18** are unchanged.

| State | Before | After |
| --- | ---: | ---: |
| CA, $25 gift card | $1.81 | $0.00 |
| CA, $40 shirt + gift card | $4.72 | $2.90 |
| OR, anything | $0.00 | $0.00 |

\`\`\`ts
const taxable = lines
  .filter((line) => !line.giftCard)
  .reduce((sum, line) => sum + line.price, 0);
\`\`\`

\`\`\`mermaid
flowchart LR
  Cart --> Lines
  Lines -->|giftCard| Exempt
  Lines -->|other| Taxable
  Taxable --> Rate --> Total
  Exempt --> Total
\`\`\`

One thing to decide: shipping is still taxed in CA. That matches the current spec, but tell me if you want it exempt too.`;

export const dummies: DummySpec[] = [
  {
    id: "d0cc0de5000000000000000000000001",
    title: "Fix gift card tax in checkout",
    repo: "acme/storefront",
    minutesAgo: 95,
    turns: [
      {
        prompt: "Tests are failing in checkout. Find out why gift cards get taxed and fix it.",
        seconds: 140,
        items: [
          {
            type: "think",
            summary: [
              "**Reproducing the failure**\n\nI'll run the suite first so I'm fixing the failure the owner sees, not a guess.",
            ],
          },
          {
            type: "say",
            phase: "commentary",
            text: "I'll run the tests first to see the exact failure.",
          },
          { type: "cmd", command: "npm test", output: testOutput, exitCode: 1, ms: 2140 },
          {
            type: "think",
            summary: [
              "**Reading the tax code**\n\nThe assertion says gift cards produce tax. The reducer probably ignores the `giftCard` flag.",
            ],
          },
          {
            type: "cmd",
            command: 'rg -n "giftCard" src',
            output:
              'src/cart/types.ts:7:  giftCard?: boolean;\nsrc/checkout/tax.test.ts:30:    const line = { sku: "GIFT-25", price: 25, giftCard: true };\n',
            actions: [search("giftCard", "src")],
          },
          {
            type: "cmd",
            command: "sed -n '1,40p' src/checkout/tax.ts",
            output:
              'import type { Line } from "../cart/types";\n\nconst rates: Record<string, number> = { CA: 0.0725, NY: 0.04, OR: 0 };\n',
            actions: [read("src/checkout/tax.ts")],
          },
          {
            type: "cmd",
            command: "sed -n '1,20p' src/cart/types.ts",
            output:
              "export type Line = {\n  sku: string;\n  price: number;\n  giftCard?: boolean;\n};\n",
            actions: [read("src/cart/types.ts")],
          },
          {
            type: "say",
            phase: "commentary",
            text: "`taxFor` sums every line. I'll filter gift cards out before applying the rate.",
          },
          {
            type: "patch",
            changes: [{ path: "src/checkout/tax.ts", kind: "update", diff: taxDiff }],
          },
          {
            type: "diff",
            diff: `diff --git a/src/checkout/tax.ts b/src/checkout/tax.ts\n--- a/src/checkout/tax.ts\n+++ b/src/checkout/tax.ts\n${taxDiff}`,
          },
          {
            type: "cmd",
            command: "npm test -- src/checkout",
            output:
              "\n ✓ src/checkout/tax.test.ts (4 tests) 9ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n",
            ms: 1310,
          },
          {
            type: "cmd",
            command: "npm run typecheck",
            output: "\n> storefront@0.4.0 typecheck\n> tsc --noEmit\n\n",
            ms: 4200,
          },
          { type: "say", text: longAnswer },
        ],
      },
      {
        prompt: "Yes, exempt shipping in CA too, and add a test for it.",
        seconds: 70,
        items: [
          {
            type: "cmd",
            command: "sed -n '1,60p' src/checkout/shipping.ts",
            output: "export const shippingFor = (total: number) => (total >= 50 ? 0 : 6.95);\n",
            actions: [read("src/checkout/shipping.ts")],
          },
          {
            type: "patch",
            changes: [
              {
                path: "src/checkout/tax.ts",
                kind: "update",
                diff: '@@ -3,1 +3,2 @@\n const rates: Record<string, number> = { CA: 0.0725, NY: 0.04, OR: 0 };\n+const shippingExempt = new Set(["CA"]);\n',
              },
              {
                path: "src/checkout/tax.test.ts",
                kind: "update",
                diff: '@@ -40,0 +41,6 @@\n+  it("does not tax shipping in CA", () => {\n+    const lines = [{ sku: "SHIP", price: 6.95, shipping: true }];\n+    expect(taxFor(lines, "CA")).toBe(0);\n+  });\n',
              },
            ],
          },
          {
            type: "cmd",
            command: "npm test",
            output: "\n Test Files  3 passed (3)\n      Tests  20 passed (20)\n",
            ms: 1900,
          },
          {
            type: "say",
            text: "Done. Shipping lines are exempt in CA, with a new test (`does not tax shipping in CA`). All 20 tests pass.",
          },
        ],
      },
    ],
  },
  {
    id: "d0cc0de5000000000000000000000002",
    title: "Status dots and spinner in the session list",
    repo: "Yeshwanthyk/scotty-hatch-test",
    minutesAgo: 6,
    after: "waiting",
    turns: [
      {
        prompt: "Show a spinner for working sessions in the list and a dot for the rest.",
        seconds: 95,
        items: [
          {
            type: "plan",
            steps: [
              ["Find where rows render", "inProgress"],
              ["Add a state label map", "pending"],
              ["Render spinner or dot", "pending"],
              ["Check on a phone", "pending"],
            ],
          },
          { type: "think", summary: ["**Locating the list row**"] },
          {
            type: "cmd",
            command: "rg --files src | rg -i session",
            output: "src/sessions/SessionRow.tsx\nsrc/sessions/list.tsx\nsrc/sessions/status.ts\n",
            actions: [listFiles("src")],
          },
          {
            type: "cmd",
            command: "sed -n '1,80p' src/sessions/SessionRow.tsx",
            output: "…",
            actions: [read("src/sessions/SessionRow.tsx")],
          },
          {
            type: "plan",
            steps: [
              ["Find where rows render", "completed"],
              ["Add a state label map", "inProgress"],
              ["Render spinner or dot", "pending"],
              ["Check on a phone", "pending"],
            ],
          },
          {
            type: "patch",
            changes: [{ path: "src/sessions/status.ts", kind: "add", diff: statusFile }],
          },
          {
            type: "patch",
            changes: [{ path: "src/sessions/SessionRow.tsx", kind: "update", diff: routerDiff }],
          },
          {
            type: "plan",
            steps: [
              ["Find where rows render", "completed"],
              ["Add a state label map", "completed"],
              ["Render spinner or dot", "completed"],
              ["Check on a phone", "inProgress"],
            ],
          },
          {
            type: "cmd",
            command:
              "npm run dev -- --port 5173 & npx playwright screenshot --viewport-size=390,844 http://localhost:5173 shot.png",
            output: "Capturing page into shot.png\n",
            ms: 5200,
          },
          { type: "image", path: "shot.png" },
          {
            type: "plan",
            steps: [
              ["Find where rows render", "completed"],
              ["Add a state label map", "completed"],
              ["Render spinner or dot", "completed"],
              ["Check on a phone", "completed"],
            ],
          },
          {
            type: "diff",
            diff: `diff --git a/src/sessions/SessionRow.tsx b/src/sessions/SessionRow.tsx\n--- a/src/sessions/SessionRow.tsx\n+++ b/src/sessions/SessionRow.tsx\n${routerDiff}diff --git a/src/sessions/status.ts b/src/sessions/status.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/sessions/status.ts\n@@ -0,0 +1,8 @@\n${statusFile
              .split("\n")
              .slice(0, -1)
              .map((line) => `+${line}`)
              .join("\n")}\n`,
          },
          {
            type: "say",
            text: "Working sessions now show a spinner; the rest show a dot coloured by state. I checked it at 390×844.\n\nShould **waiting** use the accent colour, or stay neutral?",
          },
        ],
      },
    ],
  },
  {
    id: "d0cc0de5000000000000000000000003",
    title: "Research: iOS video Range requests",
    repo: "Yeshwanthyk/scotty-hatch-test",
    minutesAgo: 60 * 26,
    turns: [
      {
        prompt: "Why won't iOS Safari play our videos? Look it up and check the route.",
        seconds: 80,
        items: [
          { type: "web", query: "iOS Safari video Range request 206 Content-Length" },
          {
            type: "web",
            url: "https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari",
          },
          {
            type: "mcp",
            server: "github",
            tool: "search_code",
            args: { q: "Content-Range repo:Yeshwanthyk/scotty" },
            result: "2 results\nsrc/http/api.ts\nui/seed/api.ts",
          },
          {
            type: "agent",
            tool: "spawnAgent",
            prompt: "Read src/http/api.ts and report how the files route answers a Range header.",
          },
          { type: "agent", tool: "wait" },
          {
            type: "mcp",
            server: "linear",
            tool: "create_issue",
            args: { title: "Serve 206 for Range" },
            result: "Linear is not connected for this workspace.",
            failed: true,
          },
          {
            type: "say",
            text: "Safari sends `Range: bytes=0-1` first and refuses to play unless it gets **206** with `Content-Range` and a `Content-Length`. Our route streams chunked, so there is no length.\n\n> Serve the bytes whole with a length, and answer ranges with 206.\n\nI couldn't file the Linear issue: it isn't connected.",
          },
        ],
      },
    ],
  },
  {
    id: "d0cc0de5000000000000000000000004",
    title: "Refactor the auth flow to passkeys",
    repo: "acme/storefront",
    minutesAgo: 60 * 24 * 3,
    turns: [
      ...Array.from({ length: 9 }, (_, index): TurnSpec => ({
        prompt:
          [
            "Start by mapping the current auth flow.",
            "Where are sessions created?",
            "Sketch the passkey registration endpoints.",
            "Add the WebAuthn challenge store.",
            "Wire registration into the settings page.",
            "Now the login side.",
            "Handle the case where a user has no passkey yet.",
            "Remove the password reset emails.",
            "Update the docs.",
          ][index] ?? "Continue.",
        seconds: 30 + index * 7,
        items: [
          {
            type: "think",
            summary:
              index % 3 === 0
                ? [
                    `**Step ${index + 1}**\n\nChecking what's already there before changing anything.`,
                  ]
                : [],
          },
          {
            type: "cmd",
            command: `rg -n "session" src/auth`,
            output:
              "src/auth/session.ts:4:export function createSession(userId: string) {\nsrc/auth/login.ts:18:  const session = createSession(user.id);\n",
            actions: [search("session", "src/auth")],
          },
          {
            type: "cmd",
            command: "sed -n '1,80p' src/auth/login.ts",
            output: "…",
            actions: [read("src/auth/login.ts")],
          },
          ...(index % 2 === 1
            ? [
                {
                  type: "patch",
                  changes: [
                    {
                      path: `src/auth/passkey-${index}.ts`,
                      kind: "add",
                      diff: `export const step${index} = true;\n`,
                    },
                  ],
                } satisfies Spec,
              ]
            : []),
          ...(index === 4 ? [{ type: "compact" } satisfies Spec] : []),
          {
            type: "say",
            text: `Step ${index + 1} is done. ${index % 2 === 1 ? `I added \`src/auth/passkey-${index}.ts\`.` : "No code changed; this was reading."}`,
          },
        ],
      })),
      {
        prompt: "Run the full suite and summarise what's left.",
        seconds: 50,
        items: [
          {
            type: "cmd",
            command: "npm test",
            output: "\n Test Files  14 passed (14)\n      Tests  121 passed (121)\n",
            ms: 8800,
          },
          {
            type: "say",
            text: "All 121 tests pass. What's left:\n\n1. Rate-limit the challenge endpoint.\n2. A recovery path for lost devices.\n3. Remove the old `password_hash` column once everyone has a passkey.",
          },
        ],
      },
      {
        prompt: "Count slowly from 1 to 500, one number per line.",
        end: "interrupted",
        seconds: 6,
        items: [{ type: "say", phase: "commentary", text: "1\n2\n3\n4\n5\n6\n7" }],
      },
      {
        prompt: "Do the rate limit now.",
        end: "failed",
        seconds: 12,
        items: [
          { type: "think" },
          {
            type: "error",
            message: "stream disconnected before completion; retrying 1/5",
            info: "other",
            retry: true,
          },
          {
            type: "error",
            message: "You've hit your usage limit. Try again at 4:12 PM.",
            info: "usageLimitExceeded",
          },
        ],
      },
    ],
  },
  {
    id: "d0cc0de5000000000000000000000005",
    title: "Upgrade Vite to 7",
    repo: "Yeshwanthyk/scotty-hatch-test",
    minutesAgo: 1,
    after: "waiting",
    turns: [
      {
        prompt: "Upgrade Vite to 7 and make sure the build still works.",
        end: "open",
        seconds: 20,
        items: [
          { type: "think", summary: ["**Checking the current version**"] },
          {
            type: "cmd",
            command: "npm ls vite",
            output: "hatch-test@0.0.0 /workspace/repo\n└── vite@6.3.5\n",
            ms: 700,
          },
          {
            type: "cmd",
            command: "npm install -D vite@7",
            output: "\nadded 3 packages, changed 11 packages, and audited 67 packages in 4s\n",
            ms: 4100,
          },
          {
            type: "say",
            phase: "commentary",
            text: "Vite 7 is installed. I'm running the build now to see whether any plugin",
          },
        ],
      },
    ],
  },
  {
    id: "d0cc0de5000000000000000000000006",
    title: "Private repo that could not clone",
    repo: "Yeshwanthyk/scotty-e2e-private",
    minutesAgo: 60 * 24 * 12,
    after: "boot-failed",
    turns: [{ prompt: "reply ok", items: [] }],
  },
];
