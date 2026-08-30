import { assert, describe, it } from "vitest";
import {
  cloudAgentSignature,
  groupCloudAgents,
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
      { repo: "openai/scotty", agents: [sleeping, warm] },
    ]);
    assert.isUndefined(normalizeCloudAgent({ title: "missing id" }));
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

  it("keeps one delegated selector and pauses polling while hidden", () => {
    assert.include(cloudAgentSource, 'target.addEventListener("click", click)');
    assert.include(cloudAgentSource, "if (fetching || document.hidden) return agents");
    assert.include(cloudAgentSource, "setInterval(() => void refresh(), interval)");
    assert.include(cloudAgentSource, 'row.setAttribute("aria-current", "page")');
    assert.include(cloudAgentSource, 'row.href = "/sessions"');
  });
});
