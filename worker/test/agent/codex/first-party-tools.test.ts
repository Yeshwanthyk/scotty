import { assert, it } from "@effect/vitest";
import { codexFirstPartyToolSpecs } from "../../../src/agent/codex/first-party-tools";

it("describes browser capture without taking ownership of the target app", () => {
  const browserTool = codexFirstPartyToolSpecs.find(({ name }) => name === "scotty_browser_test");
  assert.ok(browserTool);
  assert.include(browserTool.description, "already-running local app at its sandbox-local address");
  assert.include(
    browserTool.description,
    "Capture cleans up only resources it created. It leaves the target app running.",
  );
  assert.include(
    browserTool.description,
    "report it without restarting or reconfiguring the target app",
  );
  assert.notInclude(browserTool.description, "Hatch");
  assert.notInclude(browserTool.description, "duplicate server");
});
