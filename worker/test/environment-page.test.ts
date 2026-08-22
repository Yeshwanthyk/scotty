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
    expect(environmentHtml).toContain('id="environment-sessions"');
    expect(environmentHtml).toContain('id="sessions-error" role="alert"');
    expect(environmentScript).toContain('fetchJson("/api/sessions"');
    expect(environmentScript).toContain("/environment/refresh");
    expect(environmentScript).toContain("refresh.disabled = !status.refreshable || !status.stale");
  });

  it("renders declared injection origins without exposing values", () => {
    expect(environmentScript).toContain('Injection origins: ${origins.join(", ")}');
    expect(environmentScript).not.toContain("/api/environment/approvals");
    expect(environmentScript).not.toContain("entry.value");
    expect(environmentScript).not.toContain("entry.secret");
  });
});
