import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// The web app manifest that makes the UI installable to a phone's home screen. No service worker:
// every view is pushed over live sockets, so there is nothing to serve offline.
// The manifest sits at a fixed URL for the <link> in the root route; its icons are hashed assets.
const manifestPath = "/manifest.webmanifest";

const brand = "src/assets/brand";
const icons = [
  { file: "scotty-mark-192.png", sizes: "192x192", purpose: "any" },
  { file: "scotty-mark-512.png", sizes: "512x512", purpose: "any" },
  { file: "scotty-maskable-512.png", sizes: "512x512", purpose: "maskable" },
];

const manifest = (src: (file: string) => string) =>
  JSON.stringify(
    {
      name: "Scotty",
      short_name: "Scotty",
      start_url: "/sessions",
      scope: "/",
      display: "standalone",
      // The light theme-color in the root route.
      background_color: "#fbfbfa",
      theme_color: "#fbfbfa",
      icons: icons.map(({ file, sizes, purpose }) => ({
        src: src(file),
        sizes,
        type: "image/png",
        purpose,
      })),
    },
    null,
    2,
  );

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`${brand}/${file}`, import.meta.url)));

export function webManifest(): Plugin {
  return {
    name: "scotty-webmanifest",
    configureServer(server) {
      server.middlewares.use(manifestPath, (_request, response) => {
        response.setHeader("Content-Type", "application/manifest+json");
        response.end(manifest((file) => `/${brand}/${file}`));
      });
    },
    generateBundle() {
      if (this.environment.name !== "client") return;
      const emit = (file: string) =>
        `/${this.getFileName(this.emitFile({ type: "asset", name: file, source: read(file) }))}`;
      this.emitFile({ type: "asset", fileName: manifestPath.slice(1), source: manifest(emit) });
    },
  };
}
