import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.md"],
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.lane/**",
      "**/.alchemy/**",
      "vendor/**",
      "work/**",
      // Quint trace replay runs only through `npm run spec`, never in CI.
      ...(process.env.SCOTTY_SPEC === "1" ? [] : ["**/*.replay.test.ts"]),
    ],
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./worker/test/support/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  server: {
    deps: {
      inline: ["@cloudflare/sandbox", "@cloudflare/containers"],
    },
  },
  ssr: {
    noExternal: ["@cloudflare/sandbox", "@cloudflare/containers"],
  },
});
