import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect } from "effect";
import {
  GIT_STATUS_COMMAND,
  findGitWorktreeChange,
  gitPatchCommand,
  gitTrackedNumstatCommand,
  gitUntrackedNumstatCommand,
  listGitWorktreeChanges,
  readGitWorktreePatch,
} from "../../src/changes/git";
import { PATCH_MAX_BYTES, type ChangedFile } from "../../src/changes/contracts";
import type { SandboxRuntime } from "../../src/sandbox/runtime";

const result = (command: string, stdout: string): ExecResult => ({
  command,
  stdout,
  stderr: "",
  success: true,
  exitCode: 0,
  duration: 1,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const encodeGitTransport = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

type ExecOptions = Parameters<SandboxRuntime["Service"]["execChecked"]>[1];

const fakeRuntime = (outputs: ReadonlyMap<string, string>) => {
  const calls: Array<{ readonly command: string; readonly options: ExecOptions }> = [];
  const runtime: Pick<SandboxRuntime["Service"], "execChecked"> = {
    execChecked: (command, options) => {
      calls.push({ command, options });
      return Effect.succeed(result(command, outputs.get(command) ?? ""));
    },
  };
  return { calls, runtime };
};

const textFile = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  path: "src/app.ts",
  status: "modified",
  staged: false,
  unstaged: true,
  additions: 1,
  deletions: 1,
  binary: false,
  patchable: true,
  ...overrides,
});

const execAsync = promisify(execCallback);
const execFileAsync = promisify(execFileCallback);

const executingRuntime: Pick<SandboxRuntime["Service"], "execChecked"> = {
  execChecked: (command, options) =>
    Effect.promise(async () => {
      const output = await execAsync(command, {
        cwd: options?.cwd,
        encoding: "utf8",
        maxBuffer: 2 * 1_024 * 1_024,
        timeout: options?.timeout,
      });
      return {
        ...result(command, String(output.stdout)),
        stderr: String(output.stderr),
      };
    }),
};

describe("Git changed-files adapter", () => {
  it.effect("reads bounded live status and stats with no credential environment", () =>
    Effect.gen(function* () {
      const hash = "a".repeat(40);
      const status = `1 .M N... 100644 100644 100644 ${hash} ${hash} src/app.ts\0`;
      const statusFile = textFile();
      const trackedCommand = gitTrackedNumstatCommand([statusFile]);
      const untrackedCommand = gitUntrackedNumstatCommand([statusFile]);
      const fake = fakeRuntime(
        new Map([
          [GIT_STATUS_COMMAND, encodeGitTransport(status)],
          [trackedCommand, encodeGitTransport("1\t1\tsrc/app.ts\0")],
          [untrackedCommand, ""],
        ]),
      );

      const changes = yield* listGitWorktreeChanges(fake.runtime, "/workspace/session");

      assert.lengthOf(changes.files, 1);
      assert.deepStrictEqual(
        fake.calls.map(({ command }) => command),
        [GIT_STATUS_COMMAND, trackedCommand, untrackedCommand],
      );
      for (const call of fake.calls) {
        assert.strictEqual(call.options?.cwd, "/workspace/session");
        assert.notProperty(call.options ?? {}, "env");
      }
      assert.include(GIT_STATUS_COMMAND, "--no-optional-locks");
      assert.include(GIT_STATUS_COMMAND, ":(top,exclude).pi-agent/**");
      assert.include(GIT_STATUS_COMMAND, "--untracked-files=no");
      assert.include(trackedCommand, "--literal-pathspecs");
      assert.include(trackedCommand, "--no-ext-diff");
      assert.include(untrackedCommand, "head -c");
      assert.include(untrackedCommand, "base64");
    }),
  );

  it.effect("hides untracked Scotty runtime files without hiding tracked repository files", () =>
    Effect.gen(function* () {
      const hash = "c".repeat(40);
      const trackedRuntimePath = `1 .M N... 100644 100644 100644 ${hash} ${hash} .scotty/project.json\0`;
      const status = `${trackedRuntimePath}? .pi-agent/settings.json\0? .scotty/runtime.json\0? .home/state\0? src/new.ts\0`;
      const trackedFile = textFile({ path: ".scotty/project.json" });
      const untrackedFile = textFile({ path: "src/new.ts", status: "untracked" });
      const trackedCommand = gitTrackedNumstatCommand([trackedFile, untrackedFile]);
      const untrackedCommand = gitUntrackedNumstatCommand([trackedFile, untrackedFile]);
      const fake = fakeRuntime(
        new Map([
          [GIT_STATUS_COMMAND, encodeGitTransport(status)],
          [trackedCommand, encodeGitTransport("1\t1\t.scotty/project.json\0")],
          [untrackedCommand, encodeGitTransport("1\t0\tsrc/new.ts\0")],
        ]),
      );

      const changes = yield* listGitWorktreeChanges(fake.runtime, "/workspace/session");

      assert.deepStrictEqual(
        changes.files.map((file) => file.path),
        [".scotty/project.json", "src/new.ts"],
      );
      assert.isFalse(changes.truncated);
    }),
  );

  it.effect("caps oversized status transport and marks the visible list truncated", () =>
    Effect.gen(function* () {
      const hash = "b".repeat(40);
      const status = Array.from(
        { length: 6_000 },
        (_, index) => `1 .M N... 100644 100644 100644 ${hash} ${hash} src/file-${index}.ts\0`,
      ).join("");
      const fake = fakeRuntime(new Map([[GIT_STATUS_COMMAND, encodeGitTransport(status)]]));

      const changes = yield* listGitWorktreeChanges(fake.runtime, "/workspace/session");

      assert.lengthOf(changes.files, 100);
      assert.isTrue(changes.truncated);
      assert.lengthOf(fake.calls, 3);
    }),
  );

  it.effect("quotes a hostile literal path and truncates the captured patch", () =>
    Effect.gen(function* () {
      const file = textFile({ path: "--bad'; touch /tmp/pwn; echo '" });
      const command = gitPatchCommand(file);
      const fake = fakeRuntime(new Map([[command, "x".repeat(PATCH_MAX_BYTES + 1)]]));

      const patch = yield* readGitWorktreePatch(fake.runtime, "/workspace/session", file);

      assert.include(command, "--literal-pathspecs");
      assert.include(command, "--no-ext-diff --no-textconv --no-color --unified=3 HEAD --");
      assert.include(command, "'\\''");
      assert.strictEqual(new TextEncoder().encode(patch.patch ?? "").byteLength, PATCH_MAX_BYTES);
      assert.isTrue(patch.truncated);
      assert.notProperty(fake.calls[0].options ?? {}, "env");
    }),
  );

  it.effect("executes hostile rename and binary reads against a real Git worktree", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "scotty-changes-"))),
        (path) => Effect.promise(() => rm(path, { force: true, recursive: true })),
      );
      const oldPath = "src/old.ts";
      const renamedPath = ":(top)odd'; touch SCOTTY_PWNED; echo '.ts";
      const marker = join(root, "SCOTTY_PWNED");

      yield* Effect.promise(async () => {
        await execFileAsync("git", ["init", "-q"], { cwd: root });
        await execFileAsync("git", ["config", "user.email", "scotty@example.invalid"], {
          cwd: root,
        });
        await execFileAsync("git", ["config", "user.name", "Scotty Test"], { cwd: root });
        await execFileAsync("git", ["config", "color.diff", "always"], { cwd: root });
        await mkdir(join(root, "src"));
        await mkdir(join(root, ".scotty"));
        await writeFile(
          join(root, oldPath),
          [
            "export const value = 'old';",
            "export const stable1 = 1;",
            "export const stable2 = 2;",
            "export const stable3 = 3;",
            "export const stable4 = 4;",
            "",
          ].join("\n"),
        );
        await writeFile(join(root, ".scotty", "project.json"), '{"value":"old"}\n');
        await execFileAsync("git", ["add", "--", "."], { cwd: root });
        await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });
        await writeFile(join(root, ".scotty", "project.json"), '{"value":"new"}\n');
        await rename(join(root, oldPath), join(root, renamedPath));
        await writeFile(
          join(root, renamedPath),
          [
            "export const value = 'new';",
            "export const stable1 = 1;",
            "export const stable2 = 2;",
            "export const stable3 = 3;",
            "export const stable4 = 4;",
            "",
          ].join("\n"),
        );
        await execFileAsync("git", ["add", "-A", "--", "."], { cwd: root });
        await mkdir(join(root, ".pi-agent"));
        await writeFile(join(root, ".pi-agent", "settings.json"), "{}\n");
        await writeFile(join(root, "binary.dat"), Uint8Array.from([0, 1, 2, 3]));
      });

      const changes = yield* listGitWorktreeChanges(executingRuntime, root);
      const renamed = yield* findGitWorktreeChange(executingRuntime, root, renamedPath);

      assert.isDefined(renamed);
      assert.strictEqual(renamed.status, "renamed");
      assert.strictEqual(renamed.oldPath, oldPath);
      const binary = changes.files.find((file) => file.path === "binary.dat");
      assert.isDefined(binary);
      assert.strictEqual(binary.status, "untracked");
      assert.isTrue(binary.binary);
      assert.isFalse(binary.patchable);
      assert.isTrue(changes.files.some((file) => file.path === ".scotty/project.json"));
      assert.isFalse(changes.files.some((file) => file.path === ".pi-agent/settings.json"));
      const patch = yield* readGitWorktreePatch(executingRuntime, root, renamed);
      assert.include(patch.patch ?? "", oldPath);
      assert.include(patch.patch ?? "", renamedPath);
      assert.notInclude(patch.patch ?? "", "\u001b[");
      assert.isFalse(
        yield* Effect.promise(() =>
          access(marker).then(
            () => true,
            () => false,
          ),
        ),
      );
    }),
  );

  it("includes both literal rename paths in a tracked patch", () => {
    const command = gitPatchCommand(
      textFile({ path: ":(top)**", oldPath: "src/old.ts", status: "renamed" }),
    );

    assert.include(command, "--literal-pathspecs");
    assert.include(command, "src/old.ts");
    assert.include(command, ":(top)**");
  });

  it.effect("does not invoke Git for an explicit binary state", () =>
    Effect.gen(function* () {
      const file = textFile({ path: "image.png", binary: true, patchable: false });
      const fake = fakeRuntime(new Map());

      const patch = yield* readGitWorktreePatch(fake.runtime, "/workspace/session", file);

      assert.isNull(patch.patch);
      assert.isFalse(patch.truncated);
      assert.lengthOf(fake.calls, 0);
    }),
  );
});
