import type { SessionRecord } from "../../src/contracts";

export const makeSessionRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 1,
  id: "a0b1c2d3e4f5",
  status: "warm",
  operation: null,
  provider: "cloudflare",
  repo: "owner/project",
  repoExistsAtCreate: true,
  defaultBranch: "dev",
  branch: "scotty/a0b1c2d3e4f5",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  hardCapAt: "2026-01-01T04:00:00.000Z",
  hardCapDurationSeconds: 14_400,
  ownedBackupIds: [],
  ...overrides,
});
