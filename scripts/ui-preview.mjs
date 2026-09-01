import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { createPreviewSession, PREVIEW_SESSION_ID } from "./ui-preview-state.mjs";

const port = Number.parseInt(process.env.SCOTTY_UI_PREVIEW_PORT ?? "8791", 10);
const publicRoot = join(import.meta.dirname, "..", "worker", "public");
const now = Date.now();
const previewSession = createPreviewSession();

const sessions = [
  {
    id: PREVIEW_SESSION_ID,
    title: "Tighten the Scotty session interface",
    repo: "yeshwanth-yk/scotty",
    branch: "scotty/compact-session-ui",
    provider: "cloudflare",
    status: "warm",
    capRemainingSeconds: 8_240,
    hardCapAt: new Date(now + 8_240_000).toISOString(),
    createdAt: new Date(now - 31 * 60_000).toISOString(),
  },
  {
    id: "preview-review",
    title: "Review lifecycle evidence and deployment proof",
    repo: "yeshwanth-yk/scotty",
    branch: "scotty/evidence-review",
    provider: "cloudflare",
    status: "warm",
    capRemainingSeconds: 3_540,
    hardCapAt: new Date(now + 3_540_000).toISOString(),
    createdAt: new Date(now - 74 * 60_000).toISOString(),
  },
  {
    id: "preview-sleeping",
    title: "Package Pi extensions",
    repo: "yeshwanth-yk/pi-subagents",
    branch: "scotty/package-pi-extensions",
    provider: "cloudflare",
    status: "sleeping",
    backupId: "preview-backup",
    createdAt: new Date(now - 26 * 60 * 60_000).toISOString(),
  },
  ...Array.from({ length: 47 }, (_, index) => {
    const repositories = [
      "yeshwanth-yk/scotty",
      "yeshwanth-yk/pecan",
      "yeshwanth-yk/pi-codemode",
      "yeshwanth-yk/pi-subagents",
    ];
    const repo = repositories[index % repositories.length];
    const number = index + 4;
    return {
      id: `preview-sleeping-${String(number).padStart(2, "0")}`,
      title: `Archived task ${String(number).padStart(2, "0")} · ${repo.split("/").at(-1)}`,
      repo,
      branch: `scotty/archived-task-${number}`,
      provider: "cloudflare",
      status: "sleeping",
      backupId: `preview-backup-${number}`,
      createdAt: new Date(now - (number + 2) * 60 * 60_000).toISOString(),
    };
  }),
];

const changes = {
  files: [
    {
      path: "worker/public/session/changes.css",
      status: "modified",
      staged: false,
      unstaged: true,
      additions: 34,
      deletions: 28,
      binary: false,
      patchable: true,
    },
    {
      path: "worker/public/session/styles.css",
      status: "modified",
      staged: false,
      unstaged: true,
      additions: 21,
      deletions: 31,
      binary: false,
      patchable: true,
    },
    {
      path: "worker/public/sessions/styles.css",
      status: "modified",
      staged: false,
      unstaged: true,
      additions: 8,
      deletions: 14,
      binary: false,
      patchable: true,
    },
  ],
  truncated: false,
};

const patch = `diff --git a/worker/public/session/changes.css b/worker/public/session/changes.css
--- a/worker/public/session/changes.css
+++ b/worker/public/session/changes.css
@@ -20,8 +20,10 @@
 .changes-viewer {
-  width: min(1480px, calc(100vw - 48px));
-  height: min(880px, calc(100dvh - 48px));
+  inset: auto 16px 16px auto;
+  width: min(720px, calc(100vw - 32px));
+  height: min(520px, calc(100dvh - 96px));
+  margin: 0;
 }
`;

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

const json = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
};

const requestJson = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });

const serve = (response, pathname) => {
  const relative = normalize(pathname).replace(/^\/+/, "");
  const path = join(publicRoot, relative);
  if (!path.startsWith(publicRoot) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": types[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(response);
};

const serveSessionPreview = (response) => {
  const path = join(publicRoot, "session", "index.html");
  const version = String(Date.now());
  const html = readFileSync(path, "utf8")
    .replace('href="/session/styles.css"', `href="/session/styles.css?v=${version}"`)
    .replace('href="/session/changes.css"', `href="/session/changes.css?v=${version}"`)
    .replace(
      '<script type="module"',
      `<script>window.__previewErrors=[];window.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),0);window.cancelAnimationFrame=clearTimeout;addEventListener("error",event=>window.__previewErrors.push(String(event.error?.stack||event.message)));addEventListener("unhandledrejection",event=>window.__previewErrors.push(String(event.reason?.stack||event.reason)));</script><script type="module"`,
    )
    .replace('src="/session/index.js"', `src="/session/index.js?v=${version}"`);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
};

const serveSessionsPreview = (response) => {
  const path = join(publicRoot, "sessions", "index.html");
  const version = String(Date.now());
  const html = readFileSync(path, "utf8")
    .replace('href="/sessions/styles.css"', `href="/sessions/styles.css?v=${version}"`)
    .replace('href="/shared/styles.css"', `href="/shared/styles.css?v=${version}"`)
    .replace('src="/sessions/index.js"', `src="/sessions/index.js?v=${version}"`);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
};

const serveVersionedScript = (response, directory, filename, version) => {
  const path = join(publicRoot, directory, filename);
  const source = readFileSync(path, "utf8").replaceAll(
    /from "(\.\/[^"?]+\.js)"/gu,
    `from "$1?v=${version}"`,
  );
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(source);
};

// Keep the local fixture's route table visible in one place so its seeded states are easy to audit.
// eslint-disable-next-line complexity
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const pathname = url.pathname;
  if (pathname === "/") {
    response.writeHead(302, { location: "/sessions" }).end();
  } else if (pathname === "/sessions") serveSessionsPreview(response);
  else if (pathname === "/s/preview-agent")
    response.writeHead(302, { location: `/s/${PREVIEW_SESSION_ID}` }).end();
  else if (pathname === `/s/${PREVIEW_SESSION_ID}`) serveSessionPreview(response);
  else if (pathname === "/session/index.js" && url.searchParams.has("v"))
    serveVersionedScript(response, "session", "index.js", url.searchParams.get("v"));
  else if (pathname === "/sessions/index.js" && url.searchParams.has("v"))
    serveVersionedScript(response, "sessions", "index.js", url.searchParams.get("v"));
  else if (pathname === "/api/auth/me") json(response, { client: { role: "owner" } });
  else if (pathname === "/api/repos") json(response, []);
  else if (pathname === "/api/sessions") json(response, sessions);
  else if (pathname === `/s/${PREVIEW_SESSION_ID}/console/snapshot`)
    json(response, previewSession.snapshot());
  else if (pathname === `/s/${PREVIEW_SESSION_ID}/console/events`) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    });
    const unsubscribe = previewSession.subscribe(
      response,
      Number.parseInt(url.searchParams.get("since") ?? "0", 10),
    );
    request.on("close", unsubscribe);
  } else if (pathname === `/s/${PREVIEW_SESSION_ID}/console/command` && request.method === "POST") {
    try {
      const outcome = await previewSession.command(await requestJson(request));
      json(response, outcome.body, outcome.statusCode);
    } catch {
      json(response, { error: { message: "Invalid preview command" } }, 400);
    }
  } else if (pathname === `/api/sessions/${PREVIEW_SESSION_ID}/changes`) json(response, changes);
  else if (pathname === `/api/sessions/${PREVIEW_SESSION_ID}/changes/patch`)
    json(response, { ...changes.files[0], patch, truncated: false });
  else if (pathname === `/api/sessions/${PREVIEW_SESSION_ID}/hatch`)
    json(response, {
      status: "configured",
      hatchId: "preview-hatch",
      service: { name: "Scotty UI preview" },
      observedStatus: "running",
      desiredStatus: "open",
      exposure: "active",
    });
  else if (pathname === `/api/sessions/${PREVIEW_SESSION_ID}/evidence/preview-evidence`)
    json(response, {
      jobId: "preview-evidence",
      status: "succeeded",
      totalSteps: 3,
      completedSteps: 3,
      frameCount: 0,
      steps: [
        { index: 0, name: "Open session", status: "passed", assertions: [{ passed: true }] },
        { index: 1, name: "Open summary", status: "passed", assertions: [{ passed: true }] },
        { index: 2, name: "Verify mobile", status: "passed", assertions: [{ passed: true }] },
      ],
    });
  else if (pathname === `/s/${PREVIEW_SESSION_ID}/evidence/preview-evidence`)
    json(response, {
      status: "succeeded",
      summary: "3/3 preview steps and 3/3 assertions passed.",
    });
  else if (pathname === `/s/${PREVIEW_SESSION_ID}/hatch/open`)
    response.writeHead(302, { location: `/s/${PREVIEW_SESSION_ID}` }).end();
  else serve(response, pathname);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Scotty UI preview: http://localhost:${port}/sessions\n`);
  process.stdout.write(`Agent preview: http://localhost:${port}/s/${PREVIEW_SESSION_ID}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    previewSession.close();
    server.close(() => process.exit(0));
  });
}
