import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTAINER_CONTEXT_PATH,
  inspectContainerImageBudget,
  prepareContainerContext,
} from "../cli/src/deployment-packaging.mjs";
import { CLEAN_ROOM_CACHE_SCOPE, CLEAN_ROOM_CLI_PLATFORM } from "./check-cli-clean-room.mjs";

export const CONTAINER_IMAGE = "scotty-container:ci";
export const CONTAINER_IMAGE_PLATFORM = CLEAN_ROOM_CLI_PLATFORM;
export const CONTAINER_IMAGE_CACHE_SCOPE = "scotty-container-image";
export const CONTAINER_IMAGE_PI_PACKAGES = Object.freeze(["scotty-browser-test", "scotty-hatch"]);
export const CONTAINER_IMAGE_ABSENT_PI_PACKAGES = Object.freeze([
  "pi-subagents",
  "@ogulcancelik/pi-codex-compaction",
  "pi-tasks",
  "pi-workflows",
  "pi-background-terminals",
  "pi-askuser",
  "pi-web-access",
  "pi-amp-ui",
]);

const ghaCacheEnabled = (environment) =>
  environment.GITHUB_ACTIONS === "true" && typeof environment.ACTIONS_CACHE_URL === "string";

export const containerImagePlan = (root = process.cwd(), environment = process.env) => {
  const context = resolve(root, CONTAINER_CONTEXT_PATH);
  return {
    context,
    dockerfile: resolve(context, "worker/container/Dockerfile"),
    platform: CONTAINER_IMAGE_PLATFORM,
    image: CONTAINER_IMAGE,
    cache: ghaCacheEnabled(environment)
      ? {
          from: [
            `type=gha,scope=${CONTAINER_IMAGE_CACHE_SCOPE}`,
            `type=gha,scope=${CLEAN_ROOM_CACHE_SCOPE}`,
          ],
          to: `type=gha,mode=max,scope=${CONTAINER_IMAGE_CACHE_SCOPE},ignore-error=true`,
        }
      : undefined,
  };
};

const cacheArgs = (cache) => {
  if (cache === undefined) return [];
  return [...cache.from.flatMap((from) => ["--cache-from", from]), "--cache-to", cache.to];
};

export const containerImageBuildArgs = (plan) => [
  "buildx",
  "build",
  "--platform",
  plan.platform,
  "--load",
  "-t",
  plan.image,
  "-f",
  plan.dockerfile,
  ...cacheArgs(plan.cache),
  plan.context,
];

export const containerImageRunArgs = (plan, entrypoint, args, extra = []) => [
  "run",
  "--rm",
  "--platform",
  plan.platform,
  ...extra,
  "--entrypoint",
  entrypoint,
  plan.image,
  ...args,
];

export const containerImagePiVersionArgs = (plan) =>
  containerImageRunArgs(plan, "pi", ["--version"]);
const absentPiPackageListAssertion = (name) =>
  `if grep -F -- ${JSON.stringify(name)} /tmp/scotty-pi-packages.list >/dev/null; then echo "unexpected ${name}" >&2; exit 1; else grep_status=$?; test "$grep_status" -eq 1; fi`;

export const containerImagePiPackagesSmokeArgs = (plan) =>
  containerImageRunArgs(plan, "sh", [
    "-c",
    [
      "set -eu",
      "mkdir -p /tmp/scotty-pi-agent",
      "cp /opt/scotty/pi-packages/settings.json /tmp/scotty-pi-agent/settings.json",
      "PI_CODING_AGENT_DIR=/tmp/scotty-pi-agent PI_OFFLINE=1 pi list >/tmp/scotty-pi-packages.list",
      ...CONTAINER_IMAGE_ABSENT_PI_PACKAGES.map(absentPiPackageListAssertion),
      ...CONTAINER_IMAGE_ABSENT_PI_PACKAGES.map(
        (name) => `test ! -e ${JSON.stringify(`/opt/scotty/pi-packages/sources/${name}`)}`,
      ),
      ...CONTAINER_IMAGE_ABSENT_PI_PACKAGES.map(
        (name) => `test ! -e ${JSON.stringify(`/opt/scotty/pi-packages/npm/node_modules/${name}`)}`,
      ),
      ...CONTAINER_IMAGE_PI_PACKAGES.map(
        (name) => `grep -F ${JSON.stringify(name)} /tmp/scotty-pi-packages.list >/dev/null`,
      ),
      "test ! -d /tmp/scotty-pi-agent/git",
    ].join(" && "),
  ]);

export const containerImageCodexVersionArgs = (plan) =>
  containerImageRunArgs(plan, "sh", [
    "-c",
    [
      "set -eu",
      "mkdir -p /tmp/scotty-codex-smoke/home /tmp/scotty-codex-smoke/codex-home",
      'test "$(readlink -f /usr/local/bin/codex)" = "/opt/codex/bin/codex"',
      `test "$(stat -Lc '%a' /usr/local/bin/codex)" = "755"`,
      `node -e 'require("node:assert/strict").equal(require("/opt/codex/codex-package.json").version, "0.153.4")'`,
      "test -x /opt/codex/bin/codex-code-mode-host",
      "test -x /opt/codex/codex-path/rg",
      "test -x /opt/codex/codex-resources/bwrap",
      "test -x /opt/codex/codex-resources/zsh/bin/zsh",
      'test -z "$(find /opt/codex -perm /6000 -print -quit)"',
      "! command -v bwrap",
      "! dpkg-query -W -f='${Status}' bubblewrap 2>/dev/null | grep -q 'install ok installed'",
      'test "$(env -i HOME=/tmp/scotty-codex-smoke/home CODEX_HOME=/tmp/scotty-codex-smoke/codex-home PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/codex --version)" = "codex-cli 0.153.4"',
    ].join(" && "),
  ]);

export const CODEX_BUNDLE_SMOKE = `
import { strict as assert } from "node:assert";
import { program, run } from "./scotty-codex-host.mjs";
import { serverProgram, runServer } from "./scotty-codex-server.mjs";
assert.equal(typeof serverProgram, "function");
assert.equal(typeof runServer, "function");
assert.equal(typeof program, "function");
assert.equal(typeof run, "function");
`;

export const containerImageCodexPackagingArgs = (plan) =>
  containerImageRunArgs(
    plan,
    "sh",
    [
      "-c",
      [
        "set -eu",
        "cd /usr/local/bin",
        "test -x scotty-codex-session",
        "node --check scotty-codex-session",
        "test -x scotty-codex-server",
        "node --check scotty-codex-server",
        `node --input-type=module -e '${CODEX_BUNDLE_SMOKE.replaceAll("'", "'\\''")}'`,
        `node --input-type=module -e '${CODEX_SERVER_PROOF.replaceAll("'", "'\\''")}'`,
      ].join(" && "),
    ],
    ["--network=none"],
  );

export const containerImageInspectArgs = (plan) => [
  "image",
  "inspect",
  plan.image,
  "--format",
  "{{.Size}}",
];

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
};

const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}: ${result.stderr}`,
    );
  }
  return { stdout: result.stdout };
};

export const checkContainerImage = async ({
  root = process.cwd(),
  environment = process.env,
  prepare = prepareContainerContext,
  docker = run,
  inspect = inspectContainerImageBudget,
} = {}) => {
  const plan = containerImagePlan(root, environment);
  await prepare(root);
  docker("docker", containerImageBuildArgs(plan));
  docker("docker", containerImagePiVersionArgs(plan));
  docker("docker", containerImagePiPackagesSmokeArgs(plan));
  docker("docker", containerImageCodexVersionArgs(plan));
  docker("docker", containerImageCodexPackagingArgs(plan));
  await inspect(plan.image, {
    exec: async (_command, args) => capture("docker", args),
    inspectArgs: containerImageInspectArgs(plan),
  });
  return plan;
};

// Serialized into the network-isolated image smoke and reused against the prepared bundle.
export const codexFixtureLaunch = (binary, runtimeDir, workspace) => ({
  binary,
  runtimeDir,
  workspace,
  model: "gpt-5.2",
  effort: "high",
  credential: {
    sentinel: [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "scotty-managed",
            chatgpt_plan_type: "managed",
            scotty_managed_handle: "scotty-managed://openai/openai-codex/access",
          },
        }),
      ).toString("base64url"),
      "scotty-managed",
    ].join("."),
    expiresAt: Date.now() + 120_000,
  },
});

export const CODEX_FAKE_CHILD = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./fixture-child.pid', import.meta.url), String(process.pid));
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if(m.method==='initialize') send({id:m.id,result:{userAgent:'scotty-component/0.153.4 fixture',codexHome:process.env.CODEX_HOME,platformFamily:'unix',platformOs:process.platform==='darwin'?'macos':'linux'}});
  if(m.method==='thread/start') {
    if(m.params.approvalPolicy!=='never' || m.params.sandbox!=='danger-full-access') process.exit(2);
    send({id:m.id,result:{thread:{id:'prepared'},model:'gpt-5.2',modelProvider:'scotty-managed',cwd:process.cwd(),approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'},reasoningEffort:'high'}});
  }
  if(m.method==='turn/start') {
    send({id:m.id,result:{turn:{id:'turn-prepared',status:'inProgress',items:[]}}});
    send({method:'turn/started',params:{threadId:'prepared',turn:{id:'turn-prepared',status:'inProgress',items:[]}}});
    setTimeout(() => send({method:'turn/completed',params:{threadId:'prepared',turn:{id:'turn-prepared',status:'completed',items:[{type:'agentMessage',id:'answer',text:'PREPARED_SERVER_OK'}]}}}), 150);
  }
});
`;

const proveInstalledServer = async (makeLaunch, fakeSource) => {
  const { strict: assert } = await import("node:assert");
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { createServer } = await import("node:net");
  const root = await fs.mkdtemp(join(tmpdir(), "scotty-installed-server-"));
  let child;
  let exited;
  let nativePid;
  let sentinel;
  let output = "";
  const token = "a".repeat(64);
  try {
    const workspace = join(root, "workspace");
    await fs.mkdir(workspace);
    const privateDir = join(root, "private");
    await fs.mkdir(privateDir, { mode: 0o700 });
    const tokenFile = join(privateDir, "control.token");
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    const binary = join(root, "fake-codex.mjs");
    await fs.writeFile(binary, `#!${process.execPath}\n${fakeSource}`, { mode: 0o755 });
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolveClose, reject) =>
      reservation.close((error) => (error ? reject(error) : resolveClose())),
    );
    const launch = makeLaunch(binary, join(root, "runtime"), workspace);
    sentinel = launch.credential.sentinel;
    child = spawn(
      resolve("scotty-codex-server"),
      [
        JSON.stringify({
          generation: "prepared-generation",
          port,
          tokenFile,
          launch,
        }),
      ],
      { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
    );
    exited = once(child, "exit");
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      output += bytes;
    });
    const headers = {
      "x-scotty-codex-token": token,
      "x-scotty-codex-generation": "prepared-generation",
    };
    const request = (path, options = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers,
        signal: AbortSignal.timeout(2000),
        ...options,
      });
    const wait = async (action) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, "server exited early");
        const result = await action();
        if (result) return result;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      assert.fail("installed server deadline");
    };
    const health = await wait(async () => {
      try {
        const response = await request("/health");
        return response.status === 200 ? response.json() : false;
      } catch {
        return false;
      }
    });
    assert.equal(health.ready, true);
    nativePid = Number(await fs.readFile(join(root, "fixture-child.pid"), "utf8"));
    assert.ok(Number.isSafeInteger(nativePid) && nativePid > 0);
    assert.equal(health.settings.modelProvider, "scotty-managed");
    assert.equal(health.settings.model, "gpt-5.2");
    assert.equal(health.settings.effort, "high");
    assert.equal(health.settings.approvalPolicy, "never");
    assert.equal(health.settings.sandbox, "dangerFullAccess");
    assert.equal(health.prompt.status, "idle");
    await assert.rejects(fs.stat(tokenFile), { code: "ENOENT" });
    assert.equal(
      (
        await request("/health", {
          headers: { ...headers, "x-scotty-codex-token": "b".repeat(64) },
        })
      ).status,
      401,
    );
    assert.equal(
      (await request("/health", { headers: { ...headers, "x-scotty-codex-generation": "stale" } }))
        .status,
      409,
    );
    const prompt = () =>
      request("/prompt", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ threadId: "prepared", text: "synthetic fixture only" }),
      });
    const accepted = await prompt();
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).turnId, "turn-prepared");
    const terminal = await wait(async () => {
      const snapshot = await (await request("/snapshot")).json();
      return snapshot.prompt.status === "terminal" ? snapshot : false;
    });
    assert.equal(terminal.prompt.text, "PREPARED_SERVER_OK");
    assert.equal(terminal.prompt.outcome, "completed");
    assert.equal(terminal.prompt.turnId, "turn-prepared");
    assert.equal(terminal.threadId, "prepared");
    assert.equal(terminal.generation, "prepared-generation");
    assert.equal((await prompt()).status, 409);
    const stopped = await (await request("/stop", { method: "POST" })).json();
    assert.equal(stopped.cleanup, "ambiguous");
    assert.equal(stopped.descendants, "unverified");
    assert.equal(stopped.parent, "exited");
    assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
    assert.equal((await request("/health")).status, 503);
    assert.equal((await request("/snapshot")).status, 200);
    assert.equal(child.exitCode, null);
    await fs.stat(launch.runtimeDir);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (exited) await exited;
    if (child?.pid) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    if (nativePid) assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
    await fs.rm(root, { recursive: true, force: true });
    await assert.rejects(fs.stat(root), { code: "ENOENT" });
    assert.equal(output.includes(token), false);
    if (sentinel) assert.equal(output.includes(sentinel), false);
    assert.equal(output.includes("scotty-managed://"), false);
  }
};

export const CODEX_SERVER_PROOF = `await (${proveInstalledServer.toString()})(${codexFixtureLaunch.toString()}, ${JSON.stringify(CODEX_FAKE_CHILD)});`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await checkContainerImage();
}
