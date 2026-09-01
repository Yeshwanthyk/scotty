import { assert, describe, it } from "vitest";
import {
  cloudAgentGroupWindow,
  cloudAgentSignature,
  filterCloudAgents,
  groupCloudAgents,
  isActiveCloudAgent,
  normalizeCloudAgent,
} from "../../../public/session/cloud-agents.js";
import cloudAgentSource from "../../../public/session/cloud-agents.js?raw";

describe("cloud-agent directory", () => {
  const warm = normalizeCloudAgent({
    id: "a0b1c2d3e4f5",
    title: "Ship browser chat",
    repo: "openai/scotty",
    branch: "scotty/browser-chat",
    status: "warm",
    provider: "cloudflare",
  });
  const sleeping = normalizeCloudAgent({
    id: "f0e1d2c3b4a5",
    title: "Audit routes",
    repo: "openai/scotty",
    status: "sleeping",
    provider: "cloudflare",
  });

  it("normalizes the compact Session projection and groups it by repository", () => {
    assert.ok(warm);
    assert.ok(sleeping);
    assert.deepStrictEqual(groupCloudAgents([sleeping, warm]), [
      { repo: "openai/scotty", agents: [warm, sleeping] },
    ]);
    assert.isUndefined(normalizeCloudAgent({ title: "missing id" }));
  });

  it("keeps only booting and warm sessions in the in-session directory", () => {
    assert.ok(warm);
    assert.ok(sleeping);
    assert.isTrue(isActiveCloudAgent(warm));
    assert.isFalse(isActiveCloudAgent(sleeping));
    assert.isTrue(isActiveCloudAgent({ ...warm, status: "booting" }));
    assert.isFalse(isActiveCloudAgent({ ...warm, status: "failed" }));
    assert.include(cloudAgentSource, "const activeAgents = agents.filter(isActiveCloudAgent)");
    assert.include(cloudAgentSource, "count.textContent = String(activeAgents.length)");
  });

  it("pins active work and bounds sleeping rows until a repository is expanded", () => {
    assert.ok(warm);
    const sleepers = Array.from({ length: 12 }, (_, index) => ({
      id: `sleeping-${index}`,
      title: `Sleeping ${index}`,
      repo: "openai/scotty",
      branch: "",
      status: "sleeping",
      provider: "cloudflare",
    }));
    assert.deepStrictEqual(cloudAgentGroupWindow([warm, ...sleepers], warm.id), {
      agents: [warm, ...sleepers.slice(0, 6)],
      hidden: 6,
    });
    assert.deepStrictEqual(
      cloudAgentGroupWindow([warm, ...sleepers], warm.id, { expanded: true }),
      { agents: [warm, ...sleepers], hidden: 0 },
    );
  });

  it("changes its render signature only for visible directory state", () => {
    assert.ok(warm);
    const signature = cloudAgentSignature([warm], warm.id);
    assert.strictEqual(cloudAgentSignature([{ ...warm }], warm.id), signature);
    assert.notStrictEqual(
      cloudAgentSignature([{ ...warm, status: "sleeping" }], warm.id),
      signature,
    );
    assert.notStrictEqual(cloudAgentSignature([warm], "another"), signature);
  });

  it("filters a large directory by title, repository, or branch", () => {
    assert.ok(warm);
    assert.ok(sleeping);
    assert.deepStrictEqual(filterCloudAgents([warm, sleeping], "ship browser"), [warm]);
    assert.deepStrictEqual(filterCloudAgents([warm, sleeping], "OPENAI/SCOTTY"), [warm, sleeping]);
    assert.deepStrictEqual(filterCloudAgents([warm, sleeping], "browser-chat"), [warm]);
    assert.deepStrictEqual(filterCloudAgents([warm, sleeping], "missing"), []);
  });

  it("keeps one delegated selector and pauses polling while hidden", () => {
    assert.include(cloudAgentSource, 'target.addEventListener("click", click)');
    assert.include(cloudAgentSource, "if (fetching || document.hidden) return agents");
    assert.include(cloudAgentSource, "setInterval(() => void refresh(), interval)");
    assert.include(cloudAgentSource, 'row.setAttribute("aria-current", "page")');
    assert.include(cloudAgentSource, 'row.href = "/sessions"');
  });
});
