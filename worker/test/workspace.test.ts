import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer, Result } from "effect";
import type { SessionRecord } from "../src/contracts";
import {
  SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  shellQuote,
  type SandboxExecOptions,
  type SandboxRuntimeCapabilities,
} from "../src/sandbox-runtime";
import { sessionRoot, Workspace, workspaceLayer } from "../src/workspace";

const ID = "a0b1c2d3e4f5";
const SENTINEL = `scotty-github-${ID}-sentinel`;
const REAL_GITHUB = "honeypot-real-github-credential";
const ROOT = `/workspace/${ID}`;
const ENV = { GH_TOKEN: SENTINEL, GIT_TERMINAL_PROMPT: "0" };
const HELPER = "!f() { echo username=x-access-token; echo password=$GITHUB_SENTINEL; }; f";

const record = (repo = "anomalyco/rift", branch = `scotty/${ID}`): SessionRecord => ({
  version: 1,
  id: ID,
  status: "booting",
  operation: { kind: "create", nonce: "nonce", startedAt: "2026-07-22T00:00:00.000Z" },
  repo,
  repoExistsAtCreate: true,
  defaultBranch: "dev",
  branch,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  hardCapAt: "2026-07-22T04:00:00.000Z",
  hardCapDurationSeconds: 14_400,
  ownedBackupIds: [],
});

const execResult = (
  command: string,
  options: { readonly success?: boolean; readonly stdout?: string; readonly stderr?: string } = {},
): ExecResult => ({
  success: options.success ?? true,
  exitCode: options.success === false ? 1 : 0,
  stdout: options.stdout ?? "",
  stderr: options.stderr ?? "",
  command,
  duration: 1,
  timestamp: "2026-07-22T00:00:00.000Z",
});

interface ExecCall {
  readonly command: string;
  readonly options?: SandboxExecOptions;
}

class FakeWorkspaceCapabilities implements SandboxRuntimeCapabilities {
  readonly calls: ExecCall[] = [];
  readonly results: ExecResult[] = [];
  rejection: unknown;

  exec = (command: string, options?: SandboxExecOptions): Promise<ExecResult> => {
    this.calls.push({ command, options });
    if (this.rejection !== undefined) return Promise.reject(this.rejection);
    return Promise.resolve(this.results.shift() ?? execResult(command));
  };

  mkdir = (): Promise<unknown> => Promise.resolve(undefined);
  writeFile = (): Promise<unknown> => Promise.resolve(undefined);
  setEnvVars = (): Promise<void> => Promise.resolve();
}

const prepareWith = (
  capabilities: SandboxRuntimeCapabilities,
  session: SessionRecord = record(),
  sentinel = SENTINEL,
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = workspaceLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(Workspace, (workspace) => workspace.prepare(session, sentinel)).pipe(
    Effect.provide(layer),
  );
};

const repoViewCommand = (repo: string): string =>
  `gh repo view ${shellQuote(repo)} --json defaultBranchRef --jq '.defaultBranchRef.name'`;

const resetCommand = `rm -rf ${shellQuote(ROOT)} && mkdir -p '/workspace'`;

const helperCommand = (root = ROOT): string =>
  `git -C ${shellQuote(root)} config credential.helper ${shellQuote(HELPER)} && git -C ${shellQuote(root)} config credential.useHttpPath true && exclude=$(git -C ${shellQuote(root)} rev-parse --git-path info/exclude) && { grep -qxF '.codex/' "$exclude" 2>/dev/null || printf '.codex/\\n' >> "$exclude"; }`;

describe("Workspace", () => {
  it.effect("prepares Rift from the baked cache with the dynamic default branch", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      capabilities.results.push(execResult("view", { stdout: "dev\n" }));

      const prepared = yield* prepareWith(capabilities);
      const basic = btoa(`x-access-token:${SENTINEL}`);

      assert.deepStrictEqual(prepared, {
        root: ROOT,
        defaultBranch: "dev",
        repoExists: true,
      });
      assert.deepStrictEqual(capabilities.calls, [
        { command: repoViewCommand("anomalyco/rift"), options: { env: ENV, timeout: 60_000 } },
        { command: resetCommand, options: undefined },
        {
          command: `git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} -C '/cache/rift.git' fetch origin '+refs/heads/*:refs/remotes/origin/*'`,
          options: { env: ENV, timeout: 180_000 },
        },
        {
          command: `git -C '/cache/rift.git' worktree add -B 'scotty/${ID}' '${ROOT}' 'refs/remotes/origin/dev'`,
          options: { env: ENV, timeout: 120_000 },
        },
        { command: helperCommand(), options: undefined },
      ]);
    }),
  );

  it.effect("clones a per-session bare cache before fetch for a non-baked repository", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      capabilities.results.push(execResult("view", { stdout: "trunk\n" }));
      const repo = "acme/widgets";

      const prepared = yield* prepareWith(capabilities, record(repo));
      const basic = btoa(`x-access-token:${SENTINEL}`);
      const cache = `/tmp/scotty-cache-${ID}.git`;

      assert.deepStrictEqual(prepared, {
        root: ROOT,
        defaultBranch: "trunk",
        repoExists: true,
      });
      assert.deepStrictEqual(capabilities.calls.slice(2, 5), [
        {
          command: `git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} clone --bare 'https://github.com/${repo}.git' '${cache}'`,
          options: { env: ENV, timeout: 180_000 },
        },
        {
          command: `git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} -C '${cache}' fetch origin '+refs/heads/*:refs/remotes/origin/*'`,
          options: { env: ENV, timeout: 180_000 },
        },
        {
          command: `git -C '${cache}' worktree add -B 'scotty/${ID}' '${ROOT}' 'refs/remotes/origin/trunk'`,
          options: { env: ENV, timeout: 120_000 },
        },
      ]);
      assert.strictEqual(capabilities.calls.at(-1)?.command, helperCommand());
    }),
  );

  it.effect("treats an ordinary nonzero repo view as a confirmed missing repository", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      capabilities.results.push(
        execResult("view", { success: false, stderr: "repository not found" }),
      );

      const prepared = yield* prepareWith(capabilities, record("acme/new-project"));

      assert.deepStrictEqual(prepared, {
        root: ROOT,
        defaultBranch: "main",
        repoExists: false,
      });
      assert.deepStrictEqual(capabilities.calls, [
        {
          command: repoViewCommand("acme/new-project"),
          options: { env: ENV, timeout: 60_000 },
        },
        { command: resetCommand, options: undefined },
        {
          command: `git init -b main '${ROOT}' && git -C '${ROOT}' remote add origin 'https://github.com/acme/new-project.git' && git -C '${ROOT}' checkout -b 'scotty/${ID}'`,
          options: { env: ENV },
        },
        { command: helperCommand(), options: undefined },
      ]);
    }),
  );

  it.effect("fails on repo-view transport rejection without falling back to main", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      capabilities.rejection = new Error(`provider leaked ${REAL_GITHUB}`);

      const result = yield* Effect.result(prepareWith(capabilities));

      assert.ok(Result.isFailure(result));
      assert.deepStrictEqual(
        result.failure,
        new SandboxRuntimeFailure({
          reason: "transport",
          message: "Sandbox command transport failed",
        }),
      );
      assert.strictEqual(capabilities.calls.length, 1);
      assert.ok(!JSON.stringify(result.failure).includes(REAL_GITHUB));
    }),
  );

  it.effect("quotes hostile repository, branch, and discovered branch input", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      const hostileRepo = "owner/repo'; $(touch /tmp/repo-pwned) #";
      const hostileBranch = "scotty/id'; $(touch /tmp/branch-pwned) #";
      const hostileDefault = "dev'; $(touch /tmp/default-pwned) #";
      capabilities.results.push(execResult("view", { stdout: `${hostileDefault}\n` }));

      yield* prepareWith(capabilities, record(hostileRepo, hostileBranch));
      const surfaces = capabilities.calls.map(({ command }) => command).join("\n");

      assert.ok(surfaces.includes(repoViewCommand(hostileRepo)));
      assert.ok(surfaces.includes(shellQuote(`https://github.com/${hostileRepo}.git`)));
      assert.ok(surfaces.includes(shellQuote(hostileBranch)));
      assert.ok(surfaces.includes(shellQuote(`refs/remotes/origin/${hostileDefault}`)));
      assert.ok(!surfaces.includes("; touch /tmp/"));
    }),
  );

  it.effect("reconstructs without retaining runtime calls or repository results", () =>
    Effect.gen(function* () {
      const first = new FakeWorkspaceCapabilities();
      const second = new FakeWorkspaceCapabilities();
      first.results.push(execResult("view", { stdout: "dev\n" }));
      second.results.push(execResult("view", { success: false, stderr: "not found" }));

      const existing = yield* prepareWith(first);
      const missing = yield* prepareWith(second);

      assert.strictEqual(existing.repoExists, true);
      assert.strictEqual(missing.repoExists, false);
      assert.strictEqual(first.calls.length, 5);
      assert.strictEqual(second.calls.length, 4);
      assert.notStrictEqual(first.calls, second.calls);
    }),
  );

  it.effect("keeps real credentials out of every command, environment, and failure", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      capabilities.results.push(execResult("view", { stdout: "dev\n" }));
      yield* prepareWith(capabilities);

      const surfaces = JSON.stringify(capabilities.calls);
      assert.ok(!surfaces.includes(REAL_GITHUB));
      assert.ok(surfaces.includes(SENTINEL));
      assert.ok(surfaces.includes(btoa(`x-access-token:${SENTINEL}`)));
    }),
  );
});

describe("workspace paths", () => {
  it("owns the production session root", () => {
    assert.strictEqual(sessionRoot(ID), ROOT);
  });
});
