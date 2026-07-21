import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTar } from "./tar.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROLLOUT = fs.readFileSync(path.join(HERE, "../fixtures/rollout.jsonl"), "utf8");
const COOKIE = "__Host-scotty";
const PUBLIC_SESSION_FIELDS = [
  "id",
  "status",
  "repo",
  "defaultBranch",
  "branch",
  "createdAt",
  "updatedAt",
  "hardCapAt",
  "projectedAt",
  "ageSeconds",
  "capRemainingSeconds",
  "codexThreadId",
];

function json(response, status = 200, headers = {}) {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Buffer.from(JSON.stringify(response)),
  };
}

function error(status, code, message, hint) {
  return json({ error: { code, message, hint } }, status);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim().split("=", 2))
      .filter(([key, value]) => key && value),
  );
}

function publicRecord(record, now = Date.now()) {
  const result = {};
  for (const key of PUBLIC_SESSION_FIELDS) {
    if (record[key] !== undefined) result[key] = record[key];
  }
  result.ageSeconds = Math.max(0, Math.floor((now - Date.parse(record.createdAt)) / 1000));
  result.capRemainingSeconds = Math.max(0, Math.ceil((Date.parse(record.hardCapAt) - now) / 1000));
  return result;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (cause) {
        reject(cause);
      }
    });
    request.on("error", reject);
  });
}

function durationMs(value = "4h") {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) return 4 * 60 * 60 * 1000;
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
}

function websocketAccept(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function websocketFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length >= 126) throw new Error("fake websocket frames must stay under 126 bytes");
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
}

function decodeWebsocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = Boolean(buffer[1] & 0x80);
  const length = buffer[1] & 0x7f;
  if (length >= 126) return null;
  const maskOffset = 2;
  const bodyOffset = masked ? 6 : 2;
  if (buffer.length < bodyOffset + length) return null;
  const body = Buffer.from(buffer.subarray(bodyOffset, bodyOffset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
  }
  return { opcode, body, bytes: bodyOffset + length };
}

export class FakeWorkerService {
  constructor(options = {}) {
    this.token = options.token ?? "scotty-e2e-control-token";
    this.realCodexSecret = options.realCodexSecret ?? "e2e-real-codex-secret-never-expose";
    this.realGithubSecret = options.realGithubSecret ?? "e2e-real-github-secret-never-expose";
    this.sessions = new Map();
    this.projections = new Map();
    this.backups = new Map();
    this.runtimes = new Map();
    this.credentials = new Map();
    this.tombstones = new Set();
    this.logs = [];
    this.counter = 0;
    this.server = null;
    this.url = null;
  }

  async start() {
    this.server = http.createServer((request, response) => this.#handle(request, response));
    this.server.on("upgrade", (request, socket) => this.#upgrade(request, socket));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop() {
    if (!this.server) return;
    for (const socket of this.server._connections ? [] : []) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  inspect() {
    return {
      sessions: [...this.sessions.values()].map((record) => structuredClone(record)),
      projections: [...this.projections.values()].map((record) => structuredClone(record)),
      backupIds: [...this.backups.keys()],
      runtimeIds: [...this.runtimes.keys()],
      credentialIds: [...this.credentials.keys()],
      tombstones: [...this.tombstones],
      logs: structuredClone(this.logs),
    };
  }

  publicSurfaces(id) {
    const record = this.sessions.get(id);
    const runtime = this.runtimes.get(id);
    const backups = [...this.backups.entries()].filter(([, backup]) => backup.sessionId === id);
    return {
      api: record ? publicRecord(record) : null,
      kv: this.projections.get(id) ?? null,
      container: runtime
        ? {
            env: runtime.env,
            authJson: runtime.authJson,
            gitConfig: runtime.gitConfig,
            processList: runtime.processList,
          }
        : null,
      backups: backups.map(([backupId, backup]) => ({ backupId, files: backup.files })),
      logs: this.logs.filter((entry) => entry.sessionId === id),
    };
  }

  attemptEgress(id, target, authorization = `Bearer scotty-sentinel-${id}`) {
    const host = new URL(target).hostname;
    const allowed = new Set([
      "github.com",
      "api.github.com",
      "codeload.github.com",
      "api.openai.com",
      "chatgpt.com",
      "registry.npmjs.org",
    ]);
    if (!allowed.has(host)) return { allowed: false, status: 403, authorization: null };
    const injected =
      host === "github.com" || host === "api.github.com"
        ? this.realGithubSecret
        : host === "api.openai.com" || host === "chatgpt.com"
          ? this.realCodexSecret
          : null;
    return {
      allowed: true,
      status: 200,
      authorization: authorization.includes(`scotty-sentinel-${id}`) ? injected : authorization,
    };
  }

  async forceHardCap(id, { backupFails = false } = {}) {
    const record = this.sessions.get(id);
    if (!record || record.status !== "warm") throw new Error(`cannot hard-cap ${id}`);
    if (backupFails) {
      record.status = "failed";
      record.failure = {
        code: "backup_failed",
        message: "Hard-cap checkpoint failed",
        recoverable: Boolean(record.backup?.current),
      };
      this.runtimes.delete(id);
      this.#project(record);
      return;
    }
    this.#checkpoint(record);
    record.status = "sleeping";
    record.updatedAt = new Date().toISOString();
    this.runtimes.delete(id);
    this.#project(record);
  }

  setRolloutEntries(id, entries) {
    const record = this.sessions.get(id);
    if (!record) throw new Error(`unknown session ${id}`);
    record.rolloutEntries = entries;
  }

  async #handle(request, response) {
    try {
      const url = new URL(request.url, this.url);
      const result = await this.#route(request, url);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch (cause) {
      const result = error(
        500,
        "internal",
        "Fake Worker failure",
        cause instanceof Error ? cause.message : String(cause),
      );
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    }
  }

  #authorized(request, url) {
    const bearer = request.headers.authorization === `Bearer ${this.token}`;
    const query = url.searchParams.get("t") === this.token;
    const cookie = parseCookies(request.headers.cookie)[COOKIE] === this.token;
    return bearer || query || cookie;
  }

  async #route(request, url) {
    const pageMatch = /^\/s\/([^/]+)$/.exec(url.pathname);
    if (pageMatch) {
      if (!this.#authorized(request, url))
        return error(
          401,
          "auth",
          "Authentication required",
          "Pass ?t= once or use the session cookie",
        );
      if (!this.sessions.has(pageMatch[1]))
        return error(404, "not_found", "Session not found", "Run scotty ls --json");
      if (url.searchParams.has("t")) {
        return {
          status: 302,
          headers: {
            location: `/s/${pageMatch[1]}`,
            "set-cookie": `${COOKIE}=${this.token}; Path=/; HttpOnly; Secure; SameSite=Strict`,
            "cache-control": "no-store",
          },
          body: Buffer.alloc(0),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "text/html", "cache-control": "no-store" },
        body: Buffer.from(
          "<!doctype html><title>Scotty E2E terminal</title><script>history.replaceState({}, '', location.pathname)</script>",
        ),
      };
    }

    if (!url.pathname.startsWith("/api/"))
      return error(404, "not_found", "Route not found", "Check the Scotty host");
    if (!this.#authorized(request, url))
      return error(401, "auth", "Authentication required", "Pass SCOTTY_TOKEN or --token");

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return json([...this.projections.values()].map((record) => publicRecord(record)));
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readBody(request);
      if (typeof body.prompt !== "string" || !body.prompt.trim())
        return error(400, "bad_usage", "prompt is required", "Pass a non-empty prompt");
      const id = `e2e-${String(++this.counter).padStart(4, "0")}`;
      const now = new Date();
      const cap = body.cap ?? url.searchParams.get("cap") ?? "4h";
      const record = {
        version: 1,
        id,
        status: "warm",
        operation: null,
        repo: body.repo ?? "anomalyco/rift",
        defaultBranch: "dev",
        branch: `scotty/${id}`,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        hardCapAt: new Date(now.getTime() + durationMs(cap)).toISOString(),
        projectedAt: now.toISOString(),
        codexThreadId: "019f8e2a-11aa-7000-8000-000000000001",
        rolloutEntries: null,
      };
      const sentinel = `scotty-sentinel-${id}`;
      this.sessions.set(id, record);
      this.credentials.set(id, { codex: this.realCodexSecret, github: this.realGithubSecret });
      this.runtimes.set(id, {
        generation: 1,
        ptyInputs: [],
        ptyResizes: [],
        worktree: "fixture worktree\n",
        env: { CODEX_HOME: `/workspace/${id}/.codex`, GH_TOKEN: sentinel, SCOTTY_AUTH: sentinel },
        authJson: JSON.stringify({ tokens: { access_token: sentinel, refresh_token: sentinel } }),
        gitConfig:
          "credential.helper=!scotty-sentinel-helper\nremote.origin.url=https://github.com/anomalyco/rift.git",
        processList: `tmux new-session -d -s agent fake-agent --session ${id}`,
      });
      this.#project(record);
      this.logs.push({ event: "session.created", sessionId: id, outcome: "ok" });
      return json(
        {
          id,
          url: `${this.url}/s/${id}?t=${this.token}`,
          branch: record.branch,
          status: record.status,
        },
        201,
      );
    }

    const match = /^\/api\/sessions\/([^/]+)(?:\/(snapshot|resume|pr|down|pty))?$/.exec(
      url.pathname,
    );
    if (!match) return error(404, "not_found", "Route not found", "Check the command");
    const [, id, action] = match;
    const record = this.sessions.get(id);
    if (!record) {
      if (request.method === "DELETE" && this.tombstones.has(id))
        return json({ id, status: "gone" });
      return error(404, "not_found", "Session not found", "Run scotty ls --json");
    }

    if (request.method === "POST" && action === "snapshot") {
      if (record.status !== "warm") return this.#wrongState(record, "snapshot", "warm");
      this.#checkpoint(record);
      this.#project(record);
      return json({ id, status: record.status, backupId: record.backup.current.id });
    }
    if (request.method === "POST" && action === "resume") {
      if (!["sleeping", "failed"].includes(record.status) || !record.backup?.current)
        return this.#wrongState(record, "resume", "sleeping or recoverable failed");
      const backup = this.backups.get(record.backup.current.id);
      record.status = "warm";
      record.failure = undefined;
      record.updatedAt = new Date().toISOString();
      record.hardCapAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      this.runtimes.set(id, {
        ...structuredClone(backup.runtime),
        generation: (backup.runtime.generation ?? 0) + 1,
        ptyInputs: [],
        ptyResizes: [],
      });
      this.#project(record);
      return json({
        id,
        url: `${this.url}/s/${id}?t=${this.token}`,
        branch: record.branch,
        status: record.status,
      });
    }
    if (request.method === "POST" && action === "pr") {
      if (record.status !== "warm") return this.#wrongState(record, "pr", "warm");
      return json({
        prUrl: `https://github.com/${record.repo}/pull/42`,
        branchUrl: `https://github.com/${record.repo}/tree/${record.branch}`,
        created: true,
      });
    }
    if (request.method === "GET" && action === "down") {
      if (record.status !== "warm") return this.#wrongState(record, "down", "warm");
      const metadata = {
        version: 1,
        id,
        repo: record.repo,
        defaultBranch: record.defaultBranch,
        branch: record.branch,
        sha: record.sha ?? "0123456789abcdef0123456789abcdef01234567",
        codexThreadId: record.codexThreadId,
        rolloutPath: `sessions/2026/07/20/rollout-2026-07-20T12-00-00-${record.codexThreadId}.jsonl`,
      };
      const entries = record.rolloutEntries ?? [
        { name: "metadata.json", body: JSON.stringify(metadata, null, 2) },
        {
          name: `rollout/${path.basename(metadata.rolloutPath)}`,
          body: FIXTURE_ROLLOUT,
          mode: 0o600,
        },
      ];
      return {
        status: 200,
        headers: {
          "content-type": "application/x-tar",
          "content-disposition": `attachment; filename="scotty-${id}.tar"`,
        },
        body: createTar(entries),
      };
    }
    if (request.method === "DELETE" && !action) {
      for (const [backupId, backup] of this.backups)
        if (backup.sessionId === id) this.backups.delete(backupId);
      this.runtimes.delete(id);
      this.credentials.delete(id);
      this.projections.delete(id);
      this.sessions.delete(id);
      this.tombstones.add(id);
      this.logs.push({ event: "session.vaporized", sessionId: id, outcome: "ok" });
      return json({ id, status: "gone" });
    }
    if (action === "pty")
      return error(
        426,
        "upgrade_required",
        "WebSocket upgrade required",
        "Connect with a WebSocket client",
      );
    return error(405, "method_not_allowed", "Method not allowed", "Check the command method");
  }

  #checkpoint(record) {
    const runtime = this.runtimes.get(record.id);
    if (record.backup?.previous?.id) this.backups.delete(record.backup.previous.id);
    const backupId = `backup-${record.id}-${Date.now()}-${this.backups.size + 1}`;
    const backup = {
      id: backupId,
      sessionId: record.id,
      createdAt: new Date().toISOString(),
      runtime: structuredClone(runtime),
      files: {
        [`/workspace/${record.id}/worktree.txt`]: runtime.worktree,
        [`/workspace/${record.id}/.codex/auth.json`]: runtime.authJson,
        [`/workspace/${record.id}/.codex/sessions/2026/07/20/rollout.jsonl`]: FIXTURE_ROLLOUT,
      },
    };
    this.backups.set(backupId, backup);
    record.backup = {
      current: { id: backupId },
      ...(record.backup?.current ? { previous: record.backup.current } : {}),
    };
    record.updatedAt = new Date().toISOString();
    return backup;
  }

  #project(record) {
    record.projectedAt = new Date().toISOString();
    this.projections.set(record.id, publicRecord(record));
  }

  #wrongState(record, operation, expected) {
    return error(
      409,
      "wrong_state",
      `Cannot ${operation} session ${record.id} while it is ${record.status}`,
      `Wait for status ${expected}, then retry`,
    );
  }

  #upgrade(request, socket) {
    const url = new URL(request.url, this.url);
    const match = /^\/api\/sessions\/([^/]+)\/pty$/.exec(url.pathname);
    const record = match && this.sessions.get(match[1]);
    if (!match || !this.#authorized(request, url) || !record || record.status !== "warm") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
        "",
        "",
      ].join("\r\n"),
    );
    const runtime = this.runtimes.get(record.id);
    socket.write(websocketFrame(2, Buffer.from("fake-agent$ ")));
    socket.write(
      websocketFrame(
        1,
        JSON.stringify({ type: "ready", sessionId: record.id, generation: runtime.generation }),
      ),
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const frame = decodeWebsocketFrame(pending);
        if (!frame) break;
        pending = pending.subarray(frame.bytes);
        if (frame.opcode === 8) {
          socket.write(websocketFrame(8, frame.body));
          return socket.end();
        }
        let message;
        try {
          message = JSON.parse(frame.body.toString());
        } catch {
          message = { type: "input", data: frame.body.toString() };
        }
        if (message.type === "resize")
          runtime.ptyResizes.push({ cols: message.cols, rows: message.rows });
        else runtime.ptyInputs.push(message.data ?? frame.body.toString());
        socket.write(
          websocketFrame(
            1,
            JSON.stringify({
              type: "ack",
              inputCount: runtime.ptyInputs.length,
              resizeCount: runtime.ptyResizes.length,
            }),
          ),
        );
      }
    });
  }
}
