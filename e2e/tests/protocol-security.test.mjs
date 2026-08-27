import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("critical auth pages externalize scripts and strip fragments before fetch", () => {
  const assets = path.join(ROOT, "worker/public");
  for (const name of ["pair", "owner-transfer", "recover"]) {
    const html = fs.readFileSync(path.join(assets, `${name}.html`), "utf8");
    const script = fs.readFileSync(path.join(assets, `${name}.js`), "utf8");
    assert.match(html, new RegExp(`<script type="module" src="/${name}\\.js"></script>`, "u"));
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu);
    assert.ok(
      script.indexOf("history.replaceState") >= 0 &&
        script.indexOf("history.replaceState") < script.indexOf("fetch("),
      `${name} must remove its fragment before fetch`,
    );
    assert.match(script, /addEventListener\("click"/u);
    assert.doesNotMatch(script, /localStorage|sessionStorage/u);
  }
  const devicesHtml = fs.readFileSync(path.join(assets, "devices.html"), "utf8");
  assert.match(devicesHtml, /<script type="module" src="\/devices\.js"><\/script>/u);
  assert.doesNotMatch(devicesHtml, /<script(?![^>]*\bsrc=)[^>]*>/iu);
});

test("browser console modules keep protocol, state, view, and transport boundaries explicit", () => {
  const assets = path.join(ROOT, "worker/public");
  const terminal = fs.readFileSync(path.join(assets, "terminal.js"), "utf8");
  const commandLane = fs.readFileSync(path.join(assets, "terminal-command-lane.js"), "utf8");
  const projection = fs.readFileSync(path.join(assets, "terminal-projection.js"), "utf8");
  const commandView = fs.readFileSync(path.join(assets, "terminal-command-view.js"), "utf8");
  const consoleClient = fs.readFileSync(path.join(assets, "terminal-console-client.js"), "utf8");

  assert.doesNotMatch(terminal, /\/rpc\//u);
  assert.match(consoleClient, /\/console\/v1\//u);
  for (const stateModule of [commandLane, projection]) {
    assert.doesNotMatch(stateModule, /\bdocument\b|\bwindow\b/u);
  }
  assert.doesNotMatch(commandView, /\bfetch\b|\bEventSource\b/u);
});
