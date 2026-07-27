import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTar } from "./tar.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROLLOUT = fs.readFileSync(path.join(HERE, "../fixtures/rollout.jsonl"), "utf8");
const COOKIE = "__Host-scotty";
const STANDARD_SCOPES = ["sessions:read", "sessions:write"];
const OWNER_SCOPES = [...STANDARD_SCOPES, "access:read", "access:write"];
const FIVE_MINUTES = 5 * 60 * 1_000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000;
const PUBLIC_SESSION_FIELDS = [
  "id",
  "status",
  "provider",
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
  result.capRemainingSeconds = Math.max(0, Math.floor((Date.parse(record.hardCapAt) - now) / 1000));
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

export class FakeWorkerService {
  constructor(options = {}) {
    this.token = options.token ?? "scotty-e2e-control-token";
    this.realCodexSecret = options.realCodexSecret ?? "e2e-real-codex-secret-never-expose";
    this.realGithubSecret = options.realGithubSecret ?? "e2e-real-github-secret-never-expose";
    this.sessions = new Map();
    this.projections = new Map();
    this.trackedRepos = new Map();
    this.backups = new Map();
    this.runtimes = new Map();
    this.credentials = new Map();
    this.tombstones = new Set();
    this.logs = [];
    this.counter = 0;
    this.auth = {
      version: 2,
      ownership: { state: "unclaimed", epoch: 0 },
      clients: [],
      pairings: [],
    };
    this.server = null;
    this.url = null;
  }

  async start() {
    this.server = http.createServer((request, response) => this.#handle(request, response));
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
      trackedRepos: this.#listTrackedRepos(),
      backupIds: [...this.backups.keys()],
      runtimeIds: [...this.runtimes.keys()],
      credentialIds: [...this.credentials.keys()],
      tombstones: [...this.tombstones],
      logs: structuredClone(this.logs),
      auth: structuredClone(this.auth),
    };
  }

  seedV1Authority(labels = ["Legacy admin A", "Legacy admin B"]) {
    const credentials = labels.map(() => this.#credential("scotty_client"));
    const now = Date.now();
    this.auth = {
      version: 1,
      clients: credentials.map((credential, index) => ({
        id: credential.id,
        credentialDigest: this.#digest(credential.secret),
        label: labels[index],
        scopes: [...OWNER_SCOPES],
        createdAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + THIRTY_DAYS).toISOString(),
        lastSeenAt: new Date(now - 1_000).toISOString(),
      })),
      pairings: [
        {
          id: "eeeeeeeeeeee",
          credentialDigest: this.#digest("e".repeat(43)),
          scopes: [...OWNER_SCOPES],
          createdAt: new Date(now - 1_000).toISOString(),
          expiresAt: new Date(now + FIVE_MINUTES).toISOString(),
        },
      ],
    };
    return credentials.map((credential) => credential.raw);
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

  #digest(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  #credential(prefix) {
    const id = crypto.randomBytes(6).toString("hex");
    const secret = crypto.randomBytes(32).toString("base64url");
    return { id, secret, raw: `${prefix}.${id}.${secret}` };
  }

  #parseCredential(value, prefix) {
    if (typeof value !== "string") return undefined;
    const match = new RegExp(`^${prefix}\\.([0-9a-f]{12})\\.([A-Za-z0-9_-]{32,128})$`, "u").exec(
      value,
    );
    return match ? { id: match[1], secret: match[2] } : undefined;
  }

  #migrateAuth() {
    if (this.auth.version === 2) return;
    const now = Date.now();
    this.auth = {
      version: 2,
      ownership: { state: "unclaimed", epoch: 0 },
      clients: this.auth.clients
        .filter((client) => !client.revokedAt && Date.parse(client.expiresAt) > now)
        .map((client) => ({ ...client, scopes: [...STANDARD_SCOPES] })),
      pairings: [],
    };
  }

  #purgeAuth() {
    this.#migrateAuth();
    const now = Date.now();
    const ownerId =
      this.auth.ownership.state === "claimed" ? this.auth.ownership.ownerClientId : undefined;
    this.auth.clients = this.auth.clients.filter(
      (client) =>
        client.id === ownerId || (!client.revokedAt && Date.parse(client.expiresAt) > now),
    );
    const activeIds = new Set(
      this.auth.clients
        .filter((client) => !client.revokedAt && Date.parse(client.expiresAt) > now)
        .map((client) => client.id),
    );
    this.auth.pairings = this.auth.pairings.filter((grant) => Date.parse(grant.expiresAt) > now);
    if (
      this.auth.ownerTransfer &&
      (Date.parse(this.auth.ownerTransfer.expiresAt) <= now ||
        !activeIds.has(this.auth.ownerTransfer.sourceOwnerClientId) ||
        !activeIds.has(this.auth.ownerTransfer.targetClientId))
    )
      delete this.auth.ownerTransfer;
    if (
      this.auth.recoveryGrant &&
      (Date.parse(this.auth.recoveryGrant.expiresAt) <= now ||
        this.auth.recoveryGrant.ownerEpoch !== this.auth.ownership.epoch)
    )
      delete this.auth.recoveryGrant;
  }

  #authenticateClient(raw, { renew = true } = {}) {
    this.#purgeAuth();
    const parsed = this.#parseCredential(raw, "scotty_client");
    if (!parsed) return undefined;
    const now = Date.now();
    const client = this.auth.clients.find(
      (candidate) =>
        candidate.id === parsed.id &&
        !candidate.revokedAt &&
        Date.parse(candidate.expiresAt) > now &&
        candidate.credentialDigest === this.#digest(parsed.secret),
    );
    if (!client) return undefined;
    const owner =
      this.auth.ownership.state === "claimed" && this.auth.ownership.ownerClientId === client.id;
    client.lastSeenAt = new Date(now).toISOString();
    if (renew && owner && Date.parse(client.expiresAt) - now <= 7 * 24 * 60 * 60 * 1_000)
      client.expiresAt = new Date(now + THIRTY_DAYS).toISOString();
    return client;
  }

  #clientFromRequest(request) {
    const raw = parseCookies(request.headers.cookie)[COOKIE];
    if (!raw || raw === this.token) return undefined;
    const client = this.#authenticateClient(raw);
    return client ? { kind: "client", raw, client } : undefined;
  }

  #principal(request) {
    if (request.headers.authorization === `Bearer ${this.token}`) return { kind: "root" };
    return this.#clientFromRequest(request);
  }

  #owner(request) {
    const principal = this.#clientFromRequest(request);
    return principal &&
      this.auth.ownership.state === "claimed" &&
      this.auth.ownership.ownerClientId === principal.client.id
      ? principal
      : undefined;
  }

  #view(client, currentId) {
    const owner =
      this.auth.ownership.state === "claimed" && this.auth.ownership.ownerClientId === client.id;
    return {
      id: client.id,
      label: client.label,
      scopes: owner ? [...OWNER_SCOPES] : [...STANDARD_SCOPES],
      role: owner ? "owner" : "standard",
      createdAt: client.createdAt,
      expiresAt: client.expiresAt,
      lastSeenAt: client.lastSeenAt,
      ...(client.userAgent ? { userAgent: client.userAgent } : {}),
      ...(client.id === currentId ? { current: true } : {}),
    };
  }

  #newClient(credential, label, userAgent) {
    const now = Date.now();
    return {
      id: credential.id,
      credentialDigest: this.#digest(credential.secret),
      label: typeof label === "string" && label.trim() ? label.trim().slice(0, 80) : "Browser",
      scopes: [...STANDARD_SCOPES],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + THIRTY_DAYS).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      ...(userAgent ? { userAgent: userAgent.slice(0, 512) } : {}),
    };
  }

  #cookie(credential) {
    return `${COOKIE}=${credential}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${
      THIRTY_DAYS / 1_000
    }`;
  }

  #sameOrigin(request) {
    return (
      request.headers.origin === this.url &&
      (!request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin")
    );
  }

  #isJson(request) {
    return request.headers["content-type"]?.split(";", 1)[0] === "application/json";
  }

  #authError(message = "Authentication required") {
    return error(401, "auth", message);
  }

  #authJson(value, status = 200, headers = {}) {
    return json(value, status, { "cache-control": "no-store", ...headers });
  }

  #grantInvalid(kind) {
    const message =
      kind === "pairing"
        ? "Pairing link is invalid or expired"
        : kind === "transfer"
          ? "Owner transfer is invalid or expired"
          : "Recovery link is invalid or expired";
    return this.#authError(message);
  }

  #consumeGrant(raw, prefix, record) {
    const parsed = this.#parseCredential(raw, prefix);
    return Boolean(
      parsed &&
      record &&
      record.id === parsed.id &&
      Date.parse(record.expiresAt) > Date.now() &&
      record.credentialDigest === this.#digest(parsed.secret),
    );
  }

  async #routeAuth(request, url) {
    if (!url.pathname.startsWith("/api/auth/")) return undefined;
    this.#purgeAuth();

    if (request.method === "POST" && url.pathname === "/api/auth/recovery-grants") {
      if (request.headers.authorization !== `Bearer ${this.token}`)
        return this.#authError("Recovery authorization failed");
      const credential = this.#credential("scotty_recovery");
      const expiresAt = new Date(Date.now() + FIVE_MINUTES).toISOString();
      this.auth.recoveryGrant = {
        id: credential.id,
        credentialDigest: this.#digest(credential.secret),
        ownerEpoch: this.auth.ownership.epoch,
        createdAt: new Date().toISOString(),
        expiresAt,
      };
      return this.#authJson({
        url: `${this.url}/recover#token=${credential.raw}`,
        expiresAt,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/recovery-grants/consume") {
      if (!this.#sameOrigin(request) || !this.#isJson(request))
        return error(400, "bad_request", "Request must come from this Scotty origin");
      const body = await readBody(request);
      const grant = this.auth.recoveryGrant;
      if (
        !this.#consumeGrant(body.token, "scotty_recovery", grant) ||
        grant.ownerEpoch !== this.auth.ownership.epoch
      )
        return this.#grantInvalid("recovery");
      const credential = this.#credential("scotty_client");
      const client = this.#newClient(credential, "Trusted browser", request.headers["user-agent"]);
      const revokedAt = new Date().toISOString();
      this.auth.clients = [
        ...this.auth.clients.map((candidate) => ({ ...candidate, revokedAt })),
        client,
      ];
      this.auth.ownership = {
        state: "claimed",
        ownerClientId: client.id,
        epoch: this.auth.ownership.epoch + 1,
      };
      this.auth.pairings = [];
      delete this.auth.ownerTransfer;
      delete this.auth.recoveryGrant;
      return this.#authJson({ client: this.#view(client, client.id) }, 200, {
        "set-cookie": this.#cookie(credential.raw),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/pairings/consume") {
      if (!this.#sameOrigin(request) || !this.#isJson(request))
        return error(400, "bad_request", "Request must come from this Scotty origin");
      const body = await readBody(request);
      const parsed = this.#parseCredential(body.token, "scotty_pair");
      const pairing = parsed
        ? this.auth.pairings.find((candidate) => candidate.id === parsed.id)
        : undefined;
      if (!this.#consumeGrant(body.token, "scotty_pair", pairing))
        return this.#grantInvalid("pairing");
      const credential = this.#credential("scotty_client");
      const client = this.#newClient(
        credential,
        body.label || pairing.label || "Paired browser",
        request.headers["user-agent"],
      );
      this.auth.clients.push(client);
      this.auth.pairings = this.auth.pairings.filter((candidate) => candidate.id !== pairing.id);
      return this.#authJson({ client: this.#view(client, client.id) }, 200, {
        "set-cookie": this.#cookie(credential.raw),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/owner-transfers/accept") {
      if (!this.#sameOrigin(request) || !this.#isJson(request))
        return error(400, "bad_request", "Request must come from this Scotty origin");
      const body = await readBody(request);
      const target = this.#clientFromRequest(request);
      const transfer = this.auth.ownerTransfer;
      if (
        !target ||
        !this.#consumeGrant(body.token, "scotty_transfer", transfer) ||
        target.client.id !== transfer.targetClientId ||
        this.auth.ownership.state !== "claimed" ||
        this.auth.ownership.ownerClientId !== transfer.sourceOwnerClientId ||
        this.auth.ownership.epoch !== transfer.ownerEpoch
      )
        return this.#grantInvalid("transfer");
      const source = this.auth.clients.find(
        (client) =>
          client.id === transfer.sourceOwnerClientId &&
          !client.revokedAt &&
          Date.parse(client.expiresAt) > Date.now(),
      );
      if (!source) return this.#grantInvalid("transfer");
      const replacementSecret = crypto.randomBytes(32).toString("base64url");
      const replacement = `scotty_client.${target.client.id}.${replacementSecret}`;
      const now = new Date().toISOString();
      target.client.credentialDigest = this.#digest(replacementSecret);
      target.client.expiresAt = new Date(Date.now() + THIRTY_DAYS).toISOString();
      target.client.lastSeenAt = now;
      source.revokedAt = now;
      this.auth.ownership = {
        state: "claimed",
        ownerClientId: target.client.id,
        epoch: this.auth.ownership.epoch + 1,
      };
      this.auth.pairings = [];
      delete this.auth.ownerTransfer;
      delete this.auth.recoveryGrant;
      return this.#authJson({ client: this.#view(target.client, target.client.id) }, 200, {
        "set-cookie": this.#cookie(replacement),
      });
    }

    const principal = this.#principal(request);
    if (!principal) return this.#authError();
    if (principal.kind === "client" && request.method !== "GET" && !this.#sameOrigin(request))
      return error(400, "bad_request", "Request must come from this Scotty origin");

    if (request.method === "GET" && url.pathname === "/api/auth/me") {
      return this.#authJson(
        principal.kind === "root"
          ? { kind: "root", scopes: [...OWNER_SCOPES] }
          : {
              kind: "client",
              scopes: this.#view(principal.client).scopes,
              client: this.#view(principal.client, principal.client.id),
            },
      );
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      if (principal.kind !== "client") return this.#authError();
      if (
        this.auth.ownership.state === "claimed" &&
        this.auth.ownership.ownerClientId === principal.client.id
      )
        return error(409, "conflict", "Transfer ownership or use recovery before signing out");
      principal.client.revokedAt = new Date().toISOString();
      if (this.auth.ownerTransfer?.targetClientId === principal.client.id)
        delete this.auth.ownerTransfer;
      return this.#authJson({ ok: true }, 200, {
        "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      });
    }

    const owner =
      principal.kind === "client" &&
      this.auth.ownership.state === "claimed" &&
      this.auth.ownership.ownerClientId === principal.client.id
        ? principal
        : undefined;
    if (!owner) return this.#authError("The primary device is required");

    if (request.method === "POST" && url.pathname === "/api/auth/pairings") {
      if (!this.#isJson(request))
        return error(400, "bad_request", "Request content type must be application/json");
      const body = await readBody(request);
      const credential = this.#credential("scotty_pair");
      const expiresAt = new Date(Date.now() + FIVE_MINUTES).toISOString();
      this.auth.pairings.push({
        id: credential.id,
        credentialDigest: this.#digest(credential.secret),
        createdAt: new Date().toISOString(),
        expiresAt,
        ...(typeof body.label === "string" ? { label: body.label.slice(0, 80) } : {}),
      });
      return this.#authJson({
        id: credential.id,
        url: `${this.url}/pair#token=${credential.raw}`,
        expiresAt,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/clients") {
      return this.#authJson(
        this.auth.clients
          .filter((client) => !client.revokedAt && Date.parse(client.expiresAt) > Date.now())
          .map((client) => this.#view(client, owner.client.id)),
      );
    }

    const clientMatch = /^\/api\/auth\/clients\/([0-9a-f]{12})$/u.exec(url.pathname);
    if (request.method === "DELETE" && clientMatch) {
      if (clientMatch[1] === owner.client.id)
        return error(409, "conflict", "Transfer ownership before revoking the primary device");
      const target = this.auth.clients.find(
        (client) => client.id === clientMatch[1] && !client.revokedAt,
      );
      if (!target) return error(404, "not_found", "Registered client was not found");
      target.revokedAt = new Date().toISOString();
      if (this.auth.ownerTransfer?.targetClientId === target.id) delete this.auth.ownerTransfer;
      return this.#authJson({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/owner-transfers") {
      if (!this.#isJson(request))
        return error(400, "bad_request", "Request content type must be application/json");
      const body = await readBody(request);
      const target = this.auth.clients.find(
        (client) =>
          client.id === body.targetClientId &&
          client.id !== owner.client.id &&
          !client.revokedAt &&
          Date.parse(client.expiresAt) > Date.now(),
      );
      if (!target) return error(404, "not_found", "Registered client was not found");
      if (this.auth.ownerTransfer)
        return error(409, "conflict", "Cancel the current owner transfer before starting another");
      const credential = this.#credential("scotty_transfer");
      const record = {
        id: credential.id,
        credentialDigest: this.#digest(credential.secret),
        sourceOwnerClientId: owner.client.id,
        targetClientId: target.id,
        ownerEpoch: this.auth.ownership.epoch,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + FIVE_MINUTES).toISOString(),
      };
      this.auth.ownerTransfer = record;
      return this.#authJson({
        id: record.id,
        sourceOwnerClientId: record.sourceOwnerClientId,
        targetClientId: record.targetClientId,
        ownerEpoch: record.ownerEpoch,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        url: `${this.url}/owner-transfer#token=${credential.raw}`,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/owner-transfers/current") {
      const record = this.auth.ownerTransfer;
      return this.#authJson(
        record
          ? {
              id: record.id,
              sourceOwnerClientId: record.sourceOwnerClientId,
              targetClientId: record.targetClientId,
              ownerEpoch: record.ownerEpoch,
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
            }
          : null,
      );
    }

    const transferMatch = /^\/api\/auth\/owner-transfers\/([0-9a-f]{12})$/u.exec(url.pathname);
    if (request.method === "DELETE" && transferMatch) {
      if (this.auth.ownerTransfer?.id !== transferMatch[1]) return this.#grantInvalid("transfer");
      delete this.auth.ownerTransfer;
      return this.#authJson({ ok: true });
    }

    return error(404, "not_found", "Route not found", "Check the command");
  }

  async #route(request, url) {
    if (url.searchParams.has("t"))
      return this.#authError("Root-token browser links are not supported");

    const authResult = await this.#routeAuth(request, url);
    if (authResult) return authResult;

    const picanMatch = /^\/s\/([^/]+)(\/.*)?$/u.exec(url.pathname);
    if (picanMatch) {
      if (!this.#clientFromRequest(request)) return this.#authError();
      const record = this.sessions.get(picanMatch[1]);
      const runtime = this.runtimes.get(picanMatch[1]);
      if (!record) return error(404, "not_found", "Session not found", "Run scotty ls --json");
      if (record.status !== "warm" || !runtime) return this.#wrongState(record, "open", "warm");
      const suffix = picanMatch[2] ?? "";
      if (suffix === "/assets/app.js") {
        return {
          status: 200,
          headers: { "content-type": "text/javascript", "cache-control": "no-store" },
          body: Buffer.from(`globalThis.__PICAN_BASE_PATH__ = "/s/${record.id}";`),
        };
      }
      if (suffix === "/api/hosted-runtime") return json(runtime.pican);
      if (suffix !== "")
        return error(404, "not_found", "Pican route not found", "Check the mounted Pican path");
      return {
        status: 200,
        headers: {
          "content-type": "text/html",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        },
        body: Buffer.from(
          `<!doctype html><title>Pican</title><script src="/s/${record.id}/assets/app.js"></script>`,
        ),
      };
    }

    if (url.pathname === "/sessions") {
      if (!this.#clientFromRequest(request)) return this.#authError();
      return {
        status: 200,
        headers: { "content-type": "text/html", "cache-control": "no-store" },
        body: Buffer.from("<!doctype html><title>Scotty sessions</title>"),
      };
    }

    if (url.pathname === "/devices") {
      if (!this.#owner(request)) return this.#authError("The primary device is required");
      return {
        status: 200,
        headers: { "content-type": "text/html", "cache-control": "no-store" },
        body: Buffer.from("<!doctype html><title>Scotty devices</title>"),
      };
    }

    if (["/pair", "/owner-transfer", "/recover"].includes(url.pathname)) {
      return {
        status: 200,
        headers: {
          "content-type": "text/html",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        },
        body: Buffer.from("<!doctype html><title>Scotty authentication</title>"),
      };
    }

    if (!url.pathname.startsWith("/api/"))
      return error(404, "not_found", "Route not found", "Check the Scotty host");
    const principal = this.#principal(request);
    if (!principal)
      return error(401, "auth", "Authentication required", "Pass SCOTTY_TOKEN or --token");
    if (principal.kind === "client" && request.method !== "GET" && !this.#sameOrigin(request))
      return error(400, "bad_request", "Request must come from this Scotty origin");

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return json([...this.projections.values()].map((record) => publicRecord(record)));
    }
    if (request.method === "GET" && url.pathname === "/api/repos") {
      return json(this.#listTrackedRepos());
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readBody(request);
      if (typeof body.prompt !== "string" || !body.prompt.trim())
        return error(400, "bad_request", "prompt must be a non-empty string");
      if (body.provider !== "cloudflare")
        return error(400, "bad_request", "provider must be cloudflare");
      if (typeof body.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(body.repo))
        return error(400, "bad_request", "repo must be in owner/name form");
      const id = `e2e-${String(++this.counter).padStart(4, "0")}`;
      const now = new Date();
      const hardCapSeconds = Number.isInteger(body.hardCapSeconds)
        ? body.hardCapSeconds
        : 4 * 60 * 60;
      const record = {
        version: 1,
        id,
        status: "warm",
        operation: null,
        provider: body.provider,
        repo: body.repo,
        defaultBranch: "dev",
        branch: `scotty/${id}`,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        hardCapAt: new Date(now.getTime() + hardCapSeconds * 1000).toISOString(),
        projectedAt: now.toISOString(),
        codexThreadId: "019f8e2a-11aa-7000-8000-000000000001",
        rolloutEntries: null,
      };
      const sentinel = `scotty-sentinel-${id}`;
      this.sessions.set(id, record);
      this.credentials.set(id, { codex: this.realCodexSecret, github: this.realGithubSecret });
      this.runtimes.set(id, {
        generation: 1,
        worktree: "fixture worktree\n",
        env: { CODEX_HOME: `/workspace/${id}/.codex`, GH_TOKEN: sentinel, SCOTTY_AUTH: sentinel },
        authJson: JSON.stringify({ tokens: { access_token: sentinel, refresh_token: sentinel } }),
        gitConfig: `credential.helper=!scotty-sentinel-helper\nremote.origin.url=https://github.com/${record.repo}.git`,
        pican: {
          processId: "scotty-pican",
          mode: "hosted",
          runtime: "codex",
          basePath: `/s/${id}`,
          workspaceRoot: `/workspace/${id}`,
          stateRoot: `/workspace/${id}/.pican`,
          createState: "created",
          promptDispatchState: "accepted",
        },
        processList: `/usr/local/bin/pican -host 0.0.0.0 -p 31415 -runtime codex -codex-command /usr/local/bin/codex`,
      });
      this.#project(record);
      this.#trackRepo(record);
      this.logs.push({ event: "session.created", sessionId: id, outcome: "ok" });
      return json(
        {
          id,
          url: `${this.url}/s/${id}`,
          branch: record.branch,
          provider: record.provider,
          status: record.status,
        },
        200,
      );
    }

    const match = /^\/api\/sessions\/([^/]+)(?:\/(snapshot|resume|down))?$/.exec(url.pathname);
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
      });
      this.#project(record);
      return json({
        id,
        url: `${this.url}/s/${id}`,
        branch: record.branch,
        status: record.status,
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
        rolloutFile: `rollout-2026-07-20T12-00-00-${record.codexThreadId}.jsonl`,
      };
      const entries = record.rolloutEntries ?? [
        { name: "metadata.json", body: JSON.stringify(metadata, null, 2) },
        {
          name: `rollout/${metadata.rolloutFile}`,
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
      current: { id: backupId, dir: `/workspace/${record.id}` },
      ...(record.backup?.current ? { previous: record.backup.current } : {}),
    };
    record.updatedAt = new Date().toISOString();
    return backup;
  }

  #project(record) {
    record.projectedAt = new Date().toISOString();
    this.projections.set(record.id, publicRecord(record));
  }

  #trackRepo(record) {
    this.trackedRepos.set(record.repo, {
      repo: record.repo,
      defaultBranch: record.defaultBranch,
      lastUsedAt: new Date().toISOString(),
    });
  }

  #listTrackedRepos() {
    return [...this.trackedRepos.values()]
      .sort(
        (left, right) =>
          Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt) ||
          left.repo.localeCompare(right.repo),
      )
      .map((record) => structuredClone(record));
  }

  #wrongState(record, operation, expected) {
    return error(
      409,
      "wrong_state",
      `Cannot ${operation} session ${record.id} while it is ${record.status}`,
      `Wait for status ${expected}, then retry`,
    );
  }
}
