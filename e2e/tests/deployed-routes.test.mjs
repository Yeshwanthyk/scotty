import assert from "node:assert/strict";
import test from "node:test";

const host = process.env.SCOTTY_E2E_HOST?.replace(/\/$/, "");
const token = process.env.SCOTTY_E2E_TOKEN;
const skipReason =
  host && token ? false : "deployed route E2E skipped: set SCOTTY_E2E_HOST and SCOTTY_E2E_TOKEN";

test(
  "deployed edge routes only serve terminals from canonical session URLs",
  { skip: skipReason },
  async (context) => {
    const legacy = await fetch(`${host}/terminal`, { redirect: "manual" });
    assert.equal(legacy.status, 404);
    assert.equal(await legacy.text(), "Open a session with scotty attach ID or use its /s/ID URL.");

    const exchange = await fetch(`${host}/s/000000000000?t=${encodeURIComponent(token)}`, {
      redirect: "manual",
    });
    assert.equal(exchange.status, 302);
    assert.equal(exchange.headers.get("location"), "/s/000000000000");
    const cookie = exchange.headers.get("set-cookie");
    assert.match(cookie ?? "", /^__Host-scotty=/u);
    assert.match(cookie ?? "", /HttpOnly/iu);
    assert.match(cookie ?? "", /Secure/iu);
    assert.match(cookie ?? "", /SameSite=Strict/iu);
    const browserCookie = cookie?.split(";", 1)[0];
    assert.ok(browserCookie);
    context.after(async () => {
      const logout = await fetch(`${host}/api/auth/logout`, {
        method: "POST",
        headers: { cookie: browserCookie },
      });
      assert.equal(logout.status, 200);
    });

    const terminal = await fetch(`${host}/s/000000000000`, {
      headers: { cookie: browserCookie },
    });
    assert.equal(terminal.status, 200);
    assert.match(terminal.headers.get("content-type") ?? "", /text\/html/iu);
    assert.equal(terminal.headers.get("cache-control"), "no-store");
    const html = await terminal.text();
    assert.match(html, /\^\\\/s\\\/\(\[0-9a-f\]\{12\}\)/u);
    assert.match(html, /Ghostty\.load\("\/vendor\/ghostty-web\/ghostty-vt\.wasm"\)/u);
    assert.doesNotMatch(html, /lastIndexOf\("s"\)/u);

    const wasm = await fetch(`${host}/vendor/ghostty-web/ghostty-vt.wasm`);
    assert.equal(wasm.status, 200);
    assert.match(wasm.headers.get("content-type") ?? "", /application\/wasm/iu);
    assert.deepEqual(
      new Uint8Array((await wasm.arrayBuffer()).slice(0, 4)),
      new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    );
  },
);
