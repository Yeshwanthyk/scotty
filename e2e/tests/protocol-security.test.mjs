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
  const devicesHtml = fs.readFileSync(path.join(assets, "auth", "devices.html"), "utf8");
  assert.match(devicesHtml, /<script type="module" src="\/auth\/devices\.js"><\/script>/u);
  assert.doesNotMatch(devicesHtml, /<script(?![^>]*\bsrc=)[^>]*>/iu);
});

test("browser chat modules keep protocol, state, view, and transport boundaries explicit", () => {
  const assets = path.join(ROOT, "worker/public");
  const app = fs.readFileSync(path.join(assets, "session", "index.js"), "utf8");
  const connection = fs.readFileSync(path.join(assets, "session", "pi-connection.js"), "utf8");
  const chat = fs.readFileSync(path.join(assets, "session", "chat.js"), "utf8");
  const artifacts = fs.readFileSync(path.join(assets, "session", "artifacts.js"), "utf8");

  assert.doesNotMatch(app + connection + chat + artifacts, /\/rpc\//u);
  assert.match(connection, /\/console\/\$\{operation\}/u);
  assert.doesNotMatch(connection, /\bdocument\b|\bwindow\b/u);
  assert.doesNotMatch(artifacts, /\bfetch\b|\bEventSource\b/u);
  assert.doesNotMatch(chat, /innerHTML|outerHTML|insertAdjacentHTML|srcdoc/u);
  assert.doesNotMatch(app, /localStorage|sessionStorage|new WebSocket/u);
});
