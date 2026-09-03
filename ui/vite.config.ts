import stylex from "@stylexjs/unplugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  build: { assetsDir: "app/assets" },
  environments: {
    client: {
      build: {
        assetsDir: "app/assets",
        emptyOutDir: false,
        outDir: "../worker/public",
      },
    },
  },
  plugins: [
    stylex.vite({ useCSSLayers: true }),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: { outputPath: "/app/_shell.html" },
      },
    }),
    viteReact(),
  ],
});
