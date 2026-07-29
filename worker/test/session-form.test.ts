import { assert, describe, it } from "vitest";
import {
  groupSessionsByRepository,
  mergeRepositorySuggestions,
  promptText,
  repositoryName,
  safeSessionPath,
  sessionDisplayStatus,
  sessionTitle,
  submissionIdentity,
  titleText,
} from "../public/session-form.js";

describe("session form", () => {
  it("accepts a manual owner/repo value without changing its case", () => {
    assert.strictEqual(repositoryName("  Yeshwanthyk/scotty  "), "Yeshwanthyk/scotty");
    assert.isUndefined(repositoryName("scotty"));
    assert.isUndefined(repositoryName("owner/repo/extra"));
    assert.isUndefined(repositoryName("owner /repo"));
  });

  it("keeps prompt formatting while rejecting whitespace-only prompts", () => {
    assert.strictEqual(promptText(" fix this\r\nthen test "), " fix this\nthen test ");
    assert.isUndefined(promptText(" \n\t "));
  });

  it("normalizes bounded titles and provides a legacy session fallback", () => {
    assert.strictEqual(titleText("  Package Pi extensions  "), "Package Pi extensions");
    assert.isUndefined(titleText(" "));
    assert.isUndefined(titleText("x".repeat(121)));
    assert.strictEqual(
      sessionTitle({ id: "a0b1c2d3e4f5", title: "Package Pi extensions" }),
      "Package Pi extensions",
    );
    assert.strictEqual(
      sessionTitle({ id: "a0b1c2d3e4f5", repo: "Yeshwanthyk/scotty" }),
      "Yeshwanthyk/scotty · a0b1c2d3e4f5",
    );
    assert.strictEqual(sessionTitle({ id: "a0b1c2d3e4f5" }), "Session a0b1c2d3e4f5");
  });

  it("merges tracked repositories with current session repositories", () => {
    assert.deepStrictEqual(
      mergeRepositorySuggestions(
        [
          {
            repo: "Yeshwanthyk/scotty",
            defaultBranch: "main",
            lastUsedAt: "2026-07-23T15:00:00.000Z",
          },
        ],
        [
          { repo: "yeshwanthyk/SCOTTY", defaultBranch: "trunk" },
          { repo: "owner/project", defaultBranch: "main" },
          { repo: "invalid" },
        ],
      ),
      [
        {
          repo: "Yeshwanthyk/scotty",
          defaultBranch: "main",
          lastUsedAt: "2026-07-23T15:00:00.000Z",
        },
        { repo: "owner/project", defaultBranch: "main", lastUsedAt: undefined },
      ],
    );
  });

  it("groups workspaces by repository without creating duplicate case variants", () => {
    const first = {
      id: "one",
      repo: "Yeshwanthyk/scotty",
      status: "warm",
      createdAt: "2026-01-02T00:00:00.000Z",
    };
    const second = {
      id: "two",
      repo: "yeshwanthyk/SCOTTY",
      status: "warm",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const third = {
      id: "three",
      repo: "owner/pican",
      status: "sleeping",
      createdAt: "2025-12-01T00:00:00.000Z",
    };
    const unknown = {
      id: "four",
      repo: "invalid",
      status: "warm",
      createdAt: "2026-01-03T00:00:00.000Z",
    };

    assert.deepStrictEqual(groupSessionsByRepository([first, second, third, unknown]), [
      { repo: "Yeshwanthyk/scotty", sessions: [second, first] },
      { repo: "Unknown repository", sessions: [unknown] },
      { repo: "owner/pican", sessions: [third] },
    ]);
  });

  it("puts warm projects first while preserving project creation order", () => {
    const oldestProject = [
      {
        id: "old-sleeping",
        repo: "owner/oldest",
        status: "sleeping",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "new-warm",
        repo: "owner/oldest",
        status: "warm",
        createdAt: "2026-04-01T00:00:00.000Z",
      },
    ];
    const newerWarmProject = {
      id: "middle-warm",
      repo: "owner/newer",
      status: "warm",
      createdAt: "2026-02-01T00:00:00.000Z",
    };
    const olderFailedProject = {
      id: "old-failed",
      repo: "owner/failed",
      status: "failed",
      createdAt: "2025-01-01T00:00:00.000Z",
    };

    assert.deepStrictEqual(
      groupSessionsByRepository([
        newerWarmProject,
        olderFailedProject,
        oldestProject[1],
        oldestProject[0],
      ]),
      [
        { repo: "owner/oldest", sessions: oldestProject },
        { repo: "owner/newer", sessions: [newerWarmProject] },
        { repo: "owner/failed", sessions: [olderFailedProject] },
      ],
    );
  });

  it("reuses an idempotency key only while the submitted payload is unchanged", () => {
    let keys = 0;
    const createKey = () => `key-${++keys}`;
    const payload = {
      title: "Fix build",
      repo: "Yeshwanthyk/scotty",
      prompt: "Fix it",
      hardCapSeconds: 14_400,
    };
    const first = submissionIdentity(undefined, payload, createKey);
    const retry = submissionIdentity(first, { ...payload }, createKey);
    const changed = submissionIdentity(first, { ...payload, prompt: "Fix it well" }, createKey);

    assert.strictEqual(retry.key, "key-1");
    assert.strictEqual(changed.key, "key-2");
  });

  it("only accepts the returned same-origin path for the created session", () => {
    const origin = "https://scotty.example";
    assert.strictEqual(
      safeSessionPath("https://scotty.example/s/a0b1c2d3e4f5", "a0b1c2d3e4f5", origin),
      "/s/a0b1c2d3e4f5",
    );
    assert.isUndefined(
      safeSessionPath("https://evil.example/s/a0b1c2d3e4f5", "a0b1c2d3e4f5", origin),
    );
    assert.isUndefined(safeSessionPath("https://scotty.example/s/another", "a0b1c2d3e4f5", origin));
    assert.isUndefined(
      safeSessionPath("https://scotty.example/s/a0b1c2d3e4f5?next=evil", "a0b1c2d3e4f5", origin),
    );
  });

  it("shows an optimistic stopping state only while a warm session is running the sleep action", () => {
    assert.strictEqual(sessionDisplayStatus("warm", "sleep"), "stopping");
    assert.strictEqual(sessionDisplayStatus("warm", "delete"), "warm");
    assert.strictEqual(sessionDisplayStatus("sleeping", "sleep"), "sleeping");
    assert.strictEqual(sessionDisplayStatus(undefined, undefined), "unknown");
  });
});
