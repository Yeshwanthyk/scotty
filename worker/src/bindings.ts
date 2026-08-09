import type { ScottyAuthRegistryNamespace } from "./auth-object";
import type { ScottyRunnerNamespace } from "./runner-object";
import type { ScottyRunnerRegistryNamespace } from "./runner-registry-object";
import type { Sandbox } from "./session";

export interface Bindings {
  AUTH: ScottyAuthRegistryNamespace;
  RUNNER_REGISTRY: ScottyRunnerRegistryNamespace;
  RUNNERS: ScottyRunnerNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  SESSIONS: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  ARTIFACT_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SCOTTY_TOKEN: string;
  PI_AUTH_JSON: string;
  GH_TOKEN: string;
  SCOTTY_LOCAL_E2E?: string;
  SCOTTY_LOCAL_BACKUP?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  SCOTTY_PREVIEW_BASE?: string;
  SCOTTY_EVIDENCE_ENABLED?: string;
  SCOTTY_BROWSER_TEST_ENABLED?: string;
}
