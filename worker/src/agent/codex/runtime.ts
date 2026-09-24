import { Effect } from "effect";
import { SidecarBridgeError, type SidecarSavedHistory } from "../sidecar/protocol";
import { makeSidecarRuntime } from "../sidecar/runtime";
import type { SidecarStart } from "../sidecar/server";
import type { CodexFirstPartyTools } from "./first-party-tools";
import { codexSidecarHost, type CodexSession } from "./host";
import { readCodexSavedState } from "./persistence";
import type { CodexLaunch } from "./process";
import { startCodexSession } from "./session";

export const makeCodexRuntime = Effect.fnUntraced(function* (
  session: CodexSession,
  generation: unknown,
  restored?: SidecarSavedHistory,
) {
  const host = yield* codexSidecarHost(session);
  return yield* makeSidecarRuntime(host, generation, restored);
});

export const startCodexRuntime = Effect.fnUntraced(function* (
  { generation, launch, restore }: SidecarStart<typeof CodexLaunch.Type>,
  firstPartyTools?: CodexFirstPartyTools,
) {
  if (restore?.threadId !== launch.resumeThreadId)
    return yield* new SidecarBridgeError({ code: "invalid_request", outcome: "rejected" });
  const restored =
    restore === undefined ? undefined : yield* readCodexSavedState(launch.workspace, restore);
  const session = yield* startCodexSession(launch, undefined, restored, firstPartyTools, false);
  return yield* makeCodexRuntime(session, generation, restored?.history);
});
