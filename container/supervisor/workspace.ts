import { Clock, Effect, Fiber, FileSystem, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fixtureRepo, Workspace } from "../../protocol/supervisor.js";
import type { Agent } from "./agents/agent.js";
import { notTmpfs, onTmpfs } from "./place.js";
import { processEnv, runDir } from "./runtime.js";

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}
const failure = () => new WorkspaceError({ message: "workspace command failed" });
class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  stderr: Schema.String,
}) {}
const exec = (args: string[], cwd: string) =>
  Effect.gen(function* () {
    const [command, ...parameters] = args;
    if (command === undefined) return yield* failure();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, parameters, {
            cwd,
            extendEnv: false,
            forceKillAfter: "2 seconds",
            env: {
              PATH: processEnv("PATH"),
              HOME: processEnv("HOME") || "/home/scotty",
              GIT_TERMINAL_PROMPT: "0",
              GIT_HTTP_LOW_SPEED_LIMIT: "1000",
              GIT_HTTP_LOW_SPEED_TIME: "30",
            },
          }),
        );
        const stderr = yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.forkScoped,
        );
        const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.runCollect);
        const code = yield* child.exitCode;
        if (code !== ChildProcessSpawner.ExitCode(0))
          return yield* new CommandFailed({ stderr: (yield* Fiber.join(stderr)).slice(-2000) });
        return output.join("").trim();
      }),
    );
  });
const described = (error: unknown) => {
  const line =
    error instanceof CommandFailed
      ? error.stderr.trim().split("\n").at(-1)?.trim()
      : error instanceof Error
        ? error.name
        : undefined;
  return line
    ? new WorkspaceError({ message: `workspace command failed: ${line.slice(0, 300)}` })
    : failure();
};
const run = (args: string[], cwd: string) => exec(args, cwd).pipe(Effect.mapError(described));

const transient = (error: unknown) =>
  error instanceof CommandFailed &&
  /error: (429|5\d\d)|RPC failed|early EOF|Connection reset/.test(error.stderr) &&
  !/error: 4(?!29)\d\d/.test(error.stderr);
const backoff = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);
const retryBudget = 240_000;
const fromGitHub = (args: string[], cwd: string, retried: string[], until: number) =>
  exec(args, cwd).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (transient(error)) retried.push(described(error).message);
      }),
    ),
    Effect.retry({
      schedule: backoff,
      while: (error) =>
        Effect.map(Clock.currentTimeMillis, (now) => transient(error) && now < until),
    }),
    Effect.mapError(described),
  );

const workspaceRoot = () => processEnv("SCOTTY_WORKSPACE_ROOT") || "/workspace";
const saveFile = () => `${workspaceRoot()}/save.tar`;

const saveScript = `set -e
out="$1"; base="$2"; home="$3"; kind="$4"; dir="$5"; name="$6"; s=$(mktemp -d)
git diff -z --name-only --no-renames --diff-filter=D "$base" > "$s/deleted"
{ git diff -z --name-only --no-renames --diff-filter=d "$base"; git ls-files -z --others --exclude-standard; } > "$s/list"
state=$(cd "$home" && find "$dir" -name "$name" | head -n 1)
test -n "$state"
tar -cf "$out" -C "$s" deleted
tar -rf "$out" --null -T "$s/list" --transform 's,^,repo/,S'
tar -rf "$out" -C "$home" --transform "s,^,$kind/,S" "$state"
rm -rf "$s"`;

export const saveWorkspace = (base: string, agent: Agent, session: string) =>
  Effect.gen(function* () {
    const dir = `${workspaceRoot()}/repo`;
    const state = agent.files.state(session);
    const args = [saveFile(), base, agent.files.home, agent.kind, state.dir, state.name];
    yield* run(["sh", "-c", saveScript, "save", ...args], dir);
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFile(saveFile()).pipe(Effect.mapError(() => failure()));
  });

const restoreFile = () => `${workspaceRoot()}/restore.tar`;
const restoreScript = `set -e
tarfile="$1"; home="$2"; kind="$3"; s=$(mktemp -d)
tar -xf "$tarfile" -C "$s"
if [ -d "$s/repo" ]; then cp -a "$s/repo/." .; fi
xargs -0 -r rm -f -- < "$s/deleted"
mkdir -p "$home" && cp -a "$s/$kind/." "$home/"
rm -rf "$s" "$tarfile"`;

export const storeSave = (tar: Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFile(restoreFile(), tar).pipe(Effect.mapError(() => failure()));
  });

const markerFile = () => `${workspaceRoot()}/marker.json`;

export const readMarker = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(markerFile());
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Workspace))(text);
}).pipe(Effect.orElseSucceed(() => undefined));

export const writeMarker = (workspace: Workspace) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = markerFile();
    yield* fs.writeFileString(`${file}.tmp`, JSON.stringify(workspace));
    yield* fs.rename(`${file}.tmp`, file);
  }).pipe(Effect.mapError(() => new WorkspaceError({ message: "could not write the marker" })));

export const hasState = (agent: Agent, thread: string) => {
  const state = agent.files.state(thread);
  return run(
    [
      "sh",
      "-c",
      'cd "$1" && test -n "$(find "$2" -name "$3" 2>/dev/null | head -n 1)"',
      "state",
      agent.files.home,
      state.dir,
      state.name,
    ],
    workspaceRoot(),
  ).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
};

export type Egress = { readonly url: string; readonly token: string };
const egressUrl = /^https:\/\/[A-Za-z0-9.:/_~%-]+$/;
const quoted = (value: string) => `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;

const routeThroughEgress = (egress: Egress) =>
  Effect.gen(function* () {
    const url = egress.url.replace(/\/+$/, "");
    if (!egressUrl.test(url)) return yield* new WorkspaceError({ message: "invalid egress URL" });
    if (!(yield* onTmpfs)) return yield* new WorkspaceError({ message: notTmpfs });
    const fs = yield* FileSystem.FileSystem;
    const file = `${runDir}/gitconfig`;
    yield* fs
      .writeFileString(
        file,
        `[url ${quoted(`${url}/github.internal/api/git/`)}]\n` +
          `\tinsteadOf = https://github.com/\n\tinsteadOf = http://github.internal/api/git/\n` +
          `[http ${quoted(`${url}/`)}]\n\textraHeader = ${quoted(`Authorization: Bearer ${egress.token}`)}\n`,
        { mode: 0o600 },
      )
      .pipe(Effect.mapError(() => failure()));
    return file;
  });

export const prepareWorkspace = (
  repo: string,
  base: string,
  branch: string,
  git: { readonly name: string; readonly email: string },
  agent: Agent,
  resume: { readonly commit: string } | undefined,
  disk: Workspace | undefined,
  egress: Egress | undefined,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const retried: string[] = [];
    const until = started + retryBudget;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes(".."))
      return yield* new WorkspaceError({ message: "invalid repository" });
    if (base.startsWith("-") || branch.startsWith("-"))
      return yield* new WorkspaceError({ message: "invalid branch" });
    const root = workspaceRoot();
    yield* run(["git", "check-ref-format", "--branch", base], root);
    yield* run(["git", "check-ref-format", "--branch", branch], root);
    const dir = `${root}/repo`;
    const config = {
      ...(egress === undefined
        ? { "url.http://github.internal/api/git/.insteadOf": "https://github.com/" }
        : { "include.path": yield* routeThroughEgress(egress) }),
      "user.name": git.name,
      "user.email": git.email,
    };
    for (const [key, value] of Object.entries(config))
      yield* run(["git", "config", "--global", key, value], root);
    if (disk !== undefined) {
      yield* run(["git", "rev-parse", "--verify", "HEAD"], dir);
      return { dir, commit: disk.base, ms: (yield* Clock.currentTimeMillis) - started, retried };
    }
    yield* run(["rm", "-f", "--", markerFile()], root);
    yield* run(["rm", "-rf", "--", dir], root);
    yield* fromGitHub(
      [
        "git",
        "clone",
        "--depth",
        "1",
        "--branch",
        base,
        repo === fixtureRepo ? "file:///opt/scotty/fixture.git" : `https://github.com/${repo}`,
        dir,
      ],
      root,
      retried,
      until,
    );
    if (resume === undefined) yield* run(["git", "checkout", "-b", branch], dir);
    else {
      yield* fromGitHub(
        ["git", "fetch", "--depth", "1", "origin", resume.commit],
        dir,
        retried,
        until,
      );
      yield* run(["git", "checkout", "-b", branch, resume.commit], dir);
      yield* run(
        ["sh", "-c", restoreScript, "restore", restoreFile(), agent.files.home, agent.kind],
        dir,
      );
    }
    const commit = yield* run(["git", "rev-parse", "HEAD"], dir);
    const ms = (yield* Clock.currentTimeMillis) - started;
    return { dir, commit, ms, retried };
  });

const skillsDir = () => `${workspaceRoot()}/skills`;
const commitFile = /^[0-9a-f]{40}$/;

export const storeSkills = (commit: string, tarball: Uint8Array) =>
  Effect.gen(function* () {
    if (!commitFile.test(commit)) return yield* new WorkspaceError({ message: "invalid commit" });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(skillsDir(), { recursive: true }).pipe(Effect.mapError(failure));
    yield* fs.writeFile(`${skillsDir()}/${commit}.tar.gz`, tarball).pipe(Effect.mapError(failure));
  });

const settingsScript = `set -e
skills="$1"; instructions="$2"; incoming="$3"; owner="$4"; shift 4
rm -rf "$skills" && mkdir -p "$skills"
while [ $# -gt 1 ]; do
  t=$(mktemp -d); tar -xzf "$incoming/$1.tar.gz" -C "$t" --strip-components=1
  test -d "$t/$2" && cp -a "$t/$2/." "$skills/"
  rm -rf "$t"; shift 2
done
mkdir -p "$(dirname "$instructions")" && rm -f "$instructions"
{ cat /etc/scotty/AGENTS.md; if [ -n "$owner" ]; then printf '\\n\\n# From the owner\\n\\n%s\\n' "$owner"; fi; } > "$instructions"`;

export const installSettings = (
  agent: Agent,
  instructions: string,
  skills: ReadonlyArray<{ readonly commit: string; readonly path: string }>,
) =>
  run(
    [
      "sh",
      "-c",
      settingsScript,
      "settings",
      agent.files.skills,
      `${agent.files.home}/${agent.files.instructions}`,
      skillsDir(),
      instructions,
      ...skills.flatMap((source) =>
        commitFile.test(source.commit)
          ? [source.commit, source.path === "" ? "." : source.path]
          : [],
      ),
    ],
    workspaceRoot(),
  );

export const installStyle = (agent: Agent, name: string | undefined) =>
  Effect.gen(function* () {
    const styles = agent.files.styles;
    if (styles === undefined) return;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(styles, { recursive: true, force: true });
    if (name === undefined) return;
    const dir = `${agent.files.skills}/${name}`;
    const body = (yield* fs.readFileString(`${dir}/SKILL.md`))
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
      .replace(/(\]\()([^)\s]+)(\))/g, (link, open: string, target: string, close: string) =>
        /^(?:https?:|mailto:|#|\/)/.test(target) ? link : `${open}${dir}/${target}${close}`,
      )
      .trimStart();
    yield* fs.makeDirectory(styles, { recursive: true });
    yield* fs.writeFileString(
      `${styles}/${name}.md`,
      `---\nname: ${name}\ndescription: The ${name} skill\nkeep-coding-instructions: true\n---\n\n${body}`,
    );
  }).pipe(Effect.mapError(failure));
