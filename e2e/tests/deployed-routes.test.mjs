import assert from "node:assert/strict";
import test from "node:test";

const host = process.env.SCOTTY_E2E_HOST?.replace(/\/$/, "");
const token = process.env.SCOTTY_E2E_TOKEN;
const clientCredential = process.env.SCOTTY_E2E_CLIENT_CREDENTIAL;
const skipReason =
  host && token && clientCredential
    ? false
    : "deployed route E2E skipped: set SCOTTY_E2E_HOST, SCOTTY_E2E_TOKEN, and a non-mutating SCOTTY_E2E_CLIENT_CREDENTIAL";

test(
  "deployed edge routes only serve terminals from canonical session URLs",
  { skip: skipReason },
  async () => {
    const legacy = await fetch(`${host}/terminal`, { redirect: "manual" });
    assert.equal(legacy.status, 404);
    assert.equal(await legacy.text(), "Open a session with scotty attach ID or use its /s/ID URL.");

    const queryRejected = await fetch(`${host}/s/000000000000?t=${encodeURIComponent(token)}`, {
      redirect: "manual",
    });
    assert.equal(queryRejected.status, 401);
    assert.equal(queryRejected.headers.get("set-cookie"), null);

    const rootCookieRejected = await fetch(`${host}/s/000000000000`, {
      headers: { cookie: `__Host-scotty=${token}` },
    });
    assert.equal(rootCookieRejected.status, 401);
    const rootBearerRejected = await fetch(`${host}/s/000000000000`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(rootBearerRejected.status, 401);

    const browserCookie = `__Host-scotty=${clientCredential}`;

    const reposResponse = await fetch(`${host}/api/repos`, {
      headers: { cookie: browserCookie },
    });
    assert.equal(reposResponse.status, 200);
    const repos = await reposResponse.json();
    assert.ok(Array.isArray(repos));
    for (const repo of repos) {
      assert.deepEqual(Object.keys(repo).sort(), ["defaultBranch", "lastUsedAt", "repo"]);
      assert.match(repo.repo, /^[^/]+\/[^/]+$/u);
      assert.equal(typeof repo.defaultBranch, "string");
      assert.ok(Number.isFinite(Date.parse(repo.lastUsedAt)));
    }
    for (let index = 1; index < repos.length; index++) {
      assert.ok(
        Date.parse(repos[index - 1].lastUsedAt) >= Date.parse(repos[index].lastUsedAt),
        "tracked repos must be newest first",
      );
    }

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
