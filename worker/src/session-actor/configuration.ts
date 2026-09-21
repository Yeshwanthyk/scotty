import { RuntimeCliPinSchema, type RuntimeCliPin } from "../../../protocol/runtime-cli-pin";
import { Result, Schema } from "effect";
import {
  decodeAgentSelection,
  type AgentSelection,
} from "../../../protocol/agents/agent-selection";
import {
  CloudSettingsEnvironmentSchema,
  type CloudSettingsSnapshot,
} from "../../../protocol/settings/cloud-settings";
import { SandboxDigestSchema } from "../sandbox/config-contracts";

// A session pins this non-secret configuration at admission. Cloud edits never change it.
export const SessionConfigurationSchema = Schema.Struct({
  runtimeCli: RuntimeCliPinSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bundleDigest: Schema.NullOr(SandboxDigestSchema),
  environment: CloudSettingsEnvironmentSchema,
});
export type SessionConfiguration = typeof SessionConfigurationSchema.Type;

export const resolveSessionConfiguration = (
  snapshot: CloudSettingsSnapshot,
  override: AgentSelection | undefined,
  runtimeCli: RuntimeCliPin,
) => {
  const agent = override?.agent ?? snapshot.settings.agent;
  const selection = decodeAgentSelection({ ...snapshot.settings[agent], ...override });
  return Result.map(selection, (value) => ({
    selection: value,
    configuration: {
      runtimeCli,
      revision: snapshot.revision,
      bundleDigest: snapshot.activeDigest,
      environment: snapshot.settings.environment,
    },
  }));
};
