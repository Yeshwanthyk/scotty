import type { ScottyAuthRegistryNamespace } from "./auth-object";
import type { ScottyRunnerNamespace } from "./runner-object";
import type { Sandbox } from "./session";

export interface Bindings {
  AUTH: ScottyAuthRegistryNamespace;
  RUNNERS: ScottyRunnerNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  SESSIONS: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SCOTTY_DISCORD_TOKEN: string;
  SCOTTY_TOKEN: string;
  SCOTTY_RUNNER_NAME: string;
  SCOTTY_RUNNER_TOKEN: string;
  CODEX_AUTH_JSON: string;
  GH_TOKEN: string;
  SCOTTY_LOCAL_BACKUP?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
}
