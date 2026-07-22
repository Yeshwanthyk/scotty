import { Context, Effect, Layer } from "effect";
import { agentEnv } from "./container-auth";
import { CredentialVault, type CredentialVaultFailure } from "./credential-vault";
import type { SessionRecord } from "./contracts";
import { SandboxRuntime, type SandboxRuntimeFailure, shellQuote } from "./sandbox-runtime";
import { sessionRoot } from "./workspace";

export type AgentLaunch =
  | { readonly kind: "start"; readonly prompt?: string }
  | { readonly kind: "resume"; readonly threadId?: string };
export type AgentFailure = CredentialVaultFailure | SandboxRuntimeFailure;

interface AgentShape {
  readonly launch: (
    id: SessionRecord["id"],
    launch: AgentLaunch,
  ) => Effect.Effect<void, AgentFailure>;
}

export class Agent extends Context.Service<Agent, AgentShape>()("scotty/Agent") {}

export const agentLayer = (
  fakeAgent: boolean,
): Layer.Layer<Agent, never, CredentialVault | SandboxRuntime> =>
  Layer.effect(
    Agent,
    Effect.gen(function* () {
      const runtime = yield* SandboxRuntime;
      const vault = yield* CredentialVault;
      return Agent.of({
        launch: Effect.fnUntraced(function* (id, launch) {
          const credential = yield* vault.require;
          const root = sessionRoot(id);
          const env = agentEnv(id, credential);
          yield* runtime.exec("tmux kill-session -t agent 2>/dev/null || true", { env });
          const command = agentCommand(fakeAgent, launch);
          yield* runtime.execChecked(
            `tmux new-session -d -s agent -c ${shellQuote(root)} ${shellQuote(command)} && tmux set-option -t agent window-size smallest`,
            { env, timeout: 30_000 },
          );
        }),
      });
    }),
  );

function agentCommand(fakeAgent: boolean, launch: AgentLaunch): string {
  if (fakeAgent) return `printf '\\033[1;36mScotty fake agent ready\\033[0m\\n'; exec bash`;
  if (launch.kind === "start")
    return `exec codex --dangerously-bypass-approvals-and-sandbox ${shellQuote(launch.prompt ?? "")}`;
  return launch.threadId
    ? `exec codex --dangerously-bypass-approvals-and-sandbox resume ${shellQuote(launch.threadId)}`
    : "exec codex --dangerously-bypass-approvals-and-sandbox resume --last";
}
