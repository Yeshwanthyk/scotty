import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileContainerInventory } from "./reconcile-containers.mjs";

const NOW = Date.parse("2026-07-23T04:00:00.000Z");
const APPLICATION_NAME = "scotty-test-sandbox";

const application = (overrides = {}) => ({
  id: "application-id",
  name: APPLICATION_NAME,
  state: "active",
  instances: 7,
  ...overrides,
});

const instance = (overrides = {}) => ({
  id: "instance-id",
  name: "5794c31210f3",
  state: "running",
  location: "yyz04",
  version: 5,
  ...overrides,
});

const session = (overrides = {}) => ({
  id: "5794c31210f3",
  status: "warm",
  provider: "cloudflare",
  hardCapAt: "2026-07-23T06:51:13.713Z",
  ...overrides,
});

describe("Container reconciliation", () => {
  it("accepts one active session, one running instance, and inactive history", () => {
    const report = reconcileContainerInventory({
      applicationName: APPLICATION_NAME,
      applications: [application()],
      instances: [instance(), instance({ name: "old-session", state: "inactive" })],
      sessions: [session()],
      now: NOW,
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.counts, {
      managedApplications: 1,
      activeInstances: 1,
      inactiveIdentityRows: 1,
      projectedSessions: 1,
    });
    assert.equal(report.application.summaryInstances, 7);
  });

  it("accepts a ready application with no active sessions or instances", () => {
    const report = reconcileContainerInventory({
      applicationName: APPLICATION_NAME,
      applications: [application({ state: "ready" })],
      instances: [instance({ name: "old-session", state: "inactive" })],
      sessions: [session({ status: "sleeping" })],
      now: NOW,
    });
    assert.equal(report.ok, true);
    assert.equal(report.application.state, "ready");
    assert.deepEqual(report.counts, {
      managedApplications: 1,
      activeInstances: 0,
      inactiveIdentityRows: 1,
      projectedSessions: 1,
    });
  });

  it("rejects provisioning or degraded applications", () => {
    for (const state of ["provisioning", "degraded"]) {
      const report = reconcileContainerInventory({
        applicationName: APPLICATION_NAME,
        applications: [application({ state })],
        instances: [],
        sessions: [],
        now: NOW,
      });
      assert.equal(report.ok, false);
      assert.deepEqual(
        report.issues.map((issue) => issue.code),
        ["managed_application_inactive"],
      );
    }
  });

  it("discovers application identity by its installation-scoped name", () => {
    const report = reconcileContainerInventory({
      applicationName: APPLICATION_NAME,
      applications: [application({ id: "replacement" })],
      instances: [],
      sessions: [],
      now: NOW,
    });
    assert.equal(report.ok, true);
    assert.equal(report.application.id, "replacement");
  });

  it("rejects duplicate exact-name applications and active instances without sessions", () => {
    const report = reconcileContainerInventory({
      applicationName: APPLICATION_NAME,
      applications: [application(), application({ id: "duplicate" })],
      instances: [instance({ name: "aaaaaaaaaaaa" })],
      sessions: [],
      now: NOW,
    });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      ["managed_application_count", "active_instance_without_session"],
    );
  });

  it("rejects terminal or expired sessions with running compute", () => {
    const report = reconcileContainerInventory({
      applicationName: APPLICATION_NAME,
      applications: [application()],
      instances: [instance()],
      sessions: [
        session({
          status: "sleeping",
          hardCapAt: "2026-07-23T03:00:00.000Z",
        }),
      ],
      now: NOW,
    });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      ["active_instance_for_terminal_session", "active_instance_past_hard_cap"],
    );
  });

  it("rejects warm projections without an active instance", () => {
    const report = reconcileContainerInventory({
      applicationName: APPLICATION_NAME,
      applications: [application()],
      instances: [],
      sessions: [session()],
      now: NOW,
    });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      ["active_session_without_instance"],
    );
  });

  it("accepts a warm runner projection with only a stopped Cloudflare identity", () => {
    const report = reconcileContainerInventory({
      applicationName: APPLICATION_NAME,
      applications: [application()],
      instances: [instance({ state: "stopped" })],
      sessions: [session({ provider: "runner" })],
      now: NOW,
    });
    assert.equal(report.ok, true);
    assert.equal(report.counts.activeInstances, 0);
    assert.equal(report.counts.inactiveIdentityRows, 1);
  });
});
