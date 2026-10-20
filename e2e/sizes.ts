import { BunServices } from "@effect/platform-bun";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  access,
  AutomationRemoved,
  AutomationSwitched,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  Removed,
  Reply,
  RunFired,
  Settings,
  target,
  View,
} from "../cli/client.js";
import { state } from "../cli/commands/common.js";
import type { Size } from "../src/places/place.js";
import { agent, prompt, real, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";
import { fixtureRepo } from "../protocol/supervisor.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("sizes", message, "scotty doctor"));

// Filling a bigger cap would start that many containers.
const largest = 3;

// What each size reads on track (docs/design.md, Containers): Cloudflare's 1/2 vCPU shows as one CPU.
const measuredSizes = {
  "standard-1": { cpus: 1, memory: 4401424 },
  "standard-2": { cpus: 1, memory: 6498576 },
  "standard-3": { cpus: 2, memory: 8595728 },
  "standard-4": { cpus: 4, memory: 12790032 },
} satisfies Record<typeof Size.Type, { cpus: number; memory: number }>;
const measure = prompt(
  "Run exactly: `nproc; grep MemTotal /proc/meminfo` and reply with its full output.",
  "run nproc; grep MemTotal /proc/meminfo\nsay {{out}}",
);
const reading = (text: string) => {
  const count = /^\s*(\d+)\s*$/m.exec(text)?.[1];
  const memory = /MemTotal:\s*(\d+) kB/.exec(text)?.[1];
  return count === undefined || memory === undefined
    ? undefined
    : { cpus: Number(count), memory: Number(memory) };
};
const refused = ["basic", "lite", "standard-9"];
const say = (word: string) => prompt(`Reply with only the word ${word}.`, `say ${word}`);

const CliError = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.String, message: Schema.String, hint: Schema.String }),
  }),
);

// The CLI as the owner runs it: its exit code, its JSON and anything on stderr.
const cli = (args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("bun", ["cli/main.ts", ...args, "--json"], { stdin: "ignore" }),
    );
    const text = (stream: typeof child.stdout) => stream.pipe(Stream.decodeText(), Stream.mkString);
    const [out, err] = yield* Effect.all([text(child.stdout), text(child.stderr)], {
      concurrency: 2,
    });
    return { out, err, exit: yield* child.exitCode };
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.mapError(() => failure("sizes", `scotty ${args.join(" ")} did not run`, "")),
  );

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const settings = yield* request("/api/settings", Settings);
  const max = settings.maxRunning;
  yield* check(
    max <= largest,
    `The stage's maxRunning is ${max}; set "maxRunning": 2 in its config and deploy`,
  );
  // Fill the cap with sessions of our own, so one of them can be stopped to make room.
  const fill = max - settings.running;
  yield* check(fill >= 1, `${settings.running} of ${max} slots are taken; stop a session first`);
  const made: string[] = [];
  // Stops and removes every session made so far, even when a check failed.
  const clean = Effect.suspend(() =>
    Effect.forEach(made.splice(0), (id) =>
      Effect.ignore(
        request(`/api/sessions/${id}/stop`, View, { method: "POST" }).pipe(
          Effect.andThen(request(`/api/sessions/${id}`, Removed, { method: "DELETE" })),
        ),
      ),
    ),
  );
  const create = (title: string, text: string, size?: typeof Size.Type, sessionKey?: string) =>
    Effect.gen(function* () {
      const session = yield* request("/api/sessions", Created, {
        method: "POST",
        key: crypto.randomUUID(),
        body: {
          title: `e2e sizes ${title} (${agent})`,
          repo: fixtureRepo,
          ...sessionAgent,
          prompt: text,
          provider: "cloudflare",
          ...(size === undefined ? {} : { size }),
          ...(sessionKey === undefined ? {} : { key: sessionKey }),
        },
      });
      made.push(session.id);
      console.log(`Session ${session.id} (${title})`);
      return `/api/sessions/${session.id}`;
    });
  const answered = (prefix: string, word: string) =>
    Effect.gen(function* () {
      yield* waiter(request, prefix)(
        () => request(`${prefix}/log`, Log),
        (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "0"),
      );
      const conversation = yield* request(`${prefix}/conversation`, Conversation);
      yield* check(
        conversation.turns[0]?.assistant.includes(word) === true,
        `${prefix} did not answer ${word}`,
      );
    });

  yield* Effect.gen(function* () {
    // 1. Up to the cap, sessions start and answer.
    const running: string[] = [];
    for (let i = 0; i < fill; i++) {
      const prefix = yield* create(`running ${i + 1}`, say(`ready${i + 1}`));
      yield* answered(prefix, `ready${i + 1}`);
      running.push(prefix);
    }
    console.log(`${fill} sessions running; the cap of ${max} is full`);

    // 2. One more stops before its container, with reason cap and the message.
    const extra = yield* create("over the cap", say("room"));
    const refused = yield* waiter(request, extra)(
      () => request(extra, View),
      (view) => view.session.authority.kind === "stable",
      { stopped: "expected" },
    );
    const authority = refused.session.authority;
    yield* check(
      authority.kind === "stable" &&
        authority.lifecycle === "stopped" &&
        authority.stop?.reason === "cap" &&
        authority.stop.max === max,
      `The session over the cap is not stopped with reason cap: ${JSON.stringify(authority)}`,
    );
    const message = `stopped · cap: ${max} sessions are running; stop one or raise maxRunning`;
    yield* check(state(refused.session) === message, `scotty shows "${state(refused.session)}"`);
    const log = yield* request(`${extra}/log`, Log);
    yield* check(
      !log.some((e) => e.kind === "sup.hello"),
      "A container started for the session over the cap",
    );
    console.log(`Refused: "${message}"`);

    // 3. Stopping one makes room; the refused session resumes and answers.
    const first = running[0];
    if (first === undefined) return yield* failure("sizes", "No session filled the cap", "");
    yield* request(`${first}/stop`, View, { method: "POST" });
    // The stop's destroy releases the slot after the stop returns; resume only once it has.
    yield* waiter(request, first)(
      () => Effect.all([request(first, View), request("/api/settings", Settings)]),
      ([view, now]) =>
        view.session.authority.kind === "stable" &&
        view.session.authority.lifecycle === "stopped" &&
        now.running < max,
      { stopped: "expected" },
    );
    console.log("Stopped one; its slot was released");
    yield* request(`${extra}/resume`, View, { method: "POST" });
    yield* answered(extra, "room");
    console.log("The refused session resumed and answered");
  }).pipe(Effect.ensuring(clean));

  // Sizes, one session at a time so a cap of 2 is enough.
  const suffix = crypto.randomUUID().slice(0, 8);
  const starter = `e2e-size-${suffix}`;
  const waker = `e2e-wake-${suffix}`;
  yield* Effect.gen(function* () {
    const freeSlot = Effect.gen(function* () {
      const started = Date.now();
      while ((yield* request("/api/settings", Settings)).running >= max) {
        if (Date.now() - started > 120_000)
          return yield* failure("sizes", "No running slot came free", "scotty ls");
        yield* Effect.sleep("2 seconds");
      }
    });
    const ended = (prefix: string, turn: string) =>
      waiter(request, prefix)(
        () => request(`${prefix}/log`, Log),
        (log) => log.some((e) => e.kind === "turn.ended" && e.turn === turn),
      );
    // Waits for the turn and checks its reading against the size's row in the table.
    const measured = (prefix: string, turn: string, size: typeof Size.Type) =>
      Effect.gen(function* () {
        yield* ended(prefix, turn);
        const conversation = yield* request(`${prefix}/conversation`, Conversation);
        const text = conversation.turns.at(-1)?.assistant ?? "";
        const found = reading(text);
        if (found === undefined)
          return yield* failure("sizes", `${prefix} answered no reading: ${text}`, "scotty read");
        console.log(`${size} (turn ${turn}): nproc ${found.cpus}, MemTotal ${found.memory} kB`);
        const expected = measuredSizes[size];
        yield* check(
          found.cpus === expected.cpus,
          `${size} has ${found.cpus} CPUs, not ${expected.cpus}`,
        );
        yield* check(
          Math.abs(found.memory - expected.memory) <= expected.memory * 0.05,
          `${size} has MemTotal ${found.memory} kB, not within 5% of ${expected.memory} kB`,
        );
        return found;
      });
    const readsSize = (id: string, size: typeof Size.Type) =>
      Effect.gen(function* () {
        const read = yield* cli(["read", id]);
        const shown = Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Struct({ size: Schema.String })),
        )(read.out);
        yield* check(
          Option.isSome(shown) && shown.value.size === size,
          `scotty read ${id} printed ${read.out}${read.err}, not size ${size}`,
        );
      });
    // Sends `measure` as the next turn. A steer's text is not a template, unlike an automation's
    // prompt, where the stand-in's `{{out}}` would be a missing payload field and skip the run.
    const measureNext = (prefix: string, turn: string, size: typeof Size.Type) =>
      Effect.gen(function* () {
        const req = crypto.randomUUID();
        yield* request(`${prefix}/steer`, Reply, {
          method: "POST",
          key: req,
          body: { req, turn, text: measure },
        });
        return yield* measured(prefix, turn, size);
      });
    const shows = (prefix: string, size: typeof Size.Type) =>
      Effect.gen(function* () {
        const view = yield* request(prefix, View);
        yield* check(
          view.session.display.size === size,
          `The session's size is ${view.session.display.size}, not ${size}`,
        );
      });
    const stopped = (prefix: string) =>
      Effect.gen(function* () {
        yield* request(`${prefix}/stop`, View, { method: "POST" });
        yield* waiter(request, prefix)(
          () => request(prefix, View),
          (view) =>
            view.session.authority.kind === "stable" &&
            view.session.authority.lifecycle === "stopped",
          { stopped: "expected" },
        );
        yield* freeSlot;
      });

    // 1. With no size a session is standard-1; at standard-3 it has standard-3's CPUs and memory.
    const key = `e2e-size-${suffix}`;
    yield* freeSlot;
    const small = yield* create("at no size", measure, undefined, key);
    yield* shows(small, "standard-1");
    yield* measured(small, "0", "standard-1");

    // 2. A wake from an automation at standard-2 reaches the standard-1 session, which stays so.
    yield* request("/api/automations", AutomationSwitched, {
      method: "POST",
      body: {
        name: waker,
        when: { kind: "interval", minutes: 7 * 24 * 60 },
        action: "wake",
        key,
        repo: fixtureRepo,
        agent,
        prompt: say("woke"),
        size: "standard-2",
        ...(real ? {} : { scripted: true }),
      },
    });
    const woke = yield* request(`/api/automations/${waker}/run`, RunFired, { method: "POST" });
    yield* check(
      woke.status === "steered" && woke.session === small.slice("/api/sessions/".length),
      `The wake's run is ${woke.status} (${woke.reason}) on ${woke.session}`,
    );
    yield* ended(small, "1");
    yield* measureNext(small, "2", "standard-1");
    yield* shows(small, "standard-1");
    console.log("A wake at standard-2 reached the standard-1 session; it stayed standard-1");
    yield* request(`${small}/stop`, View, { method: "POST" });

    yield* freeSlot;
    const big = yield* create("at standard-3", measure, "standard-3");
    yield* shows(big, "standard-3");
    const first = yield* measured(big, "0", "standard-3");

    // 3. Stopped and resumed by a steer, the bigger session reads the same again.
    yield* stopped(big);
    const again = yield* measureNext(big, "1", "standard-3");
    // Only the first start is an event; a resume's new container says hello on a later gen.
    yield* check(
      (yield* request(`${big}/log`, Log)).some((e) => e.kind === "sup.hello" && e.gen > 1),
      "The resume did not start a new container",
    );
    yield* check(
      again.cpus === first.cpus && again.memory === first.memory,
      `After the resume, standard-3 reads nproc ${again.cpus}, MemTotal ${again.memory} kB`,
    );
    console.log("standard-3 stopped, resumed and read the same");
    yield* clean;

    const endpoint = new URL("/mcp", url);
    const token = yield* access(endpoint.href);
    const mcp = new Client({ name: "scotty-e2e-sizes", version: "1.0.0" });
    const attempt = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: () => failure("sizes", `MCP ${what} failed`, "scotty doctor"),
      });
    yield* attempt("connect", () =>
      mcp.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { "cf-access-token": token } },
        }),
      ),
    );

    // 4. Stopped, a standard-1 session resumes at standard-3 with its files; running, it can't.
    yield* freeSlot;
    const resized = yield* create(
      "resized",
      prompt(
        "Run exactly: `echo kept > kept.txt` and reply with only the word written.",
        "run echo kept > kept.txt\nsay written",
      ),
    );
    const resizedId = resized.slice("/api/sessions/".length);
    yield* answered(resized, "written");
    const conflict = yield* request(`${resized}/resume`, View, {
      method: "POST",
      body: { size: "standard-3" },
    }).pipe(Effect.flip);
    yield* check(
      conflict.code === "running" && conflict.hint === `scotty stop ${resizedId}`,
      `A resize of the running session answered ${conflict.code}: ${conflict.message}`,
    );
    const byMcp = yield* attempt("resume_session", () =>
      mcp.callTool({ name: "resume_session", arguments: { id: resizedId, size: "standard-3" } }),
    );
    const mcpText = byMcp.content[0]?.type === "text" ? byMcp.content[0].text : "";
    yield* check(
      byMcp.isError === true && mcpText.includes("Stop the session before changing its size"),
      `MCP answered a resize of the running session with: ${mcpText}`,
    );
    const byCliRunning = yield* cli(["resume", resizedId, "--size", "standard-3"]);
    const cliConflict = Schema.decodeUnknownOption(CliError)(byCliRunning.out);
    yield* check(
      byCliRunning.exit === 1 &&
        Option.isSome(cliConflict) &&
        cliConflict.value.error.code === "running" &&
        cliConflict.value.error.hint === `scotty stop ${resizedId}`,
      `scotty resume --size on a running session exited ${byCliRunning.exit}: ${byCliRunning.out}${byCliRunning.err}`,
    );
    yield* shows(resized, "standard-1");
    yield* check(
      !(yield* request(`${resized}/log`, Log)).some((e) => e.kind === "resume.requested"),
      "A refused resize appended resume.requested",
    );
    console.log("A resize of a running session: 409 running, an MCP error, CLI exit 1");
    yield* stopped(resized);
    yield* request(`${resized}/resume`, View, { method: "POST", body: { size: "standard-3" } });
    yield* shows(resized, "standard-3");
    yield* readsSize(resizedId, "standard-3");
    yield* measureNext(resized, "1", "standard-3");
    const catReq = crypto.randomUUID();
    yield* request(`${resized}/steer`, Reply, {
      method: "POST",
      key: catReq,
      body: {
        req: catReq,
        turn: "2",
        text: prompt(
          "Run exactly: `cat kept.txt` and reply with its full output.",
          "run cat kept.txt\nsay {{out}}",
        ),
      },
    });
    yield* ended(resized, "2");
    const kept = (yield* request(`${resized}/conversation`, Conversation)).turns.at(-1)?.assistant;
    yield* check(kept?.includes("kept") === true, `After the resize, kept.txt reads ${kept}`);
    console.log("Stopped at standard-1, resumed at standard-3 with kept.txt");
    // A resume naming no size keeps standard-3; the CLI's --size changes it once more.
    yield* stopped(resized);
    yield* request(`${resized}/resume`, View, { method: "POST" });
    yield* shows(resized, "standard-3");
    yield* waiter(request, resized)(
      () => request(resized, View),
      (view) =>
        view.session.authority.kind === "stable" && view.session.authority.lifecycle === "running",
    );
    yield* stopped(resized);
    const cliResume = yield* cli(["resume", resizedId, "--size", "standard-2"]);
    const cliView = Schema.decodeUnknownOption(Schema.fromJsonString(View))(cliResume.out);
    yield* check(
      cliResume.exit === 0 &&
        Option.isSome(cliView) &&
        cliView.value.session.display.size === "standard-2",
      `scotty resume --size standard-2 printed ${cliResume.out}${cliResume.err}`,
    );
    console.log("A resume with no size stayed standard-3; scotty resume --size made it standard-2");
    yield* clean;

    // 5. lite, basic and unknown sizes are refused by the API, MCP and the CLI, naming the field.
    for (const size of refused) {
      const answer = yield* request("/api/sessions", Created, {
        method: "POST",
        key: crypto.randomUUID(),
        body: {
          title: "e2e sizes refused",
          repo: fixtureRepo,
          ...sessionAgent,
          prompt: say("no"),
          provider: "cloudflare",
          size,
        },
      }).pipe(Effect.flip);
      yield* check(
        answer.code === "bad_request" && answer.message.includes(`["size"]`),
        `The API answered size ${size} with ${answer.code}: ${answer.message}`,
      );
    }
    for (const size of refused) {
      const result = yield* attempt("new_session", () =>
        mcp.callTool({
          name: "new_session",
          arguments: { repo: fixtureRepo, prompt: say("no"), ...sessionAgent, size },
        }),
      );
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";
      yield* check(
        result.isError === true && text.includes(`["size"]`),
        `MCP answered size ${size} with: ${text}`,
      );
    }
    yield* attempt("close", () => mcp.close());
    // Piped, the CLI prints its errors as JSON on stdout; stderr stays empty.
    for (const size of refused) {
      const ran = yield* cli(["new", fixtureRepo, "no", "--size", size]);
      const error = Schema.decodeUnknownOption(CliError)(ran.out);
      yield* check(
        ran.exit === 2 &&
          Option.isSome(error) &&
          error.value.error.code === "usage" &&
          error.value.error.message.includes("--size"),
        `scotty new --size ${size} exited ${ran.exit}: ${ran.out}${ran.err}`,
      );
    }
    console.log(`Sizes ${refused.join(", ")}: 400 from the API, an MCP error, CLI exit 2`);

    // 6. A valid --size from the CLI makes a session that `scotty read` shows at that size. The CLI
    // starts the real agent; the check needs only the create and the read.
    yield* freeSlot;
    const byCli = yield* cli([
      "new",
      fixtureRepo,
      "Reply with only the word sized.",
      "--size",
      "standard-2",
    ]);
    const createdByCli = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
    )(byCli.out);
    if (byCli.exit !== 0 || Option.isNone(createdByCli))
      return yield* failure(
        "sizes",
        `scotty new --size standard-2 printed ${byCli.out}${byCli.err}`,
        "",
      );
    made.push(createdByCli.value.id);
    yield* readsSize(createdByCli.value.id, "standard-2");
    yield* clean;
    console.log("scotty new --size standard-2 made a session that reads standard-2");

    // 7. An automation's size reaches the session it starts.
    yield* request("/api/automations", AutomationSwitched, {
      method: "POST",
      body: {
        name: starter,
        when: { kind: "interval", minutes: 7 * 24 * 60 },
        repo: fixtureRepo,
        agent,
        prompt: say("sized"),
        size: "standard-2",
        ...(real ? {} : { scripted: true }),
      },
    });
    yield* freeSlot;
    const run = yield* request(`/api/automations/${starter}/run`, RunFired, { method: "POST" });
    if (run.session === null)
      return yield* failure(
        "sizes",
        `The automation's run is ${run.status} (${run.reason})`,
        "scotty runs",
      );
    made.push(run.session);
    yield* readsSize(run.session, "standard-2");
    yield* ended(`/api/sessions/${run.session}`, "0");
    yield* measureNext(`/api/sessions/${run.session}`, "1", "standard-2");
    console.log(`The automation's session ${run.session} reads standard-2`);
  }).pipe(
    Effect.ensuring(
      Effect.all([
        clean,
        ...[starter, waker].map((name) =>
          Effect.ignore(
            request(`/api/automations/${name}`, AutomationRemoved, { method: "DELETE" }),
          ),
        ),
      ]),
    ),
  );
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Sizes e2e failed");
  process.exitCode = 1;
});
