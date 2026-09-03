import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("critical auth pages externalize scripts and strip fragments before fetch", () => {
  const assets = path.join(ROOT, "worker/public");
  for (const name of ["pair", "owner-transfer", "recover"]) {
    const html = fs.readFileSync(path.join(assets, "auth", `${name}.html`), "utf8");
    const script = fs.readFileSync(path.join(assets, "auth", `${name}.js`), "utf8");
    assert.match(html, new RegExp(`<script type="module" src="/auth/${name}\\.js"></script>`, "u"));
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu);
    assert.ok(
      script.indexOf("history.replaceState") >= 0 &&
        script.indexOf("history.replaceState") < script.indexOf("fetch("),
      `${name} must remove its fragment before fetch`,
    );
    assert.match(script, /addEventListener\("click"/u);
    assert.doesNotMatch(script, /localStorage|sessionStorage/u);
  }
  const lockedHtml = fs.readFileSync(path.join(assets, "auth", "locked.html"), "utf8");
  assert.match(lockedHtml, /<code>scotty owner recover<\/code>/u);
  assert.doesNotMatch(lockedHtml, /<script|<form|<input|<textarea/iu);
  assert.doesNotMatch(
    lockedHtml,
    /scotty_recovery\.|authorization\s*:|bearer\s+|__Host-scotty|token=|credential=/iu,
  );
});

test("the TanStack session UI keeps protocol, state, and view boundaries explicit", () => {
  const sources = path.join(ROOT, "ui/src");
  const reader = fs.readFileSync(path.join(sources, "data/session-reader.ts"), "utf8");
  const lifecycle = fs.readFileSync(path.join(sources, "data/session-lifecycle.ts"), "utf8");
  const conversation = fs.readFileSync(path.join(sources, "components/Conversation.tsx"), "utf8");
  const route = fs.readFileSync(path.join(sources, "routes/s.$sessionId.tsx"), "utf8");

  assert.doesNotMatch(reader + lifecycle + conversation + route, /\/rpc\//u);
  assert.match(reader, /\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}/u);
  assert.match(lifecycle, /\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}/u);
  assert.doesNotMatch(conversation, /innerHTML|outerHTML|insertAdjacentHTML|srcdoc/u);
  assert.doesNotMatch(route, /localStorage|sessionStorage|new WebSocket/u);
});

test("superseded standalone product pages are absent", () => {
  const assets = path.join(ROOT, "worker/public");
  for (const name of ["session", "sessions", "stats"]) {
    assert.equal(fs.existsSync(path.join(assets, name, "index.html")), false);
  }
  for (const name of ["devices", "providers"]) {
    assert.equal(fs.existsSync(path.join(assets, "auth", `${name}.html`)), false);
    assert.equal(fs.existsSync(path.join(assets, "auth", `${name}.js`)), false);
    assert.equal(fs.existsSync(path.join(assets, "auth", `${name}.css`)), false);
  }
});

test("the UI build replaces only its bounded app asset directory", () => {
  const config = fs.readFileSync(path.join(ROOT, "ui/vite.config.ts"), "utf8");
  assert.match(config, /emptyOutDir:\s*true/u);
  assert.match(config, /outDir:\s*"\.\.\/worker\/public\/app"/u);
  assert.match(config, /outputPath:\s*"\/_shell\.html"/u);
  assert.doesNotMatch(config, /outDir:\s*"\.\.\/worker\/public"/u);
});
