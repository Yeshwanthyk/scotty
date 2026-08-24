import type { ScottyAuthRegistryNamespace } from "./auth-object";
import type { ScottyRunnerNamespace } from "./runner-object";
import type { ScottyRunnerRegistryNamespace } from "./runner-registry-object";
import type { ScottySandboxConfigNamespace } from "./sandbox-config-object";
import type { Sandbox } from "./session";

export interface Bindings {
  AUTH: ScottyAuthRegistryNamespace;
  RUNNER_REGISTRY: ScottyRunnerRegistryNamespace;
  RUNNERS: ScottyRunnerNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  SANDBOX_CONFIG: ScottySandboxConfigNamespace;
  SESSIONS: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  ARTIFACT_BUCKET: R2Bucket;
  SANDBOX_BUNDLE_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SCOTTY_ROOT_VERIFIER_BOOTSTRAP: string;
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
