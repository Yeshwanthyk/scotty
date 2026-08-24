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
import type { VerifiedRepository } from "../src/repo-verifier";
import { sessionRoot, Workspace, workspaceLayer } from "../src/workspace";
import { makeSessionRecord } from "./support";

const ID = "a0b1c2d3e4f5";
const PLACEHOLDER = "scotty-injected";
const REAL_GITHUB = "honeypot-real-github-credential";
const ROOT = `/workspace/${ID}`;
const ENV = { GH_TOKEN: PLACEHOLDER, GIT_TERMINAL_PROMPT: "0" };
const HELPER = "!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f";

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
  session: SessionRecord = makeSessionRecord({
    status: "provisioning",
    operation: { kind: "create", nonce: "nonce", startedAt: "2026-07-22T00:00:00.000Z" },
  }),
  verified?: VerifiedRepository,
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = workspaceLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(Workspace, (workspace) => workspace.prepare(session, verified)).pipe(
    Effect.provide(layer),
  );
};

const resetCommand = `rm -rf ${shellQuote(ROOT)} && mkdir -p '/workspace'`;

const helperCommand = (root = ROOT): string =>
  `git -C ${shellQuote(root)} config credential.helper ${shellQuote(HELPER)} && git -C ${shellQuote(root)} config credential.useHttpPath true && exclude=$(git -C ${shellQuote(root)} rev-parse --absolute-git-dir)/info/exclude && { grep -qxF '.codex/' "$exclude" 2>/dev/null || printf '.codex/\\n' >> "$exclude"; }`;

describe("Workspace", () => {
  it.effect("clones a self-contained repository so backup restore retains Git metadata", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      const repo = "acme/widgets";

      const prepared = yield* prepareWith(
        capabilities,
        makeSessionRecord({ repo, defaultBranch: "trunk", repoExistsAtCreate: true }),
      );
      const basic = btoa(`x-access-token:${PLACEHOLDER}`);

      assert.deepStrictEqual(prepared, {
        root: ROOT,
        defaultBranch: "trunk",
        repoExists: true,
      });
      assert.deepStrictEqual(capabilities.calls.slice(1, 3), [
        {
          command: `git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} clone --branch 'trunk' --single-branch 'https://github.com/${repo}.git' '${ROOT}'`,
          options: { env: ENV, timeout: 180_000 },
        },
        {
          command: `git -C '${ROOT}' checkout -b 'scotty/${ID}'`,
          options: undefined,
        },
      ]);
      assert.strictEqual(capabilities.calls.at(-1)?.command, helperCommand());
    }),
  );

  it.effect("initializes only when the verifier explicitly reports a missing repository", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();

      const prepared = yield* prepareWith(
        capabilities,
        makeSessionRecord({ repo: "acme/new-project" }),
        { exists: false },
      );

      assert.deepStrictEqual(prepared, {
        root: ROOT,
        defaultBranch: "main",
        repoExists: false,
      });
      assert.deepStrictEqual(capabilities.calls, [
        { command: resetCommand, options: undefined },
        {
          command: `git init -b main '${ROOT}' && git -C '${ROOT}' remote add origin 'https://github.com/acme/new-project.git' && git -C '${ROOT}' checkout -b 'scotty/${ID}'`,
          options: { env: ENV },
        },
        { command: helperCommand(), options: undefined },
      ]);
    }),
  );

  it.effect("does not probe GitHub from the workspace adapter", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      yield* prepareWith(capabilities);

      assert.strictEqual(
        capabilities.calls.some(({ command }) => command.startsWith("gh ")),
        false,
      );
    }),
  );

  it.effect("keeps clone failures in the typed Effect error channel", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      capabilities.results.push(
        execResult("reset"),
        execResult("clone", { success: false, stderr: "clone failed" }),
      );

      const result = yield* Effect.result(
        prepareWith(capabilities, makeSessionRecord({ repo: "acme/widgets" })),
      );

      assert.ok(Result.isFailure(result));
      assert.deepStrictEqual(
        result.failure,
        new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "clone failed",
        }),
      );
    }),
  );

  it.effect("quotes hostile repository, branch, and verified branch input", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      const hostileRepo = "owner/repo'; $(touch /tmp/repo-pwned) #";
      const hostileBranch = "scotty/id'; $(touch /tmp/branch-pwned) #";
      const hostileDefault = "dev'; $(touch /tmp/default-pwned) #";

      yield* prepareWith(
        capabilities,
        makeSessionRecord({
          repo: hostileRepo,
          branch: hostileBranch,
          defaultBranch: hostileDefault,
          repoExistsAtCreate: true,
        }),
        { exists: true, defaultBranch: hostileDefault },
      );
      const surfaces = capabilities.calls.map(({ command }) => command).join("\n");

      assert.ok(surfaces.includes(shellQuote(`https://github.com/${hostileRepo}.git`)));
      assert.ok(surfaces.includes(shellQuote(hostileBranch)));
      assert.ok(surfaces.includes(shellQuote(hostileDefault)));
      assert.ok(!surfaces.includes("; touch /tmp/"));
    }),
  );

  it.effect("reconstructs without retaining runtime calls or repository results", () =>
    Effect.gen(function* () {
      const first = new FakeWorkspaceCapabilities();
      const second = new FakeWorkspaceCapabilities();

      const existing = yield* prepareWith(
        first,
        makeSessionRecord({ repoExistsAtCreate: true, defaultBranch: "dev" }),
      );
      const missing = yield* prepareWith(
        second,
        makeSessionRecord({ repoExistsAtCreate: false, defaultBranch: "main" }),
      );

      assert.strictEqual(existing.repoExists, true);
      assert.strictEqual(missing.repoExists, false);
      assert.strictEqual(first.calls.length, 4);
      assert.strictEqual(second.calls.length, 3);
      assert.notStrictEqual(first.calls, second.calls);
    }),
  );

  it.effect("keeps real credentials out of every command, environment, and failure", () =>
    Effect.gen(function* () {
      const capabilities = new FakeWorkspaceCapabilities();
      yield* prepareWith(
        capabilities,
        makeSessionRecord({ repoExistsAtCreate: true, defaultBranch: "dev" }),
      );

      const surfaces = JSON.stringify(capabilities.calls);
      assert.ok(!surfaces.includes(REAL_GITHUB));
      assert.ok(surfaces.includes(PLACEHOLDER));
      assert.ok(surfaces.includes(btoa(`x-access-token:${PLACEHOLDER}`)));
    }),
  );
});

describe("workspace paths", () => {
  it("owns the production session root", () => {
    assert.strictEqual(sessionRoot(ID), ROOT);
  });
});
