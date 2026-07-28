import { describe, expect, it } from "vitest";
import {
  isConfiguredDiscordLocation,
  parseThreadName,
  threadName,
  truncate,
} from "../src/helpers.ts";

describe("Scotty thread names", () => {
  it("uses and parses the first 12 session ID characters", () => {
    expect(threadName("abcdef12-3456-7890")).toBe("scotty-abcdef12-345");
    expect(parseThreadName("scotty-abcdef12-345")).toBe("abcdef12-345");
  });

  it("rejects unrelated or malformed thread names", () => {
    expect(parseThreadName("general")).toBeUndefined();
    expect(parseThreadName("scotty-too-short")).toBeUndefined();
    expect(parseThreadName("scotty-abcdefghijkl-extra")).toBeUndefined();
  });
});

describe("Discord location access", () => {
  it("accepts only the configured guild and parent channel", () => {
    expect(isConfiguredDiscordLocation("guild-1", "channel-1", "guild-1", "channel-1")).toBe(true);
    expect(isConfiguredDiscordLocation("guild-2", "channel-1", "guild-1", "channel-1")).toBe(false);
    expect(isConfiguredDiscordLocation("guild-1", "channel-2", "guild-1", "channel-1")).toBe(false);
  });
});

describe("truncate", () => {
  it("leaves limit-safe text unchanged", () => {
    expect(truncate("Scotty", 6)).toBe("Scotty");
  });

  it("uses an ellipsis without exceeding the limit", () => {
    expect(truncate("assistant response", 10)).toBe("assistant…");
    expect(truncate("response", 1)).toBe("…");
    expect(truncate("response", 0)).toBe("");
  });
});
