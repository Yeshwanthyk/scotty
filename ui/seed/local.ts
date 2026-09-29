// Dev tool: turns the owner's own recent agent sessions (Codex, Claude, Pi) into seed event logs
// in `ui/seed/local/`, which is git-ignored: they hold private work and are never committed.
// Every import goes through `codexLog`, so Claude and Pi sessions render in the Codex shape;
// their titles say which agent ran them.
//   bun ui/seed/local.ts [count per agent, default 4]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { codexLog, type DummySpec, type Spec } from "./dummy.ts";

type Json = Record<string, unknown>;
type Turn = DummySpec["turns"][number];

const rec = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const clip = (text: string, max = 6000) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line === "" ? [] : [rec(JSON.parse(line))];
      } catch {
        return [];
      }
    });
const texts = (content: unknown) =>
  typeof content === "string"
    ? content
    : list(content)
        .map((part) => str(rec(part).text))
        .filter((text) => text !== "")
        .join("\n");

const files = (root: string, match: (name: string) => boolean): string[] => {
  try {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => match(basename(name)))
      .map((name) => join(root, name));
  } catch {
    return [];
  }
};
const newest = (paths: string[]) =>
  paths
    .map((path) => ({ path, mtime: statSync(path).mtimeMs, size: statSync(path).size }))
    .filter((file) => file.size > 20_000)
    .sort((a, b) => b.mtime - a.mtime);

// A line-by-line diff of an edit: enough for the patch rows, not a real unified diff.
const editDiff = (before: string, after: string) =>
  [
    "@@ edit @@",
    ...before.split("\n").map((line) => `-${line}`),
    ...after.split("\n").map((line) => `+${line}`),
  ].join("\n");

// Claude and Pi tools as Codex items: shells and reads as commands, edits as patches, the rest
// as MCP calls named after the tool.
function tool(name: string, input: Json, output: string, failed: boolean, cwd: string): Spec {
  const path = (key: string) => relative(cwd, str(input[key])) || str(input[key]);
  const cmd = (command: string, actions?: Json[]): Spec => ({
    type: "cmd",
    command,
    output: clip(output),
    exitCode: failed ? 1 : 0,
    ...(actions === undefined ? {} : { actions }),
  });
  switch (name.toLowerCase()) {
    case "bash":
      return cmd(str(input.command));
    case "read": {
      const file = path(input.file_path === undefined ? "path" : "file_path");
      const command = `sed -n '1,200p' ${file}`;
      return cmd(command, [{ type: "read", command, name: basename(file), path: file }]);
    }
    case "grep":
    case "glob": {
      const query = str(input.pattern);
      const command = `rg -n "${query}" ${str(input.path) || "."}`;
      return cmd(command, [{ type: "search", command, query, path: str(input.path) || "." }]);
    }
    case "edit":
    case "write":
      if (input.file_path === undefined && input.path === undefined) break;
      return {
        type: "patch",
        changes: [
          {
            path: path(input.file_path === undefined ? "path" : "file_path"),
            kind: name.toLowerCase() === "write" ? "add" : "update",
            diff:
              name.toLowerCase() === "write"
                ? str(input.content)
                : editDiff(
                    str(input.old_string ?? input.oldText),
                    str(input.new_string ?? input.newText),
                  ),
          },
        ],
      };
    case "websearch":
      return { type: "web", query: str(input.query) };
    case "webfetch":
      return { type: "web", url: str(input.url) };
    case "agent":
    case "task":
      return { type: "agent", tool: "spawnAgent", prompt: clip(str(input.prompt), 2000) };
  }
  const [server, ...rest] = name.startsWith("mcp__") ? name.slice(5).split("__") : ["tool", name];
  return {
    type: "mcp",
    server: server ?? "tool",
    tool: rest.join("__") || name,
    args: input,
    result: clip(output),
    failed,
  };
}

const repoOf = (url: string, cwd: string) =>
  /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? `local/${basename(cwd) || "session"}`;
const titleOf = (agent: string, prompt: string) =>
  `${agent}: ${
    prompt
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.replace(/^#+\s*/, "") ?? "Session"
  }`.slice(0, 80);

// Turn times come from the transcript: first to last timestamp in the turn.
function timed(turns: { turn: Turn; start: number; end: number }[]): Turn[] {
  return turns.map(({ turn, start, end }) => ({
    ...turn,
    seconds: Math.max(5, Math.min(3600, (end - start) / 1000)) || 40,
  }));
}

function codex(file: string): Omit<DummySpec, "id" | "minutesAgo"> | undefined {
  let cwd = "/";
  let repo = "";
  let current: { turn: Turn; start: number; end: number } | undefined;
  const turns: NonNullable<typeof current>[] = [];
  for (const line of lines(file)) {
    const payload = rec(line.payload);
    const at = Date.parse(str(line.timestamp)) || 0;
    if (line.type === "session_meta") {
      if (typeof payload.source !== "string") return undefined; // A subagent's own thread.
      cwd = str(payload.cwd) || cwd;
      repo = repoOf(str(rec(payload.git).repository_url), cwd);
    }
    if (current !== undefined) current.end = at || current.end;
    if (payload.type === "turn_aborted" && current !== undefined) current.turn.end = "interrupted";
    if (payload.type !== "item_completed") continue;
    const item = rec(payload.item);
    const rel = (path: string) => relative(cwd, path) || path;
    if (item.type === "UserMessage") {
      const prompt = list(item.content)
        .map((part) => str(rec(part).text))
        .join("\n")
        .trim();
      if (prompt === "") continue;
      current = { turn: { prompt: clip(prompt, 4000), items: [] }, start: at, end: at };
      turns.push(current);
      continue;
    }
    if (current === undefined) continue;
    const items = current.turn.items;
    switch (item.type) {
      case "Reasoning": {
        const summary = list(item.summary_text)
          .map(str)
          .filter((part) => part !== "");
        if (summary.length > 0) items.push({ type: "think", summary });
        break;
      }
      case "AgentMessage":
        items.push({
          type: "say",
          text: texts(item.content),
          phase: item.phase === "commentary" ? "commentary" : "final_answer",
        });
        break;
      case "CommandExecution": {
        const argv = list(item.command).map(str);
        const command = argv.length === 3 && argv[1] === "-lc" ? (argv[2] ?? "") : argv.join(" ");
        const duration = rec(item.duration);
        items.push({
          type: "cmd",
          command,
          output: clip(str(item.aggregated_output)),
          exitCode: num(item.exit_code) ?? 0,
          ms: Math.round((num(duration.secs) ?? 0) * 1000 + (num(duration.nanos) ?? 0) / 1e6),
          actions: list(item.parsed_cmd).map((parsed) => {
            const action = rec(parsed);
            const type = action.type === "list_files" ? "listFiles" : str(action.type);
            return { ...action, type, command: str(action.cmd) || command };
          }),
        });
        break;
      }
      case "FileChange":
        items.push({
          type: "patch",
          changes: Object.entries(rec(item.changes)).map(([path, value]) => {
            const change = rec(value);
            const kind = change.type === "add" || change.type === "delete" ? change.type : "update";
            return {
              path: rel(path),
              kind,
              diff: clip(str(change.unified_diff) || str(change.content), 20_000),
            };
          }),
        });
        break;
      case "McpToolCall":
        items.push({
          type: "mcp",
          server: str(item.server),
          tool: str(item.tool),
          args: rec(item.arguments),
          result: clip(texts(rec(item.result).content)),
          failed: item.status === "failed",
        });
        break;
      case "Extension": {
        const action = rec(item.action);
        if (item.kind !== "web.search") break;
        items.push(
          action.type === "openPage"
            ? { type: "web", url: str(action.url) }
            : { type: "web", query: str(item.query) || str(action.query) },
        );
        break;
      }
      case "CollabAgentToolCall":
        items.push({ type: "agent", tool: item.tool === "wait" ? "wait" : "spawnAgent" });
        break;
      case "ImageView":
        items.push({ type: "image", path: rel(str(item.path)) });
        break;
      case "ContextCompaction":
        items.push({ type: "compact" });
        break;
    }
  }
  const first = turns[0];
  if (first === undefined) return undefined;
  return { title: titleOf("Codex", first.turn.prompt), repo, turns: timed(turns) };
}

// Claude (`~/.claude/projects`) and Pi (`~/.pi/agent/sessions`): a user prompt opens a turn;
// tool calls wait for their results by id.
function transcript(agent: "Claude" | "Pi", file: string) {
  let cwd = "/";
  let current: { turn: Turn; start: number; end: number } | undefined;
  const turns: NonNullable<typeof current>[] = [];
  const results = new Map<string, { output: string; failed: boolean }>();
  const all = lines(file);
  for (const line of all) {
    const message = rec(line.message);
    for (const part of list(message.content).map(rec))
      if (part.type === "tool_result")
        results.set(str(part.tool_use_id), {
          output: texts(part.content),
          failed: part.is_error === true,
        });
    if (message.role === "toolResult")
      results.set(str(message.toolCallId), {
        output: texts(message.content),
        failed: message.isError === true,
      });
  }
  for (const line of all) {
    if (line.isSidechain === true || line.isMeta === true) continue;
    cwd = str(line.cwd) || cwd;
    const message = rec(line.message);
    const at = Date.parse(str(line.timestamp)) || num(line.timestamp) || 0;
    if (current !== undefined) current.end = at || current.end;
    const content = list(message.content).map(rec);
    if (message.role === "user") {
      if (content.some((part) => part.type === "tool_result")) continue;
      const prompt = texts(message.content).trim();
      if (prompt === "" || prompt.startsWith("<")) continue;
      current = { turn: { prompt: clip(prompt, 4000), items: [] }, start: at, end: at };
      turns.push(current);
      continue;
    }
    if (message.role !== "assistant" || current === undefined) continue;
    for (const part of content) {
      if (part.type === "thinking" && str(part.thinking).trim() !== "")
        current.turn.items.push({ type: "think", summary: [clip(str(part.thinking), 4000)] });
      if (part.type === "text" && str(part.text).trim() !== "")
        current.turn.items.push({ type: "say", text: str(part.text) });
      if (part.type === "tool_use" || part.type === "toolCall") {
        const result = results.get(str(part.id)) ?? { output: "", failed: false };
        const input = rec(part.input ?? part.arguments);
        current.turn.items.push(tool(str(part.name), input, result.output, result.failed, cwd));
      }
    }
  }
  const first = turns[0];
  if (first === undefined) return undefined;
  return {
    title: titleOf(agent, first.turn.prompt),
    repo: `local/${basename(cwd)}`,
    turns: timed(turns),
  };
}

const count = Number(process.argv[2] ?? 4) || 4;
const home = homedir();
const out = new URL("local/", import.meta.url);
mkdirSync(out, { recursive: true });
const sources: [string, string[], (file: string) => ReturnType<typeof codex>][] = [
  [
    "codex",
    files(join(home, ".codex/sessions"), (name) => /^rollout-.*\.jsonl$/.test(name)),
    codex,
  ],
  [
    "claude",
    files(join(home, ".claude/projects"), (name) => name.endsWith(".jsonl")),
    (file) => transcript("Claude", file),
  ],
  [
    "pi",
    files(join(home, ".pi/agent/sessions"), (name) => name.endsWith(".jsonl")),
    (file) => transcript("Pi", file),
  ],
];
for (const [agent, paths, convert] of sources) {
  let written = 0;
  for (const file of newest(paths)) {
    if (written >= count) break;
    const spec = convert(file.path);
    const items = spec?.turns.reduce((sum, turn) => sum + turn.items.length, 0) ?? 0;
    if (spec === undefined || items < 10) continue;
    const id = createHash("sha256").update(file.path).digest("hex").slice(0, 32);
    const turns = spec.turns.slice(-40);
    // Started early enough that its last event lands at the file's last write.
    const spent = turns.reduce((sum, turn) => sum + (turn.seconds ?? 40) + 47, 0) / 60;
    const minutesAgo = (Date.now() - file.mtime) / 60_000 + spent;
    const log = codexLog({ ...spec, id, minutesAgo, turns });
    writeFileSync(new URL(`${agent}-${id}.json`, out), JSON.stringify(log));
    written += 1;
  }
  // Counts only: the sessions themselves are private.
  console.log(`${agent}: ${written} session(s) written to ui/seed/local/`);
}
