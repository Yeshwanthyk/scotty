import { assert, describe, it } from "vitest";
import viewSource from "../public/terminal-subagents-view.js?raw";
import terminalSource from "../public/terminal.js?raw";
import terminalHtml from "../public/terminal.html?raw";

describe("terminal subagent browser view", () => {
  it("is read-only and exposes the parent handoff/detail affordances", () => {
    assert.include(viewSource, "Back to parent");
    assert.include(viewSource, "Current tools");
    assert.include(viewSource, "Queued");
    assert.include(viewSource, "Final output");
    assert.include(viewSource, "Failure");
    assert.include(viewSource, 'createElement("details")');
    assert.notInclude(viewSource, "steer");
    assert.notInclude(viewSource, "subagent_stop");
    assert.include(terminalSource, "renderSubagentList");
    assert.include(terminalSource, "renderSubagentDetail");
    assert.include(terminalHtml, "Open subagents and workflows");
    assert.include(terminalHtml, "subagent-activity-label");
    assert.include(terminalSource, "subagentActivityLabel.textContent");
    assert.notInclude(viewSource, "renderTerminalHandoff");
    const sseHandler = terminalSource.slice(terminalSource.indexOf("function consumeSseEvent"));
    assert.isBelow(
      sseHandler.indexOf("retainSelectedSubagent();"),
      sseHandler.indexOf("scheduleRender();"),
    );
    assert.notInclude(terminalSource, 'label === "Subagents" && currentProjection.subagents');
  });
});
