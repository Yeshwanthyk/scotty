import { parseArgs, UsageError, usage } from "./args";
import { BackendError, createBackend } from "./backend";
import type { CliIo, LifecycleBackend, OutputMode } from "./types";

export type CliDeps = {
  backend?: LifecycleBackend;
  io?: CliIo;
};

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  let mode: OutputMode = argv.includes("--json") ? "json" : "text";
  try {
    const parsed = parseArgs(argv);
    mode = parsed.mode;
    const backend = deps.backend ?? createBackend({ onProgress: (text) => io.stderr(text) });
    switch (parsed.action) {
      case "up": {
        const result = await backend.up({
          force: parsed.force,
          ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
          ...(parsed.project === undefined ? {} : { project: parsed.project }),
          ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
          ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
          ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
          ...(parsed.session === undefined ? {} : { session: parsed.session }),
        });
        render(io, mode, result, [
          `ID:    ${result.id}`,
          `Status: ${result.status}`,
          `Phone: ${result.url}`,
          ...(result.ssh === undefined ? [] : [`SSH:   ${result.ssh}`]),
        ]);
        return 0;
      }
      case "down": {
        const result = await backend.down({
          id: requiredId(parsed.id),
          force: parsed.force,
          ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
        });
        render(io, mode, result, [
          `ID:     ${result.id}`,
          "Status: down",
          `Resume: ${result.resume.join(" ")}`,
        ]);
        return 0;
      }
      case "vaporize": {
        const result = await backend.vaporize(requiredId(parsed.id));
        render(io, mode, result, [
          `ID:     ${result.id}`,
          "Status: vaporized",
          `Resume: scotty beam resume ${result.id}`,
        ]);
        return 0;
      }
      case "resume": {
        const result = await backend.resume(requiredId(parsed.id));
        render(io, mode, result, [
          `ID:     ${result.id}`,
          `Status: ${result.status}`,
          `Phone:  ${result.url}`,
        ]);
        return 0;
      }
      case "list": {
        const result = await backend.list(parsed.all);
        render(io, mode, result, result.sessions.length === 0
          ? ["No Scotty sessions."]
          : result.sessions.flatMap((session) => [
            `${session.id}  ${session.status}  ${session.provider}  ${session.project}`,
            ...(session.title === null ? [] : [`  Title:   ${session.title}`]),
            `  Updated: ${formatTime(session.updatedAt)}`,
            `  Queued:  ${session.queuedPrompts}`,
            `  Phone: ${session.url}`,
            ...(session.ssh === undefined ? [] : [`  SSH:   ${session.ssh}`]),
            ...(session.deleted ? ["  Removed: yes"] : []),
          ]));
        return 0;
      }
      case "status": {
        const result = await backend.status(requiredId(parsed.id));
        render(io, mode, result, [
          `ID:       ${result.id}`,
          `Status:   ${result.status}`,
          `Provider: ${result.provider}`,
          `Project:  ${result.project}`,
          `Queued:   ${result.queuedPrompts}`,
          `Updated:  ${formatTime(result.updatedAt)}`,
          `Heartbeat:${formatOptionalTime(result.heartbeatAt)}`,
          `Flush:    ${formatOptionalTime(result.flushAt)}`,
          `Phone:    ${result.url}`,
          ...(result.ssh === undefined ? [] : [`SSH:      ${result.ssh}`]),
          ...(result.deleted ? ["Removed:  yes"] : []),
          ...(result.error === null ? [] : [`Error:    ${result.error}`]),
        ]);
        return 0;
      }
      case "help": {
        const text = helpText(parsed.id);
        if (mode === "json") io.stdout(`${JSON.stringify({ ok: true, help: text })}\n`);
        else io.stdout(`${text}\n`);
        return 0;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === "json") io.stdout(`${JSON.stringify({ ok: false, error: message })}\n`);
    else {
      const suffix = error instanceof UsageError && message !== usage ? `\n${usage}` : "";
      io.stderr(`scotty: ${message}${suffix}\n`);
    }
    return error instanceof BackendError ? error.exitCode : 1;
  }
}

function requiredId(id: string | undefined): string {
  if (id === undefined) throw new UsageError("missing Scotty session id");
  return id;
}

function render(io: CliIo, mode: OutputMode, result: unknown, lines: string[]): void {
  if (mode === "json") io.stdout(`${JSON.stringify({ ok: true, ...asObject(result) }, null, 2)}\n`);
  else io.stdout(`${lines.join("\n")}\n`);
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : { result: value };
}

function helpText(command: string | undefined): string {
  if (command === undefined) return `${usage}\n\nLifecycle: up creates the id; down, vaporize, and resume use it. Read-only: list and status.`;
  const topics: Record<string, string> = {
    up: "scotty beam up\nCapture the current local agent session, start its cloud copy, and return the stable id and phone URL. Use --project owner/repo for a fresh cloud session.",
    down: "scotty beam down <id>\nFlush and suspend the cloud session, then materialize it on this machine. Scotty marks it pulled only after the local restore verifies.",
    vaporize: "scotty beam vaporize <id>\nFlush durable state and remove running compute. The id remains resumable. The idle timer invokes the same operation automatically.",
    resume: "scotty beam resume <id>\nRestore or wake a vaporized session and return its unchanged phone URL.",
    list: "scotty beam list [--all]\nList cloud sessions directly from the control plane. --all includes removed session tombstones.",
    status: "scotty beam status <id>\nShow one session's state, project, provider, queued work, freshness, and phone URL.",
    help: "scotty beam help [command]\nShow the command contract without contacting the control plane.",
  };
  const topic = topics[command];
  if (topic === undefined) throw new UsageError(`unknown help command ${command}`);
  return topic;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function formatOptionalTime(timestamp: number | null): string {
  return timestamp === null ? " never" : ` ${formatTime(timestamp)}`;
}
