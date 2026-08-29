import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  formatLocalDevVars,
  formatLocalCredentialToml,
  localHarnessContainerIds,
  messageText,
  promptAttempt,
  repositoryFromRemote,
  snapshotSummary,
} from "../scripts/local-live.mjs";
import { localHarnessContainerIdsForWorker, waitForWorker } from "../support/local-worker.mjs";
import {
  credentialCanaryValues,
  findCredentialLeaks,
  withoutAmbientCredentialEnvironment,
} from "../support/credential-canary.mjs";

test("local-live helper derives GitHub repositories from HTTPS and SSH remotes", () => {
  assert.equal(
    repositoryFromRemote("https://github.com/Yeshwanthyk/scotty.git\n"),
    "Yeshwanthyk/scotty",
  );
  assert.equal(repositoryFromRemote("git@github.com:Yeshwanthyk/scotty.git"), "Yeshwanthyk/scotty");
  assert.throws(() => repositoryFromRemote("https://example.com/owner/repo.git"));
});

test("local-live helper only cleans up new Scotty Wrangler containers", () => {
  const containers = [
    { id: "old", image: "cloudflare-dev/scottysandbox:one", name: "workerd-scotty-worker-x" },
    {
      id: "sandbox",
      image: "cloudflare-dev/scottysandbox:two",
      name: "workerd-scotty-worker-ScottySandbox-hash",
    },
    {
      id: "proxy",
      image: "cloudflare/proxy-everything:three",
      name: "workerd-scotty-worker-ScottySandbox-hash-proxy",
    },
    { id: "other", image: "postgres:latest", name: "database" },
  ];
  assert.deepEqual(localHarnessContainerIds(containers, new Set(["old"])), ["sandbox", "proxy"]);
});
test("scotty-lab cleanup matches only the exact Wrangler worker name", () => {
  const workerName = "scotty-lab-12345678";
  const containers = [
    {
      id: "owned",
      image: "cloudflare-dev/scottysandbox:two",
      name: `workerd-${workerName}-ScottySandbox-hash`,
    },
    {
      id: "owned-proxy",
      image: "cloudflare/proxy-everything:three",
      name: `workerd-${workerName}-ScottySandbox-hash-proxy`,
    },
    {
      id: "other-worker",
      image: "cloudflare-dev/scottysandbox:four",
      name: "workerd-scotty-lab-87654321-ScottySandbox-hash",
    },
    { id: "other", image: "postgres:latest", name: `workerd-${workerName}-ScottySandbox-db` },
  ];
  assert.deepEqual(localHarnessContainerIdsForWorker(containers, workerName), [
    "owned",
    "owned-proxy",
  ]);
});

test("local worker readiness bounds a stalled health probe", async () => {
  const wrangler = {
    child: { exitCode: null, signalCode: null },
    flushLog: () => undefined,
    log: [],
  };
  const stalledFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  const keepAlive = setTimeout(() => undefined, 1_000);
  try {
    await assert.rejects(
      waitForWorker("http://127.0.0.1:1", wrangler, {
        timeoutMs: 25,
        fetchImpl: stalledFetch,
      }),
      /did not become ready/u,
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("local-live helper writes isolated Worker inputs", () => {
  const value = formatLocalDevVars({
    rootToken: "root-token",
    credentialWrappingKey: "A".repeat(43),
    installationName: "local",
  });
  assert.match(value, /^SCOTTY_TOKEN="root-token"$/mu);
  assert.match(value, /^CREDENTIAL_WRAPPING_KEY="A{43}"$/mu);
  assert.match(value, /^SCOTTY_INSTALLATION_NAME="local"$/mu);
  assert.match(value, /^SANDBOX_TRANSPORT="http"$/mu);
  assert.match(value, /^SCOTTY_LOCAL_E2E="1"$/mu);
});

test("local-live helper writes complete Registry-backed TOML declarations", () => {
  const value = formatLocalCredentialToml({
    repo: "owner/repo",
    piAuthPath: "/home/operator/.pi/agent/auth.json",
  });
  assert.match(value, /^version = 1$/mu);
  assert.match(value, /^\[sync\]$/mu);
  assert.match(value, /^\[repos\]$/mu);
  assert.match(value, /^\[credentials\.codex\]$/mu);
  assert.match(value, /^\[credentials\.github\]$/mu);
  assert.match(value, /^repositories = \["owner\/repo"\]$/mu);
  assert.doesNotMatch(value, /GH_TOKEN|PI_AUTH_JSON|CREDENTIAL_WRAPPING_KEY/u);
  assert.doesNotMatch(value, /GH_TOKEN|PI_AUTH_JSON|CREDENTIAL_WRAPPING_KEY/u);
  assert.deepEqual(parseToml(value), {
    version: 1,
    sync: { skills: [], packages: [], tools: [], extensions: [] },
    repos: { allowed: ["owner/repo"] },
    credentials: {
      codex: {
        kind: "pi-auth",
        source: "/home/operator/.pi/agent/auth.json",
        scope: "global",
      },
      github: { kind: "github-cli", scope: "repository", repositories: ["owner/repo"] },
    },
  });
});

test("credential canary helpers scrub ambient secrets and compare exact values", () => {
  const environment = {
    PATH: "/bin",
    GH_TOKEN: "ambient-github-token",
    PI_AUTH_JSON: "ambient-pi-auth",
    CREDENTIAL_WRAPPING_KEY: "ambient-wrapping-key",
  };
  assert.deepEqual(withoutAmbientCredentialEnvironment(environment), { PATH: "/bin" });
  const values = credentialCanaryValues({
    piAuthJson: JSON.stringify({
      "openai-codex": { access: "pi-access", refresh: "pi-refresh" },
    }),
    githubToken: "github-token",
    wrappingKey: "wrapping-key",
  });
  assert.deepEqual(
    findCredentialLeaks("managed=scotty-managed://codex/openai-codex/access", values),
    [],
  );
  assert.deepEqual(findCredentialLeaks("leak=github-token", values), ["github-token"]);
  assert.deepEqual(findCredentialLeaks("leak=pi-refresh", values), ["pi-refresh"]);
});
test("local-live helper recognizes an assistant marker in Pi message content", () => {
  const snapshot = {
    messages: [
      { role: "user", content: "LOCAL_LIVE_READY_1234" },
      {
        role: "assistant",
        content: [{ type: "text", text: "LOCAL_LIVE_READY_1234" }],
      },
    ],
  };
  assert.equal(messageText(snapshot.messages[1].content), "LOCAL_LIVE_READY_1234");
  assert.deepEqual(promptAttempt(snapshot, "LOCAL_LIVE_READY_1234"), { status: "success" });
  assert.deepEqual(snapshotSummary(snapshot), {
    available: true,
    sequence: undefined,
    modelCount: 0,
    messageRoles: ["user", "assistant"],
    assistantStops: ["unknown"],
    stateKeys: [],
  });
});

test("local-live helper distinguishes provider auth rejection from an upstream block", () => {
  const withError = (errorMessage) => ({
    messages: [
      { role: "user", content: "LOCAL_LIVE_READY_1234" },
      { role: "assistant", stopReason: "error", errorMessage, content: [] },
    ],
  });
  assert.deepEqual(promptAttempt(withError("401 Unauthorized"), "LOCAL_LIVE_READY_1234"), {
    status: "auth-failure",
  });
  assert.deepEqual(
    promptAttempt(withError("<html>Unable to load site</html>"), "LOCAL_LIVE_READY_1234"),
    { status: "upstream-failure" },
  );
  assert.deepEqual(promptAttempt({ messages: [] }, "LOCAL_LIVE_READY_1234"), {
    status: "pending",
  });
});
