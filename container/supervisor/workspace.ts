import { Clock, Effect, Fiber, FileSystem, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fixtureRepo } from "../../protocol/supervisor.js";
import type { Agent } from "./agents/agent.js";
import { processEnv } from "./runtime.js";

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
              // A transfer stalled for 30 s fails as "RPC failed", which is retried.
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
// The container holds no GitHub token, so git's last stderr line is safe to report.
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

// GitHub throttles Cloudflare's shared egress for minutes at a time (429; the Worker turns a
// rate-limit 403 into 429), and a proxied transfer can drop. Waiting these out turns a failed
// start into a slow one; any other 4xx is a real answer. A retry often succeeds at once, so
// waits start at 1 s and grow to 30 s.
const transient = (error: unknown) =>
  error instanceof CommandFailed &&
  /error: (429|5\d\d)|RPC failed|early EOF|Connection reset/.test(error.stderr) &&
  !/error: 4(?!29)\d\d/.test(error.stderr);
const backoff = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);
// Clone and fetch share one budget: no attempt starts after ~270 s (the budget plus one 30 s
// wait), leaving ~90 s of the DO's 360 s workspace deadline (deadlines.ts) for that attempt,
// the restore and Codex's start.
const retryBudget = 240_000;
// Each retried failure is reported in workspace.ready, so a slow start shows why.
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

// Only what the base commit cannot rebuild: changed and untracked files, deleted paths,
// and the agent's state file for the session. Ignored files (dependencies, builds) are left out.
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

export const prepareWorkspace = (
  repo: string,
  base: string,
  branch: string,
  git: { readonly name: string; readonly email: string },
  agent: Agent,
  resume?: { readonly commit: string },
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
    // The Session DO routes github.internal to the Worker, which adds the token; git here has none.
    const config = {
      "url.http://github.internal/api/git/.insteadOf": "https://github.com/",
      "user.name": git.name,
      "user.email": git.email,
    };
    for (const [key, value] of Object.entries(config))
      yield* run(["git", "config", "--global", key, value], root);
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

// Skill sources arrive over HTTP before start, like a save: GitHub tarballs named by commit.
const skillsDir = () => `${workspaceRoot()}/skills`;
const commitFile = /^[0-9a-f]{40}$/;

export const storeSkills = (commit: string, tarball: Uint8Array) =>
  Effect.gen(function* () {
    if (!commitFile.test(commit)) return yield* new WorkspaceError({ message: "invalid commit" });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(skillsDir(), { recursive: true }).pipe(Effect.mapError(failure));
    yield* fs.writeFile(`${skillsDir()}/${commit}.tar.gz`, tarball).pipe(Effect.mapError(failure));
  });

// Each source's folder is unpacked whole into the agent's skills folder, so a skill's links to
// files in another skill still resolve. The agent's instructions file becomes Scotty's
// instructions followed by the owner's.
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

// The owner's style skill as a Claude output style, as the owner's build-mode script makes it:
// the skill's text without its frontmatter, its relative links made absolute so they resolve
// from any cwd, and keep-coding-instructions so Claude Code's own prompt stays. The folder is
// rebuilt on every start, so a resume without a style has none.
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
