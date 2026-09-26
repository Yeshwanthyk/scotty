import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("auth pages drop the token fragment before fetch and never persist it", () => {
  const assets = path.join(ROOT, "worker/public");
  for (const name of ["pair", "owner-transfer", "recover"]) {
    const script = fs.readFileSync(path.join(assets, "auth", `${name}.js`), "utf8");
    assert.ok(
      script.indexOf("history.replaceState") >= 0 &&
        script.indexOf("history.replaceState") < script.indexOf("fetch("),
      `${name} must remove its fragment before fetch`,
    );
    assert.doesNotMatch(script, /localStorage|sessionStorage/u);
  }
});

test("locked auth page never embeds tokens, cookies, or credentials", () => {
  const assets = path.join(ROOT, "worker/public");
  const lockedHtml = fs.readFileSync(path.join(assets, "auth", "locked.html"), "utf8");
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
