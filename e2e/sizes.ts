import { BunServices } from "@effect/platform-bun";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Effect, Schema, Stream } from "effect";
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

// `nproc` at each size: Cloudflare's 1/2 vCPU shows as one CPU.
const cpus = { "standard-1": 1, "standard-3": 2 } as const;
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

// The CLI as the owner runs it: its exit code and its JSON.
const cli = (args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("bun", ["cli/main.ts", ...args, "--json"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    const out = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
    return { out, exit: yield* child.exitCode };
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
  const create = (title: string, text: string, size?: typeof Size.Type) =>
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
  const automation = `e2e-size-${crypto.randomUUID().slice(0, 8)}`;
  yield* Effect.gen(function* () {
    const freeSlot = Effect.gen(function* () {
      const started = Date.now();
      while ((yield* request("/api/settings", Settings)).running >= max) {
        if (Date.now() - started > 120_000)
          return yield* failure("sizes", "No running slot came free", "scotty ls");
        yield* Effect.sleep("2 seconds");
      }
    });
    const measured = (prefix: string, turn: string) =>
      Effect.gen(function* () {
        yield* waiter(request, prefix)(
          () => request(`${prefix}/log`, Log),
          (log) => log.some((e) => e.kind === "turn.ended" && e.turn === turn),
        );
        const conversation = yield* request(`${prefix}/conversation`, Conversation);
        const text = conversation.turns.at(-1)?.assistant ?? "";
        const found = reading(text);
        if (found === undefined)
          return yield* failure("sizes", `${prefix} answered no reading: ${text}`, "scotty read");
        return found;
      });
    const sized = (size: keyof typeof cpus | undefined) =>
      Effect.gen(function* () {
        yield* freeSlot;
        const name = size ?? "standard-1";
        const prefix = yield* create(`at ${size ?? "no size"}`, measure, size);
        const view = yield* request(prefix, View);
        yield* check(
          view.session.display.size === name,
          `The session's size is ${view.session.display.size}, not ${name}`,
        );
        const found = yield* measured(prefix, "0");
        console.log(`${name}: nproc ${found.cpus}, MemTotal ${found.memory} kB`);
        yield* check(
          found.cpus === cpus[name],
          `${name} has ${found.cpus} CPUs, not ${cpus[name]}`,
        );
        return { prefix, found };
      });

    // 1. With no size and at standard-3, a session has that size's CPUs; the bigger has more memory.
    const small = yield* sized(undefined);
    yield* request(`${small.prefix}/stop`, View, { method: "POST" });
    const big = yield* sized("standard-3");
    yield* check(
      big.found.memory > small.found.memory,
      `standard-3 has ${big.found.memory} kB, not more than standard-1's ${small.found.memory} kB`,
    );

    // 2. Stopped and resumed by a steer, the bigger session reads the same again.
    yield* request(`${big.prefix}/stop`, View, { method: "POST" });
    yield* waiter(request, big.prefix)(
      () => request(big.prefix, View),
      (view) =>
        view.session.authority.kind === "stable" && view.session.authority.lifecycle === "stopped",
      { stopped: "expected" },
    );
    yield* freeSlot;
    const req = crypto.randomUUID();
    yield* request(`${big.prefix}/steer`, Reply, {
      method: "POST",
      key: req,
      body: { req, turn: "1", text: measure },
    });
    const again = yield* measured(big.prefix, "1");
    const starts = (yield* request(`${big.prefix}/log`, Log)).filter(
      (e) => e.kind === "container.start",
    );
    yield* check(starts.length >= 2, "The resume did not start a new container");
    yield* check(
      again.cpus === big.found.cpus && again.memory === big.found.memory,
      `After the resume, standard-3 reads nproc ${again.cpus}, MemTotal ${again.memory} kB`,
    );
    console.log("standard-3 stopped, resumed and read the same");
    yield* clean;

    // 3. lite, basic and unknown sizes are refused by the API, MCP and the CLI, naming the field.
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
    for (const size of refused) {
      const result = yield* attempt("new_session", () =>
        mcp.callTool({
          name: "new_session",
          arguments: { repo: fixtureRepo, prompt: say("no"), ...sessionAgent, size },
        }),
      );
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      yield* check(
        result.isError === true && text.includes(`["size"]`),
        `MCP answered size ${size} with: ${text}`,
      );
    }
    yield* attempt("close", () => mcp.close());
    for (const size of refused) {
      const ran = yield* cli(["new", fixtureRepo, "no", "--size", size]);
      yield* check(ran.exit === 2, `scotty new --size ${size} exited ${ran.exit}, not 2`);
    }
    console.log(`Sizes ${refused.join(", ")}: 400 from the API, an MCP error, CLI exit 2`);

    // 4. An automation's size reaches the session it starts.
    yield* request("/api/automations", AutomationSwitched, {
      method: "POST",
      body: {
        name: automation,
        when: { kind: "interval", minutes: 7 * 24 * 60 },
        repo: fixtureRepo,
        agent,
        prompt: say("sized"),
        size: "standard-2",
        ...(real ? {} : { scripted: true }),
      },
    });
    yield* freeSlot;
    const run = yield* request(`/api/automations/${automation}/run`, RunFired, { method: "POST" });
    if (run.session === null)
      return yield* failure(
        "sizes",
        `The automation's run is ${run.status} (${run.reason})`,
        "scotty runs",
      );
    made.push(run.session);
    const read = yield* cli(["read", run.session]);
    const shown = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ size: Schema.String })),
    )(read.out).pipe(
      Effect.mapError(() => failure("sizes", `scotty read printed ${read.out}`, "")),
    );
    yield* check(shown.size === "standard-2", `scotty read shows size ${shown.size}`);
    console.log(`The automation's session ${run.session} reads standard-2`);
  }).pipe(
    Effect.ensuring(
      Effect.all([
        clean,
        Effect.ignore(
          request(`/api/automations/${automation}`, AutomationRemoved, { method: "DELETE" }),
        ),
      ]),
    ),
  );
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Sizes e2e failed");
  process.exitCode = 1;
});
