// The scripts the e2e stand-ins for Codex and Claude read from each prompt, one directive per line:
//   run <command>   runs it with bash in the repository, as the agent's shell tool would
//   sleep <seconds> the same as `run sleep <seconds>`, so an interrupt stops it
//   call <JSON>     calls {url, method?, headers?, body?}; echo auth values are hashed, not emitted
//   say <text>      replies with the text; {{out}} is the last command's output, trimmed, and
//                   {{recall}} the session's first prompt, read back from its saved state file
// Any other line is replied as it is. A steer adds its lines to the running turn.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";

const Call = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^http:\/\/[a-z0-9][a-z0-9-]{0,39}\.internal\/api\//)),
  method: Schema.optionalKey(Schema.Literals(["GET", "POST", "DELETE"])),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optionalKey(Schema.String),
});
const Echo = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  method: Schema.String,
  url: Schema.String,
  data: Schema.String,
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// Public echo targets reflect credentials. Only digests reach tool output or a saved transcript.
export const call = (options: typeof Call.Type, signal: AbortSignal) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise(() =>
        fetch(options.url, {
          method: options.method ?? "GET",
          headers: options.headers,
          body: options.body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        }),
      );
      const echo = yield* Schema.decodeUnknownEffect(Echo)(
        yield* Effect.tryPromise(() => response.json()),
      );
      const headers = Object.fromEntries(
        Object.entries(echo.headers).map(([key, values]) => [key.toLowerCase(), values.join(", ")]),
      );
      return {
        output: JSON.stringify({
          status: response.status,
          method: echo.method,
          url: echo.url,
          bodyHash: hash(echo.data),
          headerHashes: Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [key, hash(value)]),
          ),
          mcpSession: headers["mcp-session-id"] ?? null,
          mcpVersion: headers["mcp-protocol-version"] ?? null,
          lastEvent: headers["last-event-id"] ?? null,
        }),
        exitCode: 0,
      };
    }).pipe(Effect.orElseSucceed(() => ({ output: "Reach call failed", exitCode: 1 }))),
  );

export type Step =
  | { readonly kind: "run"; readonly command: string }
  | { readonly kind: "call"; readonly command: string; readonly options: typeof Call.Type }
  | { readonly kind: "say"; readonly text: string };

export const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

export const step = (line: string): Step => {
  const trimmed = line.trim();
  const [word = ""] = trimmed.split(/\s+/);
  const argument = trimmed.slice(word.length).trim();
  if (word === "run") return { kind: "run", command: argument };
  if (word === "sleep") return { kind: "run", command: `sleep ${Number(argument) || 0}` };
  if (word === "call") {
    const options = Schema.decodeUnknownOption(Schema.fromJsonString(Call))(argument);
    return Option.isSome(options)
      ? { kind: "call", command: trimmed, options: options.value }
      : { kind: "say", text: "Invalid call directive" };
  }
  return { kind: "say", text: word === "say" ? argument : trimmed };
};

// recall reads the state file, so it runs only when the text asks for it; what it brings back
// is inserted as it is.
export const fill = (text: string, out: string, recall: () => string) => {
  const filled = text.replaceAll("{{out}}", out);
  return filled.includes("{{recall}}") ? filled.replaceAll("{{recall}}", recall()) : filled;
};

// Runs a command with bash; `started` receives the child so an interrupt can kill it. Like the
// agents' shell tools it returns when bash exits, not when every process holding its output
// does: a server started with `&` keeps the pipe open. Output already written is drained first.
export const shell = (command: string, cwd: string, started: (child: ChildProcess) => void) =>
  new Promise<{ output: string; exitCode: number }>((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    started(child);
    let output = "";
    let exitCode = 1;
    const done = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ output, exitCode });
    };
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("close", done);
    child.on("exit", (code) => {
      exitCode = code ?? 1;
      setTimeout(done, 200);
    });
  });
