import type { ScottyAuthRegistryNamespace } from "./auth-object";
import type { Sandbox } from "./session";

export interface Bindings {
  AUTH: ScottyAuthRegistryNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  SESSIONS: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SCOTTY_TOKEN: string;
  CODEX_AUTH_JSON: string;
  GH_TOKEN: string;
  SCOTTY_FAKE_AGENT?: string;
  SCOTTY_LOCAL_BACKUP?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
}
