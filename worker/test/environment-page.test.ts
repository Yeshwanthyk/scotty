import { describe, expect, it } from "vitest";
import environmentHtml from "../public/environment.html?raw";
import environmentScript from "../public/environment.js?raw";

describe("environment dashboard", () => {
  it("selects registered repositories and keeps inherited entries read-only", () => {
    expect(environmentHtml).toContain('id="repository"');
    expect(environmentHtml).toContain('<option value="">Global</option>');
    expect(environmentScript).toContain('fetchJson("/api/repos"');
    expect(environmentScript).toContain('variable.source !== "repo"');
    expect(environmentScript).toContain(
      'actionButton(variable.name, inherited ? "override" : "remove")',
    );
    expect(environmentScript).toContain("?repo=${encodeURIComponent(elements.repository.value)}");
  });
});
