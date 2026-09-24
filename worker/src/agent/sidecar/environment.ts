import { Effect, FileSystem } from "effect";
import type { CloudSettingsEnvironmentSchema } from "../../../../protocol/settings/cloud-settings";
import { runtimeCliPath } from "../../runtime-cli/paths";
import { sessionRoot } from "../../sandbox/workspace";

const CLOUDFLARE_CA_FILE = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const PACKAGED_COREPACK_HOME = "/opt/corepack";

const readable = Effect.fnUntraced(function* (path: string, type: "File" | "Directory") {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(path).pipe(
    Effect.flatMap((stat) =>
      stat.type === type ? fs.access(path, { readable: true }) : Effect.fail(undefined),
    ),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * Environment every sidecar agent child starts from. It never inherits the sidecar's own
 * environment: image tools, trusted egress CA, Session identity and the GitHub sentinel only.
 */
export const sidecarChildEnvironment = Effect.fnUntraced(function* (input: {
  readonly home: string;
  readonly environment?: typeof CloudSettingsEnvironmentSchema.Type;
  readonly sessionId?: string;
  readonly githubHandle?: string;
}) {
  const { home, environment, sessionId, githubHandle } = input;
  return {
    ...environment,
    HOME: home,
    TMPDIR: home,
    // Match the image tool directories without inheriting ambient credentials.
    PATH: sessionId === undefined ? "/usr/local/bin:/usr/bin:/bin" : runtimeCliPath(sessionId),
    ...((yield* readable(CLOUDFLARE_CA_FILE, "File"))
      ? { NODE_EXTRA_CA_CERTS: CLOUDFLARE_CA_FILE }
      : {}),
    ...((yield* readable(PACKAGED_COREPACK_HOME, "Directory"))
      ? { COREPACK_HOME: PACKAGED_COREPACK_HOME }
      : {}),
    ...(sessionId === undefined ? {} : { SCOTTY_SESSION_ID: sessionId }),
    ...(githubHandle === undefined || sessionId === undefined
      ? {}
      : {
          GH_TOKEN: githubHandle,
          GIT_CONFIG_GLOBAL: `${sessionRoot(sessionId)}/.pi-agent/gitconfig`,
          GIT_TERMINAL_PROMPT: "0",
        }),
  };
});
