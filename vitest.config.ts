import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/session/*.test.ts", "scripts/oxlint-plugin-scotty/*.test.ts"],
  },
});
