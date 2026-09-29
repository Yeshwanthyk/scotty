import { BunServices } from "@effect/platform-bun";
import { Effect, Schema, Stdio, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { List, type Session, Url, access, client, failure, target } from "../client.js";
import { readConfig } from "../config.js";

// JSON when piped or asked for; readable text in a terminal.
export const json = process.argv.includes("--json") || !process.stdout.isTTY;
const colour = !json && process.env.NO_COLOR === undefined;
const paint = (code: number) => (text: string) =>
  colour ? `\u001b[${code}m${text}\u001b[0m` : text;
export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const dim = paint(2);
export const bold = paint(1);

export const output = (value: unknown, text?: string) =>
  Effect.sync(() => {
    console.log(json || text === undefined ? JSON.stringify(value) : text);
  });

// SCOTTY_URL wins, so a broken config file doesn't block it.
export const address = Effect.gen(function* () {
  const env = process.env.SCOTTY_URL;
  if (env === undefined || env === "") {
    const config = yield* readConfig;
    return yield* target(config === undefined ? "" : `https://${config.host}`);
  }
  return yield* Schema.decodeUnknownEffect(Url)(env).pipe(
    Effect.mapError(() =>
      failure("setup", `SCOTTY_URL is not an https origin: ${env}`, "unset SCOTTY_URL", 2),
    ),
  );
});
export const withClient = Effect.gen(function* () {
  const url = yield* address;
  return Object.assign(client({ url, token: yield* access(url) }), { url });
});
export type Api = Effect.Success<typeof withClient>;

export const usage = (message: string, command: string) =>
  failure("usage", message, `scotty ${command} --help`, 2);

const idPattern = /^[a-z0-9-]{4,32}$/;

// Full ids, or prefixes of listed sessions (4+ characters); the list is fetched once.
export const sessionIds = (api: Api, ids: readonly string[], command: string) =>
  Effect.gen(function* () {
    if (!ids.every((id) => idPattern.test(id)))
      return yield* usage("A session id is 4–32 lowercase letters, digits or hyphens", command);
    if (ids.every((id) => id.length === 32)) return ids;
    const { sessions } = yield* api("/api/sessions", List);
    return yield* Effect.forEach(ids, (id) => {
      if (id.length === 32) return Effect.succeed(id);
      const found = sessions.filter((session) => session.identity.id.startsWith(id));
      const [only, ...more] = found;
      if (only === undefined)
        return Effect.fail(failure("not_found", `No session starts with ${id}`, "scotty ls"));
      if (more.length > 0)
        return Effect.fail(
          failure("ambiguous", `${found.length} sessions start with ${id}`, "scotty ls"),
        );
      return Effect.succeed(only.identity.id);
    });
  });

export const sessionPath = (api: Api, id: string, command: string) =>
  sessionIds(api, [id], command).pipe(Effect.map(([full]) => `/api/sessions/${full ?? id}`));

export const state = (session: typeof Session.Type) =>
  session.authority.kind === "transitioning"
    ? "starting"
    : session.progress.working
      ? "working"
      : session.authority.lifecycle;

export const readStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
}).pipe(Effect.provide(BunServices.layer));

export const launch = (url: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.platform === "darwin" ? "open" : "xdg-open", [url], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    yield* child.exitCode;
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.mapError(() => failure("open_failed", "Could not open a browser", `Open ${url}`)),
  );

export const short = (id: string) => id.slice(0, 8);

export const ago = (iso: string) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

export const table = (rows: readonly (readonly string[])[]) => {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};
