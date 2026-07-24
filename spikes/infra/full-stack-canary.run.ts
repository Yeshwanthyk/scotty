import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {
  FULL_STACK_CANARY_CLEANUP_APPROVAL,
  FULL_STACK_CANARY_DEPLOY_APPROVAL,
  fullStackCanaryProgram,
} from "./full-stack-canary.ts";

export default Alchemy.Stack(
  "ScottyFullStackCanary",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    return yield* fullStackCanaryProgram({
      stage,
      deployApproval: process.env[FULL_STACK_CANARY_DEPLOY_APPROVAL],
      cleanupApproval: process.env[FULL_STACK_CANARY_CLEANUP_APPROVAL],
      telemetryDisabled: process.env.ALCHEMY_TELEMETRY_DISABLED === "1",
    });
  }),
);
