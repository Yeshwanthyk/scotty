import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FakeWorkerService } from "../support/fake-worker.mjs";
import { assertNoLeaks } from "../support/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COOKIE = "__Host-scotty";

async function create(service, prompt = "protocol fixture") {
  const response = await fetch(`${service.url}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, provider: "cloudflare", repo: "owner/project" }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function createForRepo(service, repo) {
  const response = await fetch(`${service.url}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: `work on ${repo}`, provider: "cloudflare", repo }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function cookieHeader(response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  assert.match(cookie, /^__Host-scotty=/u);
  assert.match(cookie, /HttpOnly/iu);
  assert.match(cookie, /Secure/iu);
  assert.match(cookie, /SameSite=Strict/iu);
  return cookie.split(";", 1)[0];
}

async function issueRecovery(service) {
  const response = await fetch(`${service.url}/api/auth/recovery-grants`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(typeof body.url, "string");
  assert.doesNotMatch(body.url, new RegExp(service.token));
  const token = new URL(body.url).hash.slice("#token=".length);
  assert.match(token, /^scotty_recovery\./u);
  return { ...body, token };
}

async function consumeRecovery(service, token, label = "Owner browser") {
  const response = await fetch(`${service.url}/api/auth/recovery-grants/consume`, {
    method: "POST",
    headers: {
      origin: service.url,
      "content-type": "application/json",
      "user-agent": label,
    },
    body: JSON.stringify({ token }),
  });
  return { response, cookie: response.ok ? cookieHeader(response) : undefined };
}

async function recoverOwner(service, label = "Owner browser") {
  const grant = await issueRecovery(service);
  const consumed = await consumeRecovery(service, grant.token, label);
  assert.equal(consumed.response.status, 200);
  return { ...consumed, grant };
}

async function pairClient(service, ownerCookie, label) {
  const issued = await fetch(`${service.url}/api/auth/pairings`, {
    method: "POST",
    headers: {
      cookie: ownerCookie,
      origin: service.url,
      "content-type": "application/json",
    },
    body: JSON.stringify({ label }),
  });
  assert.equal(issued.status, 200);
  const pairing = await issued.json();
  const token = new URL(pairing.url).hash.slice("#token=".length);
  const consumed = await fetch(`${service.url}/api/auth/pairings/consume`, {
    method: "POST",
    headers: {
      origin: service.url,
      "content-type": "application/json",
      "user-agent": label,
    },
    body: JSON.stringify({ token, label }),
  });
  assert.equal(consumed.status, 200);
  const body = await consumed.json();
  return { cookie: cookieHeader(consumed), client: body.client, pairing, token };
}

test("root bearer stays out of browser URLs and recovery creates the only owner cookie", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const session = await create(service);
  assert.equal(session.url, `${service.url}/s/${session.id}`);

  const unauthenticated = await fetch(`${service.url}/s/${session.id}`, { redirect: "manual" });
  assert.equal(unauthenticated.status, 401);
  const query = await fetch(
    `${service.url}/s/${session.id}?t=${encodeURIComponent(service.token)}`,
    { redirect: "manual" },
  );
  assert.equal(query.status, 401);
  assert.equal(query.headers.get("set-cookie"), null);
  const rootCookie = await fetch(`${service.url}/s/${session.id}`, {
    headers: { cookie: `${COOKIE}=${service.token}` },
  });
  assert.equal(rootCookie.status, 401);
  const rootBearer = await fetch(`${service.url}/s/${session.id}`, {
    headers: { authorization: `Bearer ${service.token}` },
  });
  assert.equal(rootBearer.status, 401);

  const owner = await recoverOwner(service);
  const authenticated = await fetch(`${service.url}/s/${session.id}`, {
    headers: { cookie: owner.cookie },
  });
  assert.equal(authenticated.status, 200);
  assert.doesNotMatch(await authenticated.text(), new RegExp(service.token));
  const authority = service.inspect().auth;
  assert.equal(authority.ownership.state, "claimed");
  assert.equal(authority.clients.length, 1);
  assert.deepEqual(authority.clients[0].scopes, ["sessions:read", "sessions:write"]);
  assert.doesNotMatch(JSON.stringify(authority), new RegExp(owner.grant.token));
});

test("V1 migration, recovery, pairing, transfer, and a second recovery preserve single ownership", async (t) => {
  const service = new FakeWorkerService();
  const legacyCredentials = service.seedV1Authority();
  await service.start();
  t.after(() => service.stop());

  const legacyCookie = `${COOKIE}=${legacyCredentials[0]}`;
  const migratedRead = await fetch(`${service.url}/api/sessions`, {
    headers: { cookie: legacyCookie },
  });
  assert.equal(migratedRead.status, 200);
  const migrated = service.inspect().auth;
  assert.deepEqual(migrated.ownership, { state: "unclaimed", epoch: 0 });
  assert.ok(migrated.clients.every((client) => client.scopes.length === 2));
  assert.equal(migrated.pairings.length, 0);
  const legacyOwnerRoute = await fetch(`${service.url}/api/auth/clients`, {
    headers: { cookie: legacyCookie },
  });
  assert.equal(legacyOwnerRoute.status, 401);

  const ownerA = await recoverOwner(service, "Owner A");
  for (const legacyCredential of legacyCredentials) {
    const rejected = await fetch(`${service.url}/api/sessions`, {
      headers: { cookie: `${COOKIE}=${legacyCredential}` },
    });
    assert.equal(rejected.status, 401);
  }

  const clientB = await pairClient(service, ownerA.cookie, "Target B");
  const clientsBefore = await fetch(`${service.url}/api/auth/clients`, {
    headers: { cookie: ownerA.cookie },
  });
  assert.equal(clientsBefore.status, 200);
  const beforeViews = await clientsBefore.json();
  assert.equal(beforeViews.filter((client) => client.role === "owner").length, 1);
  assert.equal(beforeViews.filter((client) => client.role === "standard").length, 1);

  const started = await fetch(`${service.url}/api/auth/owner-transfers`, {
    method: "POST",
    headers: {
      cookie: ownerA.cookie,
      origin: service.url,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ targetClientId: clientB.client.id }),
  });
  assert.equal(started.status, 200);
  const transfer = await started.json();
  const transferToken = new URL(transfer.url).hash.slice("#token=".length);
  const wrongTarget = await fetch(`${service.url}/api/auth/owner-transfers/accept`, {
    method: "POST",
    headers: {
      cookie: legacyCookie,
      origin: service.url,
      "content-type": "application/json",
    },
    body: JSON.stringify({ token: transferToken }),
  });
  assert.equal(wrongTarget.status, 401);
  assert.deepEqual(await wrongTarget.json(), {
    error: { code: "auth", message: "Owner transfer is invalid or expired" },
  });

  const accepted = await fetch(`${service.url}/api/auth/owner-transfers/accept`, {
    method: "POST",
    headers: {
      cookie: clientB.cookie,
      origin: service.url,
      "content-type": "application/json",
    },
    body: JSON.stringify({ token: transferToken }),
  });
  assert.equal(accepted.status, 200);
  const ownerB = cookieHeader(accepted);
  for (const staleCookie of [ownerA.cookie, clientB.cookie]) {
    const rejected = await fetch(`${service.url}/api/sessions`, {
      headers: { cookie: staleCookie },
    });
    assert.equal(rejected.status, 401);
  }
  const ownerBDevices = await fetch(`${service.url}/devices`, {
    headers: { cookie: ownerB },
  });
  assert.equal(ownerBDevices.status, 200);

  const pendingPairing = await fetch(`${service.url}/api/auth/pairings`, {
    method: "POST",
    headers: {
      cookie: ownerB,
      origin: service.url,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(pendingPairing.status, 200);
  const pendingPairingToken = new URL((await pendingPairing.json()).url).hash.slice(
    "#token=".length,
  );
  const ownerC = await recoverOwner(service, "Owner C");
  const staleOwnerB = await fetch(`${service.url}/devices`, {
    headers: { cookie: ownerB },
  });
  assert.equal(staleOwnerB.status, 401);
  const stalePairing = await fetch(`${service.url}/api/auth/pairings/consume`, {
    method: "POST",
    headers: {
      origin: service.url,
      "content-type": "application/json",
    },
    body: JSON.stringify({ token: pendingPairingToken, label: "Stale client" }),
  });
  assert.equal(stalePairing.status, 401);

  const finalAuthority = service.inspect().auth;
  assert.equal(finalAuthority.ownership.state, "claimed");
  assert.equal(finalAuthority.ownership.epoch, 3);
  assert.equal(
    finalAuthority.clients.filter(
      (client) => !client.revokedAt && client.id === finalAuthority.ownership.ownerClientId,
    ).length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(finalAuthority), new RegExp(ownerC.grant.token));
});

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

test("fake protocol matches production cap parsing, floor rounding, and backup handles", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const response = await fetch(`${service.url}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "contract fixture",
      provider: "cloudflare",
      repo: "owner/project",
      cap: "1h",
      hardCapSeconds: 90,
    }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  const record = service.sessions.get(session.id);
  assert.ok(Date.parse(record.hardCapAt) - Date.parse(record.createdAt) >= 90_000);
  assert.ok(Date.parse(record.hardCapAt) - Date.parse(record.createdAt) < 91_000);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const list = await fetch(`${service.url}/api/sessions`, {
    headers: { authorization: `Bearer ${service.token}` },
  });
  const [view] = await list.json();
  assert.ok(view.capRemainingSeconds < 90);

  const snapshot = await fetch(`${service.url}/api/sessions/${session.id}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}` },
  });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(record.backup.current, {
    id: record.backup.current.id,
    dir: `/workspace/${session.id}`,
  });
});

test("successful creation tracks a repo and vaporize retains it", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const repo = "yesh/scotty-repo-projection";
  const session = await createForRepo(service, repo);
  const headers = { authorization: `Bearer ${service.token}` };

  const listed = await fetch(`${service.url}/api/repos`, { headers });
  assert.equal(listed.status, 200);
  const reposBeforeVaporize = await listed.json();
  assert.equal(reposBeforeVaporize.length, 1);
  assert.deepEqual(Object.keys(reposBeforeVaporize[0]).sort(), [
    "defaultBranch",
    "lastUsedAt",
    "repo",
  ]);
  assert.equal(reposBeforeVaporize[0].repo, repo);
  assert.equal(reposBeforeVaporize[0].defaultBranch, "dev");
  assert.ok(Number.isFinite(Date.parse(reposBeforeVaporize[0].lastUsedAt)));

  const vaporized = await fetch(`${service.url}/api/sessions/${session.id}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(vaporized.status, 200);
  assert.equal(service.inspect().projections.length, 0, "session projection must be deleted");

  const retained = await fetch(`${service.url}/api/repos`, { headers });
  assert.equal(retained.status, 200);
  assert.deepEqual(await retained.json(), reposBeforeVaporize);
  assert.equal(service.inspect().trackedRepos.length, 1, "tracked repo must survive vaporize");
});

test("tracked repos use session-read auth and list newest use first", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const first = await createForRepo(service, "yesh/older-repo");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await createForRepo(service, "yesh/newer-repo");

  const unauthenticated = await fetch(`${service.url}/api/repos`);
  assert.equal(unauthenticated.status, 401);

  assert.equal(first.url, `${service.url}/s/${first.id}`);
  const owner = await recoverOwner(service);
  const sessionRead = await fetch(`${service.url}/api/sessions`, {
    headers: { cookie: owner.cookie },
  });
  const repoRead = await fetch(`${service.url}/api/repos`, {
    headers: { cookie: owner.cookie },
  });
  assert.equal(sessionRead.status, 200);
  assert.equal(repoRead.status, sessionRead.status);

  const repos = await repoRead.json();
  assert.deepEqual(
    repos.map((record) => record.repo),
    ["yesh/newer-repo", "yesh/older-repo"],
  );
  assert.ok(Date.parse(repos[0].lastUsedAt) > Date.parse(repos[1].lastUsedAt));
});

test("source-control publishing route is unavailable", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const session = await create(service);
  const response = await fetch(`${service.url}/api/sessions/${session.id}/pr`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
  });
  assert.equal(response.status, 404);
});

test("Pican stays mounted below the authenticated session path", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const session = await create(service);
  const owner = await recoverOwner(service);
  const headers = { cookie: owner.cookie };
  const shell = await fetch(`${service.url}/s/${session.id}`, { headers });
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), new RegExp(`/s/${session.id}/assets/app\\.js`, "u"));

  const asset = await fetch(`${service.url}/s/${session.id}/assets/app.js`, { headers });
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), new RegExp(`/s/${session.id}`, "u"));

  const hostedRuntime = await fetch(`${service.url}/s/${session.id}/api/hosted-runtime`, {
    headers,
  });
  assert.equal(hostedRuntime.status, 200);
  assert.deepEqual(await hostedRuntime.json(), service.runtimes.get(session.id).pican);
  assert.equal(service.runtimes.get(session.id).pican.processId, "scotty-pican");
  assert.match(service.runtimes.get(session.id).processList, /\/usr\/local\/bin\/pican/u);
});

test("sentinels are visible, real credentials are absent, and egress is default-deny", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const session = await create(service, "honeypot credential scan");
  const auth = { authorization: `Bearer ${service.token}`, "content-type": "application/json" };
  const snapshot = await fetch(`${service.url}/api/sessions/${session.id}/snapshot`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(snapshot.status, 200);

  const surfaces = service.publicSurfaces(session.id);
  assert.match(JSON.stringify(surfaces.container), new RegExp(`scotty-sentinel-${session.id}`));
  assert.match(JSON.stringify(surfaces.backups), new RegExp(`scotty-sentinel-${session.id}`));
  assertNoLeaks(surfaces, [service.realCodexSecret, service.realGithubSecret, service.token]);
  assert.doesNotMatch(surfaces.container.gitConfig, /https:\/\/[^/@]+@github\.com/);

  const denied = service.attemptEgress(session.id, "https://attacker.example/exfil");
  assert.deepEqual(denied, { allowed: false, status: 403, authorization: null });
  const allowed = service.attemptEgress(session.id, "https://api.openai.com/v1/responses");
  assert.equal(allowed.allowed, true);
  assert.equal(
    allowed.authorization,
    service.realCodexSecret,
    "credential injection happens only outside container-visible state",
  );
  const redirected = service.attemptEgress(
    session.id,
    "https://attacker.example/redirect-target",
    allowed.authorization,
  );
  assert.equal(
    redirected.allowed,
    false,
    "allowlisted requests must not carry injected auth across redirects",
  );
  assert.equal(redirected.authorization, null);
});

test("hard-cap backup failure destroys runtime, retains recovery, and can resume", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const session = await create(service);
  const headers = { authorization: `Bearer ${service.token}` };
  const snapshot = await fetch(`${service.url}/api/sessions/${session.id}/snapshot`, {
    method: "POST",
    headers,
  });
  assert.equal(snapshot.status, 200);
  const lastGoodBackup = service.sessions.get(session.id).backup.current.id;
  await service.forceHardCap(session.id, { backupFails: true });
  assert.equal(service.runtimes.has(session.id), false);
  assert.equal(service.sessions.get(session.id).status, "failed");
  assert.equal(service.sessions.get(session.id).backup.current.id, lastGoodBackup);
  assert.equal(service.sessions.get(session.id).failure.recoverable, true);
  const resume = await fetch(`${service.url}/api/sessions/${session.id}/resume`, {
    method: "POST",
    headers,
  });
  assert.equal(resume.status, 200);
  assert.equal((await resume.json()).status, "warm");
});
