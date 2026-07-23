import assert from "node:assert/strict";
import test from "node:test";
import { FakeWorkerService } from "../support/fake-worker.mjs";
import { assertNoLeaks } from "../support/harness.mjs";

async function create(service, prompt = "protocol fixture") {
  const response = await fetch(`${service.url}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("websocket ready timeout")), 3_000);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const value =
        typeof event.data === "string" ? event.data : Buffer.from(event.data).toString();
      messages.push(value);
      if (messages.some((message) => message.includes('"type":"ready"'))) {
        clearTimeout(timer);
        resolve({ socket, messages });
      }
    });
    socket.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)), {
      once: true,
    });
  });
}

function waitForAck(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket ack timeout")), 3_000);
    socket.addEventListener("message", function listener(event) {
      const value =
        typeof event.data === "string" ? event.data : Buffer.from(event.data).toString();
      if (!value.includes('"type":"ack"')) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(JSON.parse(value));
    });
  });
}

test("query token is exchanged for a hardened cookie and stripped by redirect", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const session = await create(service);
  const first = await fetch(session.url, { redirect: "manual" });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get("location"), `/s/${session.id}`);
  assert.doesNotMatch(first.headers.get("location"), /[?&]t=/);
  const cookie = first.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\//i);

  const unauthenticated = await fetch(`${service.url}/s/${session.id}`, { redirect: "manual" });
  assert.equal(unauthenticated.status, 401);
  const authenticated = await fetch(`${service.url}/s/${session.id}`, { headers: { cookie } });
  assert.equal(authenticated.status, 200);
  assert.doesNotMatch(await authenticated.text(), new RegExp(service.token));
});

test("fake protocol matches production cap parsing, floor rounding, and backup handles", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const response = await fetch(`${service.url}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "contract fixture", cap: "1h", hardCapSeconds: 90 }),
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

test("malformed PR JSON preserves the production default title", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const session = await create(service);
  const response = await fetch(`${service.url}/api/sessions/${session.id}/pr`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
    body: "{",
  });
  assert.equal(response.status, 200);
  assert.equal(service.sessions.get(session.id).prTitle, `Scotty session ${session.id}`);
});

test("PTY auth, binary-before-ready, resize, and reconnect preserve the named runtime", async (t) => {
  const service = await new FakeWorkerService().start();
  t.after(() => service.stop());
  const session = await create(service);
  const wsBase = service.url.replace(/^http/, "ws");

  const rejected = await new Promise((resolve) => {
    const socket = new WebSocket(`${wsBase}/api/sessions/${session.id}/pty`);
    socket.addEventListener("open", () => resolve(false), { once: true });
    socket.addEventListener("error", () => resolve(true), { once: true });
  });
  assert.equal(rejected, true, "unauthenticated PTY must not upgrade");

  const first = await connect(`${wsBase}/api/sessions/${session.id}/pty?t=${service.token}`);
  assert.equal(
    first.messages[0],
    "fake-agent$ ",
    "PTY may emit binary output before its ready control frame",
  );
  const firstReady = JSON.parse(
    first.messages.find((message) => message.includes('"type":"ready"')),
  );
  const ackPromise = waitForAck(first.socket);
  first.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  const resizeAck = await ackPromise;
  assert.equal(resizeAck.resizeCount, 1);
  first.socket.close();

  const second = await connect(`${wsBase}/api/sessions/${session.id}/pty?t=${service.token}`);
  const secondReady = JSON.parse(
    second.messages.find((message) => message.includes('"type":"ready"')),
  );
  assert.equal(
    secondReady.generation,
    firstReady.generation,
    "reconnect must attach to the same managed runtime generation",
  );
  const inputAckPromise = waitForAck(second.socket);
  second.socket.send(JSON.stringify({ type: "input", data: "echo still-alive\\r" }));
  const inputAck = await inputAckPromise;
  assert.equal(inputAck.inputCount, 1);
  await service.forceHardCap(session.id);
  assert.equal(
    service.sessions.get(session.id).status,
    "sleeping",
    "an attached PTY must not extend the hard cap",
  );
  assert.equal(
    service.runtimes.has(session.id),
    false,
    "hard cap must destroy an attached runtime",
  );
  second.socket.close();
  const backedUpRuntime = service.backups.get(
    service.sessions.get(session.id).backup.current.id,
  ).runtime;
  assert.deepEqual(backedUpRuntime.ptyResizes, [{ cols: 120, rows: 40 }]);
  assert.deepEqual(backedUpRuntime.ptyInputs, ["echo still-alive\\r"]);
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
