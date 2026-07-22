import { Context, Effect, Layer, Option } from "effect";
import { SESSION_ROOT, type SessionRecord } from "./contracts";
import { SandboxRuntime, type SandboxRuntimeFailure, shellQuote } from "./sandbox-runtime";

const ROLLOUT_COMMAND_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

interface RolloutDiscoveryShape {
  readonly findNewestRollout: (
    id: SessionRecord["id"],
  ) => Effect.Effect<Option.Option<string>, SandboxRuntimeFailure>;
  readonly discoverThreadId: (
    id: SessionRecord["id"],
  ) => Effect.Effect<Option.Option<string>, SandboxRuntimeFailure>;
}

export class RolloutDiscovery extends Context.Service<RolloutDiscovery, RolloutDiscoveryShape>()(
  "scotty/RolloutDiscovery",
) {}

export const rolloutDiscoveryLayer: Layer.Layer<RolloutDiscovery, never, SandboxRuntime> =
  Layer.effect(
    RolloutDiscovery,
    Effect.map(SandboxRuntime, (runtime) => {
      const findNewestRollout = Effect.fnUntraced(function* (id: SessionRecord["id"]) {
        const codexHome = `${SESSION_ROOT}/${id}/.codex`;
        const result = yield* runtime.exec(
          `find ${shellQuote(`${codexHome}/sessions`)} -type f -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-`,
          { timeout: ROLLOUT_COMMAND_TIMEOUT_MS },
        );
        return result.success && result.stdout.trim()
          ? Option.some(result.stdout.trim())
          : Option.none();
      });

      const discoverThreadId = Effect.fnUntraced(function* (id: SessionRecord["id"]) {
        const rollout = yield* findNewestRollout(id);
        return Option.flatMap(rollout, (path) =>
          Option.fromUndefinedOr(UUID_PATTERN.exec(basename(path))?.[0]),
        );
      });

      return RolloutDiscovery.of({ findNewestRollout, discoverThreadId });
    }),
  );

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
