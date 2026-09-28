// Dev tool, not a test: `vite dev` answers `/api/*` from real event logs (saved from `dev`)
// through the real fold and views, so the UI can be iterated on without a deployment.
// Writes append events the way the Session DO would and play back segments of real logs.
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Schema } from "effect";
import type { Plugin } from "vite";
import { decodeSessionEvent, type SessionEvent } from "../../src/session/events.ts";
import { fold, initial, type State } from "../../src/session/fold.ts";
import { conversationView, sessionView } from "../../src/session/view.ts";
import { readSkill } from "../../src/settings/skill.ts";
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
  device: 0,
};
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
    return json(res, {
      version: 1,
      sessions: list.map((session) => ({
        ...view(session).session,
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
