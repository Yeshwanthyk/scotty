import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PRODUCTION_CONTAINER_APPLICATION_NAME } from "./reconcile-containers.mjs";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("production deployment ownership", () => {
  it("has no mutable Wrangler production deploy command", () => {
    const rootPackage = JSON.parse(read("package.json"));
    const workerPackage = JSON.parse(read("worker/package.json"));
    const commands = [
      ...Object.values(rootPackage.scripts),
      ...Object.values(workerPackage.scripts),
      read("README.md"),
    ].join("\n");
    assert.doesNotMatch(commands, /wrangler\s+deploy(?!\s+--dry-run)/u);
    assert.equal(rootPackage.scripts["worker:deploy"], undefined);
    assert.equal(workerPackage.scripts.deploy, undefined);
  });

  it("serializes the sole Alchemy production workflow", () => {
    const workflow = read(".github/workflows/deploy-production.yml");
    assert.match(workflow, /group: scotty-alchemy-\$\{\{ github\.repository \}\}-production/u);
    assert.match(workflow, /cancel-in-progress: false/u);
    assert.match(workflow, /npx alchemy deploy alchemy\.run\.ts --stage production --yes/u);
    assert.match(workflow, /npm run audit:containers/gu);
    assert.doesNotMatch(workflow, /wrangler deploy/u);
  });

  it("pins the live Container application identity in infrastructure and audit code", () => {
    const infrastructure = read("spikes/infra/monolith-greenfield.ts");
    assert.match(infrastructure, new RegExp(PRODUCTION_CONTAINER_APPLICATION_NAME, "u"));
    assert.match(infrastructure, /name: MONOLITH_GREENFIELD_TOPOLOGY\.container\.name/u);
  });

  it("tracks every scheduled session callback in the cancellation inventory", () => {
    const session = read("worker/src/session.ts");
    const lifecycle = read("worker/src/session-lifecycle.ts");
    const scheduled = [...session.matchAll(/this\.schedule\([\s\S]{0,120}?"([^"]+)"/gu)].map(
      (match) => match[1],
    );
    const inventoryBlock =
      /SESSION_SCHEDULE_CALLBACKS = \[([\s\S]*?)\] as const/u.exec(lifecycle)?.[1] ?? "";
    const inventoried = [...inventoryBlock.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    assert.deepEqual([...new Set(scheduled)].sort(), [...new Set(inventoried)].sort());
  });
});
