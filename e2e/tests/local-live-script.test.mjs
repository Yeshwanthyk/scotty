import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantIncludes,
  formatLocalDevVars,
  localHarnessContainerIds,
  messageText,
  promptAttempt,
  repositoryFromRemote,
  snapshotSummary,
} from "../scripts/local-live.mjs";

test("local live E2E derives GitHub repositories from HTTPS and SSH remotes", () => {
  assert.equal(
    repositoryFromRemote("https://github.com/Yeshwanthyk/scotty.git\n"),
    "Yeshwanthyk/scotty",
  );
  assert.equal(repositoryFromRemote("git@github.com:Yeshwanthyk/scotty.git"), "Yeshwanthyk/scotty");
  assert.throws(() => repositoryFromRemote("https://example.com/owner/repo.git"));
});

test("local live E2E only cleans up new Scotty Wrangler containers", () => {
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

test("local live E2E writes isolated Worker inputs", () => {
  const value = formatLocalDevVars({
    rootToken: "root-token",
    githubToken: "github-token",
    openaiApiKey: "openai-key",
    opencodeApiKey: "opencode-key",
  });
  assert.match(
    value,
    new RegExp(
      `^SCOTTY_ROOT_VERIFIER_BOOTSTRAP="${createHash("sha256").update("root-token").digest("hex")}"$`,
      "mu",
    ),
  );
  assert.doesNotMatch(value, /^SCOTTY_TOKEN=/mu);
  assert.doesNotMatch(value, /root-token/u);
  assert.match(value, /^GH_TOKEN="github-token"$/mu);
  assert.match(value, /^OPENAI_API_KEY="openai-key"$/mu);
  assert.match(value, /^OPENCODE_API_KEY="opencode-key"$/mu);
  assert.match(value, /^SANDBOX_TRANSPORT="http"$/mu);
  assert.match(value, /^SCOTTY_LOCAL_E2E="1"$/mu);
});

test("local live E2E recognizes an assistant marker in Pi message content", () => {
  const snapshot = {
    messages: [
      { role: "user", content: "RESEED_AUTH_READY_1234" },
      {
        role: "assistant",
        content: [{ type: "text", text: "RESEED_AUTH_READY_1234" }],
      },
    ],
  };
  assert.equal(messageText(snapshot.messages[1].content), "RESEED_AUTH_READY_1234");
  assert.equal(assistantIncludes(snapshot, "RESEED_AUTH_READY_1234"), true);
  assert.equal(assistantIncludes(snapshot, "FRESH_AUTH_READY_1234"), false);
  assert.deepEqual(promptAttempt(snapshot, "RESEED_AUTH_READY_1234"), { status: "success" });
  assert.deepEqual(snapshotSummary(snapshot), {
    available: true,
    sequence: undefined,
    modelCount: 0,
    messageRoles: ["user", "assistant"],
    assistantStops: ["unknown"],
    stateKeys: [],
  });
});

test("local live E2E distinguishes provider auth rejection from an upstream block", () => {
  const withError = (errorMessage) => ({
    messages: [
      { role: "user", content: "FRESH_AUTH_READY_1234" },
      { role: "assistant", stopReason: "error", errorMessage, content: [] },
    ],
  });
  assert.deepEqual(promptAttempt(withError("401 Unauthorized"), "FRESH_AUTH_READY_1234"), {
    status: "auth-failure",
  });
  assert.deepEqual(
    promptAttempt(withError("<html>Unable to load site</html>"), "FRESH_AUTH_READY_1234"),
    { status: "upstream-failure" },
  );
  assert.deepEqual(promptAttempt({ messages: [] }, "FRESH_AUTH_READY_1234"), {
    status: "pending",
  });
});
