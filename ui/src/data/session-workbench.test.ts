import { afterEach, describe, expect, it, vi } from "vitest";
import { readChangedFiles, readEvidence, readHatch } from "./session-workbench";

afterEach(() => vi.unstubAllGlobals());

describe("session workbench boundaries", () => {
  it("decodes live worktree files without trusting malformed fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          files: [
            {
              path: "ui/src/App.tsx",
              status: "modified",
              staged: false,
              unstaged: true,
              additions: 8,
              deletions: 2,
              binary: false,
              patchable: true,
            },
          ],
          truncated: false,
        }),
      ),
    );
    await expect(readChangedFiles("session-1")).resolves.toHaveLength(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          files: [
            {
              path: "ui/src/App.tsx",
              status: "invented",
              staged: false,
              unstaged: true,
              binary: false,
              patchable: true,
            },
          ],
        }),
      ),
    );
    await expect(readChangedFiles("session-1")).rejects.toThrow("Unreadable changed file");
  });

  it("projects evidence and Hatch availability from authenticated responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json([
            {
              jobId: "job-1",
              status: "succeeded",
              totalSteps: 1,
              completedSteps: 1,
              frameCount: 1,
              recordVideo: true,
              steps: [{ name: "Session view", status: "passed", frame: { frameId: "frame-1" } }],
            },
          ]),
        )
        .mockResolvedValueOnce(
          Response.json({
            status: "configured",
            hatchId: "hatch-1",
            service: { name: "Scotty UI" },
            observedStatus: "running",
            desiredStatus: "open",
            exposure: "active",
          }),
        ),
    );

    await expect(readEvidence("session-1")).resolves.toEqual([
      expect.objectContaining({ jobId: "job-1", recordVideo: true }),
    ]);
    await expect(readHatch("session-1")).resolves.toEqual({
      configured: true,
      hatchId: "hatch-1",
      serviceName: "Scotty UI",
      status: "running",
      available: true,
    });
  });
});
