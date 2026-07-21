import { randomBytes } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import type { WorkerBinding } from "alchemy/Cloudflare";
import {
  accountSecretsStoreWorkerBinding,
  appendAccountSecretsStoreWorkerBinding,
} from "./account-secrets-store-binding.ts";
import type { WriteOnlySecretAttributes } from "./write-only-secret.ts";

const managedSecret = (): WriteOnlySecretAttributes => ({
  sourceId: `source-${randomBytes(8).toString("hex")}`,
  accountId: `account-${randomBytes(8).toString("hex")}`,
  storeId: `store-${randomBytes(8).toString("hex")}`,
  secretId: `secret-id-${randomBytes(8).toString("hex")}`,
  secretName: `secret-name-${randomBytes(8).toString("hex")}`,
  bindingName: "CODEX_SEED",
  providerVersion: 1,
  keyedDigest: `hmac-sha256:v1:${randomBytes(32).toString("hex")}`,
  status: "active",
  scopes: ["workers"],
  ownerReference: `owner-${randomBytes(16).toString("hex")}`,
});

describe("Account Secrets Store Worker binding", () => {
  it("projects only Alchemy's public identifier fields", () => {
    const secret = managedSecret();

    const binding = accountSecretsStoreWorkerBinding(secret);

    assert.deepEqual(binding, {
      type: "secrets_store_secret",
      name: secret.bindingName,
      storeId: secret.storeId,
      secretName: secret.secretName,
    });
    assert.deepEqual(Reflect.ownKeys(binding).sort(), ["name", "secretName", "storeId", "type"]);
    assert.notInclude(JSON.stringify(binding), secret.sourceId);
    assert.notInclude(JSON.stringify(binding), secret.keyedDigest);
    assert.notInclude(JSON.stringify(binding), secret.ownerReference);
    assert.notInclude(JSON.stringify(binding), secret.secretId);
  });

  it("appends without changing existing desired bindings", () => {
    const existing: readonly WorkerBinding[] = [
      { type: "kv_namespace", name: "SESSIONS", namespaceId: "sessions-id" },
      { type: "plain_text", name: "SAFE_CONFIG", text: "synthetic" },
    ];
    const secret = managedSecret();

    const bindings = appendAccountSecretsStoreWorkerBinding(existing, secret);

    assert.deepEqual(bindings.slice(0, existing.length), existing);
    assert.deepEqual(bindings.at(-1), accountSecretsStoreWorkerBinding(secret));
    assert.strictEqual(bindings.length, existing.length + 1);
  });
});
