import { Context, Effect, Layer, Schedule } from "effect";
import { SESSION_ROOT, type SessionRecord } from "../session/contracts";
import type { VerifiedRepository } from "../repos/verifier";
import { SandboxRuntime, type SandboxRuntimeFailure, shellQuote } from "./runtime";

export interface PreparedWorkspace {
  readonly root: string;
  readonly defaultBranch: string;
  readonly repoExists: boolean;
}

interface WorkspaceShape {
  readonly prepare: (
    record: SessionRecord,
    githubHandle: string,
    verified?: VerifiedRepository,
  ) => Effect.Effect<PreparedWorkspace, SandboxRuntimeFailure>;
}

export class Workspace extends Context.Service<Workspace, WorkspaceShape>()("scotty/Workspace") {}

export const workspaceLayer: Layer.Layer<Workspace, never, SandboxRuntime> = Layer.effect(
  Workspace,
  Effect.map(SandboxRuntime, (runtime) =>
    Workspace.of({
      prepare: Effect.fnUntraced(function* (record, githubHandle, verified) {
        const root = sessionRoot(record.id);
        const url = `https://github.com/${record.repo}.git`;
        const env = { GH_TOKEN: githubHandle, GIT_TERMINAL_PROMPT: "0" };
        const repository =
          verified ??
          (record.repoExistsAtCreate
            ? { exists: true as const, defaultBranch: record.defaultBranch }
            : { exists: false as const });

        yield* runtime.execChecked(
          `rm -rf ${shellQuote(root)} && mkdir -p ${shellQuote(SESSION_ROOT)}`,
        );
        if (!repository.exists) {
          yield* runtime.execChecked(
            `git init -b main ${shellQuote(root)} && git -C ${shellQuote(root)} remote add origin ${shellQuote(url)} && git -C ${shellQuote(root)} checkout -b ${shellQuote(record.branch)}`,
            { env },
          );
          yield* configureGitCredentialHelper(runtime, root);
          return { root, defaultBranch: "main", repoExists: false };
        }

        const defaultBranch = repository.defaultBranch;
        const basic = btoa(`x-access-token:${githubHandle}`);
        yield* runtime
          .execChecked(
            `rm -rf ${shellQuote(root)} && git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} clone --branch ${shellQuote(defaultBranch)} --single-branch ${shellQuote(url)} ${shellQuote(root)}`,
            { env, timeout: 180_000 },
          )
          .pipe(Effect.retry({ times: 2, schedule: Schedule.spaced("1 second") }));
        yield* runtime.execChecked(
          `git -C ${shellQuote(root)} checkout -b ${shellQuote(record.branch)}`,
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
  const helper = "!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f";
  yield* runtime.execChecked(
    `git -C ${shellQuote(root)} config credential.helper ${shellQuote(helper)} && git -C ${shellQuote(root)} config credential.useHttpPath true && exclude=$(git -C ${shellQuote(root)} rev-parse --absolute-git-dir)/info/exclude && for path in '.codex/' '.home/' '.pi-agent/' '.scotty/'; do grep -qxF "$path" "$exclude" 2>/dev/null || printf '%s\\n' "$path" >> "$exclude"; done`,
  );
});
