import { BunSocket } from "@effect/platform-bun";
import { Effect } from "effect";
import { WebSocketConstructor, type WebSocketLike } from "effect/unstable/socket/Socket";
import { access, CliFailure, client, Created, failure, target, View } from "../cli/client.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("terminal", message, "scotty doctor"));

// One terminal socket: everything the shell prints, and a wait for a marker or the close.
const shell = (socket: WebSocketLike) => {
  const decoder = new TextDecoder();
  let output = "";
  let closed = false;
  socket.addEventListener("message", (event) => {
    if (event.data instanceof Uint8Array) output += decoder.decode(event.data, { stream: true });
    else if (event.data instanceof ArrayBuffer)
      output += decoder.decode(new Uint8Array(event.data));
  });
  socket.addEventListener("close", () => (closed = true));
  const until = (done: () => boolean, what: string) =>
    Effect.tryPromise({
      try: async () => {
        const started = Date.now();
        while (!done()) {
          if (Date.now() - started > 20000) throw new Error(what);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      catch: () => failure("terminal", `Timed out waiting for ${what}`, "scotty doctor"),
    });
  return {
    type: (line: string) => socket.send(new TextEncoder().encode(`${line}\r`)),
    resize: (cols: number, rows: number) =>
      socket.send(JSON.stringify({ type: "resize", cols, rows })),
    see: (text: string) => until(() => output.includes(text), text),
    closed: until(() => closed, "the socket to close"),
    opened: until(() => socket.readyState === 1 || closed, "the socket to open").pipe(
      Effect.flatMap(() => check(!closed, "The terminal socket closed before opening")),
    ),
  };
};

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const token = yield* access(url);
  const request = client({ url, token });
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: "Step 12 terminal",
      repo: fixtureRepo,
      prompt: "Reply with only the word ready.",
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  yield* waiter(request, prefix)(
    () => request(`${prefix}/log`, Log),
    (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "0"),
  );
  const before = (yield* request(`${prefix}/log`, Log)).length;

  // 1. A login shell in the repository, sized by the dial and then by a resize.
  const endpoint = new URL(`${prefix}/terminal?cols=80&rows=24`, url);
  endpoint.protocol = "wss:";
  const connect = yield* WebSocketConstructor;
  const term = shell(connect(endpoint.href, { headers: { "cf-access-token": token } }));
  yield* term.opened;
  term.type("echo TERM-$((6*7))");
  yield* term.see("TERM-42");
  term.resize(100, 30);
  term.type("echo SIZE-$(stty size | tr ' ' x)");
  yield* term.see("SIZE-30x100");
  term.type("echo PWD-$(pwd)");
  yield* term.see("PWD-/workspace/repo");
  term.type("echo TOKENS-$(env | grep -ciE 'access_token|refresh_token|chatgpt|openai')");
  yield* term.see("TOKENS-0");
  console.log("Shell: TERM-42, 30x100 after resize, in the repo, no token in env");
  term.type("exit");
  yield* term.closed;
  console.log("exit closed the socket");
  const after = (yield* request(`${prefix}/log`, Log)).length;
  yield* check(after === before, `The terminal appended ${after - before} events`);

  // 2. Another site can't open it; a stopped session refuses it.
  const dial = (headers: Record<string, string>) =>
    Effect.tryPromise({
      try: () =>
        fetch(endpoint.href.replace("wss:", "https:"), {
          headers: { "cf-access-token": token, ...headers },
          signal: AbortSignal.timeout(15000),
        }).then((response) => response.status),
      catch: () => failure("network", "GET terminal failed", "scotty doctor"),
    });
  const foreign = yield* dial({ origin: "https://example.com" });
  yield* check(foreign === 403, `A foreign Origin got ${foreign}`);
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  const stopped = yield* dial({});
  yield* check(stopped === 502, `A stopped session answered ${stopped}`);
  console.log("Refused: foreign Origin 403, stopped session 502");
});

Effect.runPromise(program.pipe(Effect.provide(BunSocket.layerWebSocketConstructor))).catch(
  (error: unknown) => {
    console.error(error instanceof CliFailure ? error.message : "Terminal e2e failed");
    process.exitCode = 1;
  },
);
