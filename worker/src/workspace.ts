import { Context, Effect, Layer } from "effect";
import { SESSION_ROOT, type SessionRecord } from "./contracts";
import { SandboxRuntime, type SandboxRuntimeFailure, shellQuote } from "./sandbox-runtime";

export interface PreparedWorkspace {
  readonly root: string;
  readonly defaultBranch: string;
  readonly repoExists: boolean;
}

interface WorkspaceShape {
  readonly prepare: (
    record: SessionRecord,
    githubSentinel: string,
  ) => Effect.Effect<PreparedWorkspace, SandboxRuntimeFailure>;
}

export class Workspace extends Context.Service<Workspace, WorkspaceShape>()("scotty/Workspace") {}

export const workspaceLayer: Layer.Layer<Workspace, never, SandboxRuntime> = Layer.effect(
  Workspace,
  Effect.map(SandboxRuntime, (runtime) =>
    Workspace.of({
      prepare: Effect.fnUntraced(function* (record, githubSentinel) {
        const root = sessionRoot(record.id);
        const url = `https://github.com/${record.repo}.git`;
        const env = { GH_TOKEN: githubSentinel, GIT_TERMINAL_PROMPT: "0" };
        const repoView = yield* runtime.exec(
          `gh repo view ${shellQuote(record.repo)} --json defaultBranchRef --jq '.defaultBranchRef.name'`,
          { env, timeout: 60_000 },
        );

        yield* runtime.execChecked(
          `rm -rf ${shellQuote(root)} && mkdir -p ${shellQuote(SESSION_ROOT)}`,
        );
        if (!repoView.success || !repoView.stdout.trim()) {
          yield* runtime.execChecked(
            `git init -b main ${shellQuote(root)} && git -C ${shellQuote(root)} remote add origin ${shellQuote(url)} && git -C ${shellQuote(root)} checkout -b ${shellQuote(record.branch)}`,
            { env },
          );
          yield* configureGitCredentialHelper(runtime, root);
          return { root, defaultBranch: "main", repoExists: false };
        }

        const defaultBranch = repoView.stdout.trim();
        const cache =
          record.repo === "anomalyco/rift"
            ? "/cache/rift.git"
            : `/tmp/scotty-cache-${record.id}.git`;
        const basic = btoa(`x-access-token:${githubSentinel}`);
        if (record.repo !== "anomalyco/rift") {
          yield* runtime.execChecked(
            `git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} clone --bare ${shellQuote(url)} ${shellQuote(cache)}`,
            { env, timeout: 180_000 },
          );
        }
        yield* runtime.execChecked(
          `git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} -C ${shellQuote(cache)} fetch origin '+refs/heads/*:refs/remotes/origin/*'`,
          { env, timeout: 180_000 },
        );
        yield* runtime.execChecked(
          `git -C ${shellQuote(cache)} worktree add -B ${shellQuote(record.branch)} ${shellQuote(root)} ${shellQuote(`refs/remotes/origin/${defaultBranch}`)}`,
          { env, timeout: 120_000 },
        );
        yield* configureGitCredentialHelper(runtime, root);
        return { root, defaultBranch, repoExists: true };
      }),
    }),
  ),
);

export function sessionRoot(id: SessionRecord["id"]): string {
  return `${SESSION_ROOT}/${id}`;
}

const configureGitCredentialHelper = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  root: string,
) {
  const helper = "!f() { echo username=x-access-token; echo password=$GITHUB_SENTINEL; }; f";
  yield* runtime.execChecked(
    `git -C ${shellQuote(root)} config credential.helper ${shellQuote(helper)} && git -C ${shellQuote(root)} config credential.useHttpPath true && exclude=$(git -C ${shellQuote(root)} rev-parse --git-path info/exclude) && { grep -qxF '.codex/' "$exclude" 2>/dev/null || printf '.codex/\\n' >> "$exclude"; }`,
  );
});
