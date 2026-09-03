import stylex from "@stylexjs/unplugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/app/",
  environments: {
    client: {
      build: {
        emptyOutDir: true,
        outDir: "../worker/public/app",
      },
    },
  },
  plugins: [
    stylex.vite({ useCSSLayers: true }),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: { outputPath: "/_shell.html" },
      },
    }),
    viteReact(),
  ],
});
