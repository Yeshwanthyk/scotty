// Dev tool, not a test: `vite dev` answers `/api/*` from real event logs (saved from `dev`)
// through the real fold and views, so the UI can be iterated on without a deployment.
// Writes append events the way the Session DO would and play back segments of real logs.
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Schema } from "effect";
import type { Plugin } from "vite";
import { decodeSessionEvent, type SessionEvent } from "../../src/session/events.ts";
import { fold, initial, type State } from "../../src/session/fold.ts";
import { maxSearch, searchText } from "../../src/session/search.ts";
import { conversationView, sessionView, turnOutcome } from "../../src/session/view.ts";
import { AutomationName, Definition, nextDue, prepare } from "../../src/automations/automation.ts";
import { readSkill } from "../../src/settings/skill.ts";
import {
  type ConnectionMetadata,
  NewConnection,
  connectionView,
} from "../../src/creds/connections.ts";
import { codexLog, dummies } from "./dummy.ts";

const here = new URL(".", import.meta.url);
const speed = 4;
const maxGapMs = 1200;

const readLog = (name: string): SessionEvent[] => {
  const raw: unknown = JSON.parse(readFileSync(new URL(`logs/${name}.json`, here), "utf8"));
  return Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(raw).map((event) =>
    decodeSessionEvent(event),
  );
};
const media: Record<string, string> = {
  "image/png": "files/image.png",
  "video/webm": "files/video.webm",
};

type Step = { readonly delay: number; readonly draft: Record<string, unknown> };
type Segment = readonly Step[];
type Session = {
  id: string;
  history: SessionEvent[];
  state: State;
  queue: { segment: number; step: Step }[];
  timer: ReturnType<typeof setTimeout> | undefined;
  n: number;
  nGen: number | undefined;
  boot: string;
  playing: { segment: number; turn: string } | undefined;
};

// Delays between events, compressed; each step keeps only what the rewrite needs.
const steps = (events: readonly SessionEvent[]): Segment =>
  events.map((event, index) => {
    const previous = events[index - 1];
    const gap = previous === undefined ? 0 : event.at - previous.at;
    const { seq: _seq, at: _at, ...draft } = event;
    return { delay: Math.min(Math.max(gap, 0) / speed, maxGapMs), draft };
  });

// Boot: after `container.start`, up to the first `prompt.delivered`.
const bootOf = (log: readonly SessionEvent[]): Segment => {
  const start = log.findIndex((event) => event.kind === "container.start");
  const end = log.findIndex((event) => event.kind === "prompt.delivered");
  return steps(log.slice(start + 1, end));
};

// Each turn: its `prompt.delivered` through its `turn.ended` and `save.done`, supervisor and
// file events only (the requests are appended by the action that plays it).
const turnsOf = (log: readonly SessionEvent[]): Segment[] =>
  log.flatMap((event, index) => {
    if (event.kind !== "prompt.delivered") return [];
    const end = log.findIndex((later, at) => at > index && later.kind === "turn.ended");
    if (end === -1) return [];
    const saved = log.findIndex((later, at) => at > end && later.kind === "save.done");
    const body = log
      .slice(index, saved === -1 ? end + 1 : saved + 1)
      .filter(
        (item) => item.src === "supervisor" || item.src === "files" || item.kind === "save.done",
      );
    return [steps(body)];
  });

const templates = {
  showcase: readLog("rich-markdown"),
  twoTurns: readLog("two-turns"),
};
const boot = bootOf(templates.showcase);
const turns = [
  ...turnsOf(templates.showcase),
  ...turnsOf(templates.twoTurns),
  ...turnsOf(readLog("hatch-env")),
  ...turnsOf(readLog("github")),
];
let nextTurn = 0;

const sessions = new Map<string, Session>();
let segments = 0;

const make = (id: string, history: SessionEvent[]): Session => ({
  id,
  history,
  state: history.reduce(fold, initial),
  queue: [],
  timer: undefined,
  n: 0,
  nGen: undefined,
  boot: crypto.randomUUID(),
  playing: undefined,
});

function append(session: Session, draft: Record<string, unknown>) {
  const gen = session.state.gen;
  if (gen !== session.nGen) {
    session.n = session.state.lastN;
    session.nGen = gen;
    session.boot = crypto.randomUUID();
  }
  const rewritten: Record<string, unknown> = { ...draft };
  if ("gen" in draft && gen !== undefined) rewritten.gen = gen;
  if ("n" in draft) rewritten.n = ++session.n;
  if (draft.kind === "sup.hello") rewritten.boot = session.boot;
  const last = session.history.at(-1);
  const event = decodeSessionEvent({ ...rewritten, seq: (last?.seq ?? 0) + 1, at: Date.now() });
  const before = session.state;
  session.history.push(event);
  session.state = fold(before, event);
  if (event.kind === "agent.event" && session.state.lastN === before.lastN)
    console.warn(`[seed] ${session.id}: fold dropped agent event n=${event.n}`);
}

function pump(session: Session) {
  if (session.timer !== undefined) return;
  const next = session.queue[0];
  if (next === undefined) return;
  session.timer = setTimeout(() => {
    session.timer = undefined;
    session.queue.shift();
    if (next.step.draft.kind === "prompt.delivered")
      session.playing = { segment: next.segment, turn: String(next.step.draft.turn ?? "") };
    append(session, next.step.draft);
    if (next.step.draft.kind === "turn.ended") session.playing = undefined;
    pump(session);
  }, next.step.delay);
}

// Queue a segment, rewriting the request and turn it answers.
function play(session: Session, segment: Segment, target?: { req: string; turn: string }) {
  const id = ++segments;
  for (const step of segment) {
    const draft = { ...step.draft };
    if (target !== undefined && draft.kind === "prompt.delivered") draft.req = target.req;
    if (target !== undefined && (draft.kind === "turn.ended" || draft.kind === "save.done"))
      draft.turn = target.turn;
    // A helper field for `playing`; decoding drops it before the event is stored.
    if (draft.kind === "prompt.delivered") draft.turn = target?.turn ?? "0";
    session.queue.push({ segment: id, step: { delay: step.delay, draft } });
  }
  pump(session);
}

const nextTemplate = (): Segment => {
  const segment = turns[nextTurn % turns.length] ?? [];
  nextTurn += 1;
  return segment;
};

function create(input: { title: string; repo: string; prompt: string }): Session {
  const id = crypto.randomUUID().replaceAll("-", "");
  const template = templates.showcase[0];
  if (template?.kind !== "created") throw new Error("showcase log has no created event");
  const session = make(id, []);
  append(session, {
    ...template,
    src: "api",
    title: input.title,
    repo: input.repo,
    prompt: input.prompt,
    branch: `scotty/${id}`,
  });
  append(session, { kind: "container.start", src: "session", gen: 1 });
  play(session, boot);
  // The initial prompt is answered with the showcase turn so a new session renders everything.
  const first = turnsOf(templates.showcase)[0];
  if (first !== undefined) play(session, first, { req: "initial:1", turn: "0" });
  sessions.set(id, session);
  return session;
}

function seed() {
  const saved: [string, string?][] = [
    ["rich-markdown", "Markdown, mermaid and code"],
    ["phone-files", "Screenshot and video of the counter"],
    ["two-turns"],
    ["hatch-env"],
    ["github"],
    ["hatch"],
    ["failed", "Failed start"],
  ];
  for (const [name, title] of saved) {
    const history = readLog(name).map((event) =>
      event.kind === "created" && title !== undefined ? { ...event, title } : event,
    );
    const created = history[0];
    if (created?.kind !== "created") continue;
    const id = created.branch.replace(/^scotty\//, "");
    sessions.set(id, make(id, history));
  }
  for (const spec of dummies) sessions.set(spec.id, make(spec.id, codexLog(spec)));
  // The owner's own sessions, imported by `bun ui/seed/local.ts` (git-ignored).
  const local = new URL("local/", here);
  const imported = (() => {
    try {
      return readdirSync(local).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
  })();
  for (const name of imported) {
    const raw: unknown = JSON.parse(readFileSync(new URL(name, local), "utf8"));
    const history = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(raw).map((event) =>
      decodeSessionEvent(event),
    );
    const created = history[0];
    if (created?.kind === "created") {
      const id = created.branch.replace(/^scotty\//, "");
      sessions.set(id, make(id, history));
    }
  }
  // Waiting for the owner: the two-turn log cut before its stop.
  const waiting = readLog("two-turns");
  const cut = waiting.findIndex((event) => event.kind === "container.stopped");
  const id = "5eed0000000000000000000000000001";
  const kept = waiting.slice(0, cut);
  // Moved in time as a whole so its last answer landed a minute ago.
  const shift = Date.now() - 60_000 - (kept.at(-1)?.at ?? 0);
  sessions.set(
    id,
    make(
      id,
      kept.map((event) =>
        event.kind === "created"
          ? { ...event, title: "Waiting for you", branch: `scotty/${id}`, at: event.at + shift }
          : { ...event, at: event.at + shift },
      ),
    ),
  );
  // Live: a session that boots and streams its answer from the moment the server starts.
  create({
    title: "Live: streams from server start",
    repo: "_scotty/fixture",
    prompt: templates.showcase[0]?.kind === "created" ? templates.showcase[0].prompt : "Show off",
  });
}

const CreateBody = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)),
  repo: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  prompt: Schema.String.check(Schema.isMinLength(1)),
});
const SteerBody = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1)),
  turn: Schema.String,
  req: Schema.optional(Schema.String),
});
const InterruptBody = Schema.Struct({ turn: Schema.String, req: Schema.optional(Schema.String) });

const view = (session: Session) => ({
  version: 1 as const,
  session: sessionView(session.id, session.state),
});
const path =
  /^\/api\/sessions\/([a-z0-9-]{6,32})(?:\/(steer|interrupt|stop|resume|conversation|log|files\/([a-f0-9]{32})))?$/;

function json(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}
const fail = (res: ServerResponse, message: string, status = 400, code = "bad_request") =>
  json(res, { error: { message, code } }, status);

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

// Settings and accounts live in memory; a skill upload runs the Worker's own zip check.
const owner = {
  instructions: "",
  skills: new Map<
    string,
    { name: string; description: string; enabled: boolean; size: number; updated: number }
  >(),
  github: "octocat" as string | null,
  chatgpt: "signed-in" as "signed-in" | "signed-out",
  claude: null as number | null,
  device: 0,
};
// Connections and their deliveries, in memory; the seeded deliveries point at seeded sessions.
const hooks = {
  connections: new Map<string, ConnectionMetadata>([
    ["sentry", { name: "sentry", kind: "webhook", created: Date.now() - 6 * 864e5 }],
    ["github-events", { name: "github-events", kind: "github", created: Date.now() - 864e5 }],
    [
      "linear",
      {
        name: "linear",
        kind: "mcp",
        url: "https://mcp.linear.app/mcp",
        created: Date.now() - 2 * 864e5,
      },
    ],
    [
      "metrics",
      {
        name: "metrics",
        kind: "token",
        host: "api.example.com",
        header: "X-Api-Key",
        created: Date.now() - 864e5,
      },
    ],
  ]),
  deliveries: [
    {
      id: "f4a8ac65-66a1-4c75-bddd-d5f512d8ec06",
      connection: "github-events",
      minutesAgo: 3,
      outcome: "accepted",
      reason: null,
      session: "d0cc0de5000000000000000000000002",
    },
    {
      id: "f0e71f89-35b1-4114-99db-457353fc3c8b",
      connection: "github-events",
      minutesAgo: 2,
      outcome: "skipped",
      reason: "own_github_identity",
      session: null,
    },
    // Each accepted delivery made its session at the same minute (dummy.ts `minutesAgo`).
    {
      id: "msg_8aB3dX",
      connection: "sentry",
      minutesAgo: 60 * 24 * 21,
      outcome: "accepted",
      reason: null,
      session: "d0cc0de5000000000000000000000008",
    },
    {
      id: "msg_c3Lm0R",
      connection: "sentry",
      minutesAgo: 40,
      outcome: "rejected",
      reason: "bad_signature",
      session: null,
    },
    {
      id: "msg_9dNe5W",
      connection: "sentry",
      minutesAgo: 12,
      outcome: "rejected",
      reason: "key_conflict",
      session: null,
    },
    {
      id: "msg_2kQ9fT",
      connection: "sentry",
      minutesAgo: 6,
      outcome: "accepted",
      reason: null,
      session: "d0cc0de5000000000000000000000002",
    },
    // The sender retried it: the session already had it.
    {
      id: "msg_2kQ9fT",
      connection: "sentry",
      minutesAgo: 5,
      outcome: "duplicate",
      reason: null,
      session: "d0cc0de5000000000000000000000002",
    },
  ],
};
async function hooksApi(req: IncomingMessage, res: ServerResponse, path: string, method: string) {
  if (path === "/api/connections" && method === "GET")
    return json(res, {
      connections: [...hooks.connections.values()].map((item) =>
        connectionView(item, `https://${req.headers.host ?? "localhost"}`),
      ),
    });
  if (path === "/api/connections" && method === "POST") {
    const input = Schema.decodeUnknownOption(NewConnection)(await body(req));
    if (input._tag === "None" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.value.name))
      return fail(res, "Expected a name of lowercase letters, digits and dashes");
    const { name } = input.value;
    if (hooks.connections.has(name)) return fail(res, "That name is taken", 409, "exists");
    const checked = input.value;
    const row: ConnectionMetadata =
      checked.kind === "webhook" || checked.kind === "github"
        ? { name, kind: checked.kind, created: Date.now() }
        : checked.kind === "token"
          ? {
              name,
              kind: checked.kind,
              host: checked.host,
              header: checked.header,
              created: Date.now(),
            }
          : { name, kind: checked.kind, url: checked.url, created: Date.now() };
    hooks.connections.set(name, row);
    return json(
      res,
      {
        ...connectionView(row, `https://${req.headers.host ?? "localhost"}`),
        ...(row.kind === "webhook" || row.kind === "github"
          ? { secret: `whsec_${Buffer.from(name.padEnd(24, "x")).toString("base64")}` }
          : {}),
      },
      201,
    );
  }
  const name = /^\/api\/connections\/([a-z0-9-]+)$/.exec(path)?.[1];
  if (name !== undefined && method === "DELETE")
    return json(res, { name, removed: hooks.connections.delete(name) });
  if (path === "/api/deliveries" && method === "GET") {
    const only = new URL(req.url ?? "/", "http://localhost").searchParams.get("connection");
    return json(res, {
      // Newest first, as the Creds DO lists them.
      deliveries: hooks.deliveries
        .filter((item) => only === null || item.connection === only)
        .toSorted((a, b) => a.minutesAgo - b.minutesAgo)
        .map(({ minutesAgo, ...item }) => ({ ...item, at: Date.now() - minutesAgo * 60_000 })),
    });
  }
  return fail(res, "Not found", 404, "not_found");
}
// Automations and their runs, in memory; the seeded runs point at seeded sessions, and the
// turn outcome is read from them the way the Worker reads it from the Session DO.
type SeedRun = {
  id: string;
  automation: string;
  trigger: "schedule" | "event" | "manual";
  at: number;
  status: "received" | "skipped" | "failed" | "started" | "steered";
  reason: string | null;
  session: string | null;
  delivery: string | null;
  key: string | null;
};
function seedRun(
  index: number,
  automation: string,
  minutesAgo: number,
  status: SeedRun["status"],
  reason: string | null,
  session: string | null,
): SeedRun {
  const event = automation === "triage-sentry";
  return {
    id: `5eed${String(index).padStart(28, "0")}`,
    automation,
    trigger: event ? "event" : "schedule",
    at: Date.now() - minutesAgo * 60_000,
    status,
    reason,
    session,
    delivery: event ? `msg_seed${index}` : null,
    key: event && status !== "skipped" ? "issue-4821" : null,
  };
}
const flows = {
  automations: new Map<
    string,
    { definition: Definition; enabled: boolean; nextDue: number | null; created: number }
  >([
    [
      "daily-digest",
      {
        definition: {
          when: { kind: "calendar", cron: "0 9 * * 1-5", tz: "Europe/London" },
          repo: "acme/storefront",
          agent: "codex",
          prompt: "Summarise yesterday's commits on main and flag anything risky.",
        },
        enabled: true,
        nextDue: nextDue(
          { kind: "calendar", cron: "0 9 * * 1-5", tz: "Europe/London" },
          Date.now(),
        ),
        created: Date.now() - 14 * 864e5,
      },
    ],
    [
      "triage-sentry",
      {
        definition: {
          when: { kind: "event", connection: "sentry" },
          only: { action: ["created", "reopened"] },
          key: "issue-{{data.issue.id}}",
          repo: "acme/storefront",
          agent: "codex",
          prompt: "Sentry reports {{data.issue.title}}. Find the cause and propose a fix.",
        },
        enabled: true,
        nextDue: null,
        created: Date.now() - 6 * 864e5,
      },
    ],
    [
      "weekly-deps",
      {
        definition: {
          when: { kind: "interval", minutes: 7 * 24 * 60 },
          repo: "acme/storefront",
          agent: "claude",
          prompt: "Check for outdated dependencies and open a branch with safe upgrades.",
        },
        enabled: false,
        nextDue: null,
        created: Date.now() - 864e5,
      },
    ],
  ]),
  runs: [
    seedRun(0, "daily-digest", 60 * 5, "started", null, "d0cc0de5000000000000000000000009"),
    seedRun(1, "triage-sentry", 120, "started", null, "d0cc0de5000000000000000000000002"),
    seedRun(2, "triage-sentry", 75, "steered", null, "d0cc0de5000000000000000000000002"),
    seedRun(3, "triage-sentry", 30, "skipped", 'not matched: action is "resolved"', null),
    seedRun(4, "daily-digest", 60 * 29, "skipped", "missed", null),
  ],
};
const NewAutomation = Schema.Struct({ name: AutomationName, ...Definition.fields });
const automationRow = (name: string) => {
  const row = flows.automations.get(name);
  if (row === undefined) return undefined;
  const lastRun = flows.runs.find((run) => run.automation === name) ?? null;
  return {
    name,
    ...row.definition,
    enabled: row.enabled,
    nextDue: row.nextDue,
    created: row.created,
    lastRun,
  };
};
async function automationsApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
) {
  if (path === "/api/automations" && method === "GET")
    return json(res, { automations: [...flows.automations.keys()].sort().map(automationRow) });
  if (path === "/api/automations" && method === "POST") {
    const input = Schema.decodeUnknownOption(NewAutomation)(await body(req));
    if (input._tag === "None") return fail(res, "Expected a name and a definition");
    const { name, ...definition } = input.value;
    if (flows.automations.has(name))
      return fail(res, `An automation named ${name} exists`, 409, "exists");
    flows.automations.set(name, { definition, enabled: false, nextDue: null, created: Date.now() });
    return json(res, { name, enabled: false }, 201);
  }
  if (path === "/api/runs" && method === "GET") {
    const only = new URL(req.url ?? "/", "http://localhost").searchParams.get("automation");
    return json(res, {
      runs: flows.runs
        .filter((run) => only === null || run.automation === only)
        .map((run) => {
          const session = run.session === null ? undefined : sessions.get(run.session);
          return { ...run, outcome: session === undefined ? null : turnOutcome(session.state) };
        }),
    });
  }
  const match = /^\/api\/automations\/([a-z0-9-]+)(\/run)?$/.exec(path);
  const name = match?.[1];
  const row = name === undefined ? undefined : flows.automations.get(name);
  if (name === undefined || row === undefined) return fail(res, "Not found", 404, "not_found");
  if (match?.[2] !== undefined && method === "POST") {
    const prepared = prepare(row.definition, { at: new Date().toISOString() });
    const session =
      prepared.status === "received"
        ? create({
            title: prepared.prompt.slice(0, 60),
            repo: row.definition.repo,
            prompt: prepared.prompt,
          })
        : undefined;
    const run: SeedRun = {
      id: crypto.randomUUID().replaceAll("-", ""),
      automation: name,
      trigger: "manual",
      at: Date.now(),
      status: session === undefined ? "skipped" : "started",
      reason: prepared.status === "skipped" ? prepared.reason : null,
      session: session?.id ?? null,
      delivery: null,
      key: prepared.status === "received" ? prepared.key : null,
    };
    flows.runs.unshift(run);
    return json(res, run);
  }
  if (method === "PUT") {
    const input = Schema.decodeUnknownOption(Definition)(await body(req));
    if (input._tag === "None") return fail(res, "Expected a definition");
    flows.automations.set(name, { ...row, definition: input.value, enabled: false, nextDue: null });
    return json(res, { name, enabled: false });
  }
  if (method === "PATCH") {
    const input = Schema.decodeUnknownOption(Schema.Struct({ enabled: Schema.Boolean }))(
      await body(req),
    );
    if (input._tag === "None") return fail(res, "Expected {enabled: true|false}");
    const due = input.value.enabled ? nextDue(row.definition.when, Date.now()) : null;
    flows.automations.set(name, { ...row, enabled: input.value.enabled, nextDue: due });
    return json(res, { name, enabled: input.value.enabled });
  }
  if (method === "DELETE") return json(res, { name, removed: flows.automations.delete(name) });
  return fail(res, "Not found", 404, "not_found");
}
async function bytes(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}
async function settingsApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
) {
  if (path === "/api/settings" && method === "GET")
    return json(res, {
      instructions: owner.instructions,
      skills: [...owner.skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
      email: "owner@example.com",
    });
  if (path === "/api/settings/instructions" && method === "PUT") {
    const input = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))(
      await body(req),
    );
    if (input._tag === "None") return fail(res, "Expected text");
    owner.instructions = input.value.text.trim() === "" ? "" : input.value.text;
    return json(res, { saved: true });
  }
  if (path === "/api/skills" && method === "PUT") {
    const zip = await bytes(req);
    const skill = await readSkill(zip);
    if (typeof skill === "string") return fail(res, skill);
    const enabled = owner.skills.get(skill.name)?.enabled ?? true;
    owner.skills.set(skill.name, { ...skill, enabled, size: zip.byteLength, updated: Date.now() });
    return json(res, { ...skill, sha256: "", size: zip.byteLength });
  }
  const skill = /^\/api\/skills\/([a-z0-9-]+)$/.exec(path)?.[1];
  if (skill !== undefined) {
    const row = owner.skills.get(skill);
    if (row === undefined) return fail(res, "Not found", 404, "not_found");
    if (method === "DELETE") {
      owner.skills.delete(skill);
      return json(res, { name: skill, removed: true });
    }
    const input = Schema.decodeUnknownOption(Schema.Struct({ enabled: Schema.Boolean }))(
      await body(req),
    );
    if (input._tag === "None") return fail(res, "Expected enabled");
    row.enabled = input.value.enabled;
    return json(res, { name: skill, enabled: row.enabled });
  }
  if (path === "/api/credentials/chatgpt")
    return json(res, {
      status: owner.chatgpt,
      expiresAt: owner.chatgpt === "signed-in" ? Date.now() + 9e8 : null,
    });
  if (path === "/api/credentials/chatgpt/start") {
    owner.device = Date.now();
    return json(res, {
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      interval: 2,
      expiresAt: Date.now() + 9e5,
    });
  }
  if (path === "/api/credentials/chatgpt/poll") {
    if (Date.now() - owner.device < 6000) return json(res, { status: "pending", interval: 2 });
    owner.chatgpt = "signed-in";
    return json(res, { status: "signed-in", expiresAt: Date.now() + 9e8 });
  }
  if (path === "/api/credentials/claude" && method === "GET")
    return json(res, {
      status: owner.claude === null ? "signed-out" : "signed-in",
      expiresAt: owner.claude,
    });
  if (path === "/api/credentials/claude" && method === "POST") {
    owner.claude = Date.now() + 365 * 864e5;
    return json(res, { status: "signed-in", expiresAt: owner.claude });
  }
  if (path === "/api/credentials/github" && method === "GET")
    return json(
      res,
      owner.github === null
        ? { status: "missing", login: null }
        : { status: "set", login: owner.github },
    );
  if (path === "/api/credentials/github" && method === "POST") {
    owner.github = "octocat";
    return json(res, { status: "set", login: owner.github });
  }
  return fail(res, "Not found", 404, "not_found");
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  if (url.pathname.startsWith("/api/connections") || url.pathname.startsWith("/api/deliveries"))
    return hooksApi(req, res, url.pathname, method);
  if (url.pathname.startsWith("/api/automations") || url.pathname === "/api/runs")
    return automationsApi(req, res, url.pathname, method);
  if (
    url.pathname.startsWith("/api/settings") ||
    url.pathname.startsWith("/api/skills") ||
    url.pathname.startsWith("/api/credentials")
  )
    return settingsApi(req, res, url.pathname, method);
  if (url.pathname === "/api/sessions" && method === "GET") {
    const list = [...sessions.values()].sort(
      (a, b) => (b.state.created?.at ?? 0) - (a.state.created?.at ?? 0),
    );
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (q.length > maxSearch) return fail(res, `Search text is at most ${maxSearch} characters`);
    // The Creds DO's search, over the same text it stores at create.
    const matches = list
      .filter((session) => {
        const created = session.state.created;
        if (q === "") return true;
        if (created === undefined) return false;
        const origin = created.origin;
        const text = searchText({
          ...created,
          ...(origin?.key === undefined ? {} : { key: origin.key }),
          ...(origin?.kind === "hook" ? { connection: origin.connection } : {}),
          ...(origin?.kind === "automation" ? { automation: origin.automation } : {}),
        });
        return text.includes(q.toLowerCase());
      })
      .map((session) => view(session).session);
    return json(res, {
      version: 1,
      sessions: matches.map((session) => ({
        ...session,
        projection: { projectedAt: new Date().toISOString() },
      })),
    });
  }
  if (url.pathname === "/api/sessions" && method === "POST") {
    const input = Schema.decodeUnknownOption(CreateBody)(await body(req));
    if (input._tag === "None") return fail(res, "Expected title, repo and prompt");
    const session = create(input.value);
    const { display, authority } = view(session).session;
    return json(res, {
      id: session.id,
      title: display.title,
      branch: display.branch,
      provider: "cloudflare",
      status: authority.kind === "stable" ? authority.lifecycle : "booting",
      url: `/s/${session.id}`,
    });
  }
  const match = path.exec(url.pathname);
  const session = match?.[1] === undefined ? undefined : sessions.get(match[1]);
  if (match === null || session === undefined) return fail(res, "Not found", 404, "not_found");
  const sub = match[2];
  if (method === "GET" && sub === undefined) return json(res, view(session));
  if (method === "DELETE" && sub === undefined) {
    const phase = session.state.phase;
    if (phase !== "stopped" && phase !== "failed")
      return fail(res, "Session is still running", 409, "running");
    clearTimeout(session.timer);
    sessions.delete(session.id);
    return json(res, { id: session.id, removed: true });
  }
  if (method === "GET" && sub === "conversation")
    return json(res, conversationView(session.state, session.history));
  if (method === "GET" && sub === "log") return json(res, session.history);
  if (method === "GET" && match[3] !== undefined) {
    const file = session.history.find(
      (event) => event.kind === "file.attached" && event.file === match[3],
    );
    const source = file?.kind === "file.attached" ? media[file.type] : undefined;
    if (file?.kind !== "file.attached" || source === undefined)
      return fail(res, "Not found", 404, "not_found");
    res.setHeader("content-type", file.type);
    return res.end(readFileSync(new URL(source, here)));
  }
  if (method === "POST" && sub === "stop") {
    const gen = session.state.gen;
    if (gen !== undefined) {
      clearTimeout(session.timer);
      session.timer = undefined;
      session.queue = [];
      session.playing = undefined;
      append(session, { kind: "container.stopped", src: "api", gen });
    }
    return json(res, view(session));
  }
  if (method === "POST" && sub === "resume") {
    append(session, { kind: "resume.requested", src: "api" });
    if (session.state.phase === "provisioning") play(session, boot);
    return json(res, view(session));
  }
  if (method === "POST" && sub === "steer") {
    const input = Schema.decodeUnknownOption(SteerBody)(await body(req));
    if (input._tag === "None") return fail(res, "Expected text and turn");
    const reqId =
      input.value.req ?? req.headers["idempotency-key"]?.toString() ?? crypto.randomUUID();
    const wasStopped = session.state.phase === "stopped";
    append(session, {
      kind: "prompt.requested",
      src: "api",
      req: reqId,
      turn: input.value.turn,
      text: input.value.text,
      images: [],
    });
    if (wasStopped && session.state.phase === "provisioning") play(session, boot);
    play(session, nextTemplate(), { req: reqId, turn: input.value.turn });
    const status = session.state.requests.find((item) => item.req === reqId)?.status ?? "unknown";
    return json(res, { status });
  }
  if (method === "POST" && sub === "interrupt") {
    const input = Schema.decodeUnknownOption(InterruptBody)(await body(req));
    if (input._tag === "None") return fail(res, "Expected turn");
    const reqId = input.value.req ?? crypto.randomUUID();
    append(session, {
      kind: "interrupt.requested",
      src: "api",
      req: reqId,
      turn: input.value.turn,
    });
    const playing = session.playing;
    if (playing !== undefined) {
      clearTimeout(session.timer);
      session.timer = undefined;
      session.queue = session.queue.filter((item) => item.segment !== playing.segment);
      append(session, {
        kind: "turn.ended",
        src: "supervisor",
        gen: 0,
        n: 0,
        turn: playing.turn,
        codexTurn: crypto.randomUUID(),
        state: "interrupted",
      });
      session.playing = undefined;
      pump(session);
    }
    const status = session.state.requests.find((item) => item.req === reqId)?.status ?? "unknown";
    return json(res, { status });
  }
  return fail(res, "Not found", 404, "not_found");
}

export function seedApi(): Plugin {
  return {
    name: "scotty-seed-api",
    apply: "serve",
    configureServer(server) {
      seed();
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        handle(req, res).catch((error: unknown) => {
          console.error("[seed]", error);
          fail(res, "Seed API failed", 500);
        });
      });
    },
  };
}
