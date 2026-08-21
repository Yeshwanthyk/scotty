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

  it("loads approvals for the selected scope and exposes clear states", () => {
    expect(environmentHtml).toContain('id="approvals-loading"');
    expect(environmentHtml).toContain('id="approvals-pending-empty" hidden');
    expect(environmentHtml).toContain('id="approvals-decisions-empty" hidden');
    expect(environmentHtml).toContain('id="approvals-error" role="alert" hidden');
    expect(environmentHtml).toContain('id="approvals-retry"');
    expect(environmentHtml).toContain("Secret values are never shown.");
    expect(environmentScript).toContain('environmentPath("/api/environment/approvals")');
    expect(environmentScript).toContain("Array.isArray(body?.pending)");
    expect(environmentScript).toContain("elements.approvalContent.hidden = false");
    expect(environmentScript).toContain(
      'elements.approvalRetry.addEventListener("click", () => void loadApprovals())',
    );
  });

  it("posts approval decisions without exposing environment values and refreshes", () => {
    expect(environmentScript).toContain('approvalActionButton(entry, "approve", "Approve")');
    expect(environmentScript).toContain('approvalActionButton(entry, "reject", "Reject", true)');
    expect(environmentScript).toContain('approvalActionButton(entry, "revoke", "Revoke", true)');
    expect(environmentScript).toContain("`/api/environment/approvals/${action}`");
    expect(environmentScript).toContain('method: "POST"');
    expect(environmentScript).toContain("body: JSON.stringify({ sourceScope, name, origin })");
    expect(environmentScript).toContain("await loadApprovals();");
    expect(environmentScript).toContain('entry.decision !== "revoked"');
    expect(environmentScript).not.toContain("entry.value");
    expect(environmentScript).not.toContain("entry.secret");
  });
});
