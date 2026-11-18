import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";

const Call = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^http:\/\/[a-z0-9][a-z0-9-]{0,39}\.internal\/api\//)),
  method: Schema.optionalKey(Schema.Literals(["GET", "POST", "DELETE"])),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(Schema.Literal("mcp")),
});
const Echo = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  method: Schema.String,
  url: Schema.String,
  data: Schema.String,
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

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
      if (options.response === "mcp") {
        if (!response.ok)
          return { output: JSON.stringify({ status: response.status }), exitCode: 1 };
        const text = yield* Effect.tryPromise(() => response.text());
        const payload = (response.headers.get("content-type") ?? "").includes("text/event-stream")
          ? text
              .split(/\r\n|\n|\r/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
          : text;
        const message = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(payload);
        return { output: JSON.stringify({ status: response.status, message }), exitCode: 0 };
      }
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

export const step: (line: string) => Step = (line) => {
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

export const fill = (text: string, out: string, recall: () => string) => {
  const filled = text.replaceAll("{{out}}", out);
  return filled.includes("{{recall}}") ? filled.replaceAll("{{recall}}", recall()) : filled;
};

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
