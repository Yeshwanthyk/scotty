import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "vendor/**", "work/**"],
  },
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./worker/test/cloudflare-workers-stub.ts", import.meta.url),
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
