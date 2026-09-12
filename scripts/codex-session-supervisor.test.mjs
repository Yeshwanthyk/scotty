import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const native = process.env.SCOTTY_TEST_CODEX_BINARY;
if (process.env.SCOTTY_REQUIRE_CODEX_NATIVE === "1") {
  assert.ok(native, "SCOTTY_TEST_CODEX_BINARY is required for the native workflow gate");
  const packageRoot = resolve(await realpath(native), "../..");
  assert.deepEqual(JSON.parse(await readFile(join(packageRoot, "codex-package.json"), "utf8")), {
    layoutVersion: 1,
    version: "0.153.4",
    target: "x86_64-unknown-linux-musl",
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  });
  for (const executable of [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/bwrap",
    "codex-resources/zsh/bin/zsh",
  ])
    await access(join(packageRoot, executable), constants.X_OK);
  assert.equal(
    execFileSync(native, ["--version"], { encoding: "utf8" }).trim(),
    "codex-cli 0.153.4",
  );
}

const stage = await realpath(await mkdtemp(join(tmpdir(), "scotty-codex-host-")));
execFileSync(
  "bun",
  [
    "build",
    "worker/src/agent/codex/main.ts",
    "--target=node",
    "--format=esm",
    `--outfile=${stage}/scotty-codex-host.mjs`,
  ],
  { cwd: resolve(import.meta.dirname, ".."), stdio: "pipe" },
);
await copyFile(
  resolve(import.meta.dirname, "../worker/container/scotty-codex-session.mjs"),
  join(stage, "scotty-codex-session"),
);
execFileSync(
  "bun",
  [
    "build",
    "worker/test/agent/codex/native-harness.ts",
    "--target=node",
    "--format=esm",
    `--outfile=${stage}/native-harness.mjs`,
  ],
  { cwd: resolve(import.meta.dirname, ".."), stdio: "pipe" },
);
const {
  Effect,
  Exit,
  Result,
  Scope,
  NodeServices,
  CodexSyntheticUpstream,
  managedPiAccessToken,
  observeCodexFailure,
  observeCleanup,
  makeCodexRuntime,
  makeSession,
  launchProcess,
  readCodexSavedState,
  startCodexRuntime,
  startCodexSession: acquireSession,
} = await import(pathToFileURL(join(stage, "native-harness.mjs")).href);
const credential = {
  sentinel: managedPiAccessToken("scotty-managed://openai/openai-codex/access"),
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const selection = (options) => {
  const { upstreamPort: _upstreamPort, ...launch } = options;
  return launch;
};
const args = (options) => [JSON.stringify(selection(options)), String(options.upstreamPort)];
const passiveFirstPartyTools = {
  restore: async () => {},
  shutdown: async () => {},
  execute: async () => {
    throw new Error("unexpected_first_party_tool_call");
  },
};
await copyFile(join(stage, "scotty-codex-session"), join(stage, "production-entry"));
await writeFile(
  join(stage, "scotty-codex-session"),
  `
import { program } from './scotty-codex-host.mjs';
import { Effect, NodeRuntime, NodeServices, CodexSyntheticUpstream } from './native-harness.mjs';
NodeRuntime.runMain(program(process.argv.slice(2,3)).pipe(Effect.provideService(CodexSyntheticUpstream, {port:Number(process.argv[3])}), Effect.scoped, Effect.provide(NodeServices.layer)), {disableErrorReporting:true});
`,
);
// Test-only Promise facade; production owns no Promise supervisor or hidden runtime.
async function startCodexSession(options, firstPartyTools) {
  await mkdir(options.workspace, { recursive: true });
  const scope = await Effect.runPromise(Scope.make());
  const run = (effect) => Effect.runPromise(effect);
  const runTyped = async (effect) => {
    const result = await run(Effect.result(effect));
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  };
  let host;
  try {
    host = await runTyped(
      (firstPartyTools === undefined
        ? acquireSession(selection(options), undefined, undefined, passiveFirstPartyTools)
        : Effect.gen(function* () {
            const transport = yield* launchProcess(selection(options));
            return yield* makeSession(transport, undefined, firstPartyTools);
          })
      ).pipe(
        Effect.provideService(CodexSyntheticUpstream, { port: options.upstreamPort }),
        Scope.provide(scope),
        Effect.provide(NodeServices.layer),
      ),
    );
  } catch (error) {
    await run(Scope.close(scope, Exit.void));
    throw error;
  }
  let stopping;
  const closed = runTyped(host.closed);
  return {
    inspect: host.inspect,
    dispose: () => run(Scope.close(scope, Exit.void)),
    drainEvents: host.drainEvents,
    closed,
    prompt: async (text) => {
      const accepted = await runTyped(host.prompt(text));
      const completed = runTyped(accepted.completed);
      void completed.catch(() => {});
      return { turnId: accepted.turnId, completed };
    },
    interrupt: () => runTyped(host.interrupt),
    stop: () =>
      (stopping ??= runTyped(host.stop).finally(() => run(Scope.close(scope, Exit.void)))),
  };
}
after(() => rm(stage, { recursive: true, force: true }));
let sequence = 0;
const wait = async (predicate) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error("fixture_wait_timeout");
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const killOwned = (pid) => {
  if (alive(pid)) process.kill(pid, "SIGKILL");
};

async function fixture(t, mode = "normal", overrides = {}, observe) {
  const index = ++sequence;
  const binary = join(stage, `fake-${index}.mjs`);
  const log = join(stage, `log-${index}.jsonl`);
  const descendantFile = join(stage, `descendant-${index}`);
  await writeFile(
    binary,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mode = ${JSON.stringify(mode)};
const log = ${JSON.stringify(log)};
const output = value => process.stdout.write(JSON.stringify(value)+'\\n');
const config = readFileSync(process.env.CODEX_HOME+'/config.toml', 'utf8');
const effort = /model_reasoning_effort = "(.*?)"/.exec(config)[1];
appendFileSync(log, JSON.stringify({pid:process.pid,env:process.env,cwd:process.cwd(),args:process.argv.slice(2),config})+'\\n');
let turn = 0, descendant;
if (mode === 'descendant' || mode === 'forced-descendant') {
 descendant = spawn('/bin/sleep', ['60'], {detached:true,stdio:'ignore',env:{}});
 writeFileSync(${JSON.stringify(descendantFile)}, String(descendant.pid));
 descendant.unref();
}
const terminal = (status='completed') => output({method:'turn/completed',emittedAtMs:1,params:{threadId:'thread',turn:{id:'turn-'+turn,status,items:status==='completed'?[{id:'answer',type:'agentMessage',text:'héllo'}]:[],error:null}}});
if(mode==='delayed-readiness') await new Promise(resolve=>setTimeout(resolve,1200));
const input = createInterface({input:process.stdin});
input.on('close',()=>{
 if(mode==='forced-descendant') {setInterval(()=>{},1000); return;}
 if(descendant) descendant.kill('SIGKILL');
});
if(mode==='forced-descendant') process.on('SIGTERM',()=>{});
input.on('line', line=>{
 const m=JSON.parse(line); appendFileSync(log, line+'\\n');
 if(m.method==='initialize') {
  if(mode==='timeout') return;
  if(mode==='exit') process.exit(7);
  if(mode==='malformed') {process.stdout.write('{bad}\\n');return;}
  if(mode==='utf8') {process.stdout.write(Buffer.from([0xff,10]));return;}
  if(mode==='truncated') {process.stdout.end('{');return;}
  if(mode==='oversized') {process.stdout.write('x'.repeat(262145));return;}
  if(mode==='stderr') {process.stderr.write('x'.repeat(262145));return;}
  if(mode==='unknown') {output({method:'unknown',params:{}});return;}
  if(mode==='config-warning' || mode==='config-warning-settings') output({method:'configWarning',params:{summary:'Codex will use the bundled bubblewrap in the meantime.',details:null},emittedAtMs:1});
  if(mode==='bad-advisory') {output({method:'thread/status/changed',params:{},emittedAtMs:null});return;}
  if(mode==='events') {for(let i=0;i<4097;i++)output({method:'thread/status/changed',params:{}});return;}
  if(mode==='aggregate') {for(let i=0;i<40;i++)output({method:'thread/status/changed',params:{x:'x'.repeat(250000)}});return;}
  output({id:mode==='wrong-id'?String(m.id):m.id,result:{userAgent:'scotty-component/0.153.4 test',codexHome:mode==='home'?'/wrong':process.env.CODEX_HOME,platformFamily:'unix',platformOs:${JSON.stringify(process.platform === "darwin" ? "macos" : "linux")}}});
 } else if(m.method==='thread/start') {
  if(mode==='rpc-error') {output({id:m.id,error:{code:-1,message:'do not expose me'}});return;}
  if(m.params.approvalPolicy!=='never' || m.params.sandbox!=='danger-full-access') process.exit(2);
  const sandbox = mode==='sandbox-readonly'?{type:'readOnly',networkAccess:false}:mode==='sandbox-external'?{type:'externalSandbox',networkAccess:'enabled'}:mode==='sandbox-unknown'?{type:'unknown'}:{type:'dangerFullAccess'};
  output({id:m.id,result:{thread:{id:'thread'},model:m.params.model,modelProvider:'scotty-managed',cwd:process.cwd(),approvalPolicy:mode==='approval-policy'?'on-request':'never',approvalsReviewer:'user',sandbox,reasoningEffort:mode==='settings' || mode==='config-warning-settings'?'medium':effort}});
  output({method:'thread/started',params:{thread:{id:'thread'}},emittedAtMs:1});
  if(mode==='clean-stdout-eof')setTimeout(()=>process.stdout.end(),100);
 } else if(m.method==='turn/start') {
  if(mode!=='reuse' || !turn)turn++;
  if(mode==='wrong-method') {output({id:m.id,result:{}});return;}
  output({id:m.id,result:{turn:{id:'turn-'+turn,status:'inProgress',items:[],error:null}}});
  if(mode==='duplicate-response')output({id:m.id,result:{turn:{id:'turn-'+turn,status:'inProgress',items:[],error:null}}});
  if(mode==='bad-notification') {output({method:'turn/started',params:{}});return;}
  output({method:'turn/started',params:{threadId:mode==='stale'?'old':'thread',turn:{id:'turn-'+turn,status:'inProgress',items:[]}},emittedAtMs:1});
  if(mode==='backpressure') {
   for(let i=0;i<32;i++)output({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn-'+turn,itemId:'answer',delta:'x'.repeat(65536)}});
   return;
  }
  if(mode==='hold' || mode==='ack-only' || mode==='descendant' || mode==='forced-descendant')return;
  if(mode==='requests') {
   for(const [id,method] of [[0,'item/commandExecution/requestApproval'],['approval-file','item/fileChange/requestApproval'],['unknown','future/unknown']]) output({id,method,params:{secret:'discard'},trace:{secret:'discard'}});
   return;
  }
  if(mode==='bad-request') {output({id:null,method:'approval'});return;}
  if(mode==='failed') {output({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn-'+turn,status:'failed',items:[],error:{message:'untrusted failure'}}}});return;}
  const delta=Buffer.from(JSON.stringify({method:'item/agentMessage/delta',emittedAtMs:1,params:{threadId:'thread',turnId:'turn-'+turn,itemId:'answer',delta:'héllo'}})+'\\n');
  const split=delta.indexOf(Buffer.from('é'))+1; process.stdout.write(delta.subarray(0,split));setTimeout(()=>{process.stdout.write(delta.subarray(split));terminal();},5);
 } else if(m.method==='turn/interrupt') {
  output({id:m.id,result:{}});
  if(mode!=='ack-only')setTimeout(()=>terminal('interrupted'),100);
 } else if(m.error && m.id==='unknown') terminal();
});
`,
  );
  await chmod(binary, 0o755);
  const options = {
    binary,
    runtimeDir: join(stage, `runtime-${index}`),
    workspace: join(stage, `workspace-${index}`),
    model: "gpt-5.2",
    credential,
    upstreamPort: 9,
    effort: "high",
    requestTimeoutMs: 1000,
    turnTimeoutMs: 2000,
    stopTimeoutMs: 100,
    ...overrides,
  };
  await mkdir(options.workspace, { recursive: true });
  let host;
  t.after(async () => {
    if (host) {
      try {
        const receipt = await host.stop();
        observe?.({
          phase: "cleanup",
          receipt: observeCleanup(receipt),
          pid: host.inspect().pid,
          parentAlive: alive(host.inspect().pid),
        });
      } catch (error) {
        observe?.({ phase: "cleanup", failure: observeCodexFailure(error) });
        throw error;
      }
    }
    const pid = await readFile(descendantFile, "utf8").then(Number, () => undefined);
    if (pid) {
      killOwned(pid);
      await wait(() => !alive(pid));
    }
  });
  return {
    options,
    log,
    descendantFile,
    launch: async () => {
      host = await startCodexSession(options);
      return host;
    },
    rows: async () => (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse),
  };
}

test("invalid startup budgets fail admission before any fixture process work", async (t) => {
  for (const startupTimeoutMs of [9, 15001, "15000", null]) {
    const f = await fixture(t, "normal", { startupTimeoutMs });
    await assert.rejects(f.launch(), { code: "invalid_launch_selection" });
    await assert.rejects(readFile(f.log), { code: "ENOENT" });
  }
});

test("native delayed readiness exceeds request timing without changing post-ready RPCs", async (t) => {
  const f = await fixture(t, "delayed-readiness");
  const host = await f.launch();
  assert.equal(host.inspect().ready, true);
  assert.equal(f.options.requestTimeoutMs, 1000);
  const turn = await host.prompt("test");
  assert.equal((await turn.completed).status, "completed");
  assert.deepEqual(
    (await f.rows()).filter((row) => row.method).map((row) => row.method),
    ["initialize", "initialized", "thread/start", "turn/start"],
  );
  assert.equal((await host.stop()).parent, "exited");
});

test("passes explicit Session identity without inheriting the parent environment", async (t) => {
  const f = await fixture(t, "normal", { sessionId: "a0b1c2d3e4f5" });
  const host = await f.launch();
  const rows = await f.rows();
  assert.equal(rows[0].env.SCOTTY_SESSION_ID, "a0b1c2d3e4f5");
  assert.equal(rows[0].env.PATH, "/usr/local/bin:/usr/bin:/bin");
  assert.equal((await host.stop()).parent, "exited");
});

test("staged native bundle: readiness, isolation, Unicode, follow-up and repeated graceful stop", async (t) => {
  const f = await fixture(t);
  const host = await f.launch();
  assert.equal(host.inspect().ready, true);
  assert.equal(host.inspect().settings.approvalPolicy, "never");
  assert.deepEqual(host.inspect().settings.sandbox, { type: "dangerFullAccess" });
  const rows = await f.rows();
  assert.deepEqual(rows[0].args, ["app-server", "--listen", "stdio://"]);
  assert.deepEqual(
    // macOS injects this nonsecret locale variable at native process startup.
    Object.keys(rows[0].env)
      .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
      .sort(),
    [
      "HOME",
      "CODEX_HOME",
      "TMPDIR",
      "PATH",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "SCOTTY_CODEX_SENTINEL",
    ].sort(),
  );
  assert.equal(rows[0].env.PATH, "/usr/local/bin:/usr/bin:/bin");
  assert.match(rows[0].config, /model_reasoning_effort = "high"/u);
  assert.equal(
    rows.some((r) => r.method === "turn/start"),
    false,
  );
  for (let i = 1; i <= 2; i++) {
    const accepted = await host.prompt("hello");
    assert.equal(accepted.turnId, `turn-${i}`);
    assert.equal((await accepted.completed).status, "completed");
  }
  assert.equal(
    host.drainEvents().filter((e) => e.method === "item/agentMessage/delta")[0].params.delta,
    "héllo",
  );
  assert.deepEqual(host.drainEvents(), []);
  const stop = host.stop();
  assert.equal(host.stop(), stop);
  assert.deepEqual(await stop, {
    cleanup: "ambiguous",
    descendants: "unverified",
    parent: "exited",
    shutdown: "eof",
    exit: { code: 0, signal: null },
    failure: null,
  });
  await assert.rejects(host.prompt("late"), { code: "not_ready" });
});

test("unsupported selection and existing homes are rejected without spawning", async (t) => {
  const observe = (value) => t.diagnostic(JSON.stringify(value));
  const observed = async (phase, work) => {
    try {
      const value = await work();
      observe({ phase, outcome: "success" });
      return value;
    } catch (error) {
      observe({ phase, failure: observeCodexFailure(error) });
      throw error;
    }
  };
  const f = await fixture(t, "normal", {}, observe);
  await assert.rejects(
    observed("unsupported-selection", () =>
      startCodexSession({ ...f.options, effort: 'arbitrary"\n' }),
    ),
    {
      code: "invalid_launch_selection",
    },
  );
  await assert.rejects(readFile(f.log), { code: "ENOENT" });
  await observed("valid-launch", async () => {
    try {
      return await f.launch();
    } catch (error) {
      // Read only fixture-owned progress; never print its argv, env, config or messages.
      try {
        const rows = await f.rows();
        observe({
          phase: "failed-launch-progress",
          pid: rows[0].pid,
          parentAlive: alive(rows[0].pid),
          initialize: rows.some((row) => row.method === "initialize"),
          initialized: rows.some((row) => row.method === "initialized"),
          threadStart: rows.some((row) => row.method === "thread/start"),
        });
      } catch (progressError) {
        observe({
          phase: "failed-launch-progress",
          log:
            progressError instanceof Error &&
            "code" in progressError &&
            progressError.code === "ENOENT"
              ? "absent"
              : "unreadable",
        });
      }
      throw error;
    }
  });
  await assert.rejects(
    observed("existing-home", () => startCodexSession(f.options)),
    { code: "isolation_setup_failed" },
  );
  assert.equal((await f.rows()).filter((row) => row.method === "initialize").length, 1);
});

for (const [mode, code] of [
  ["malformed", "invalid_message"],
  ["utf8", "invalid_utf8"],
  ["truncated", "truncated_record"],
  ["oversized", "message_too_large"],
  ["stderr", "stderr_budget"],
  ["wrong-id", "unexpected_response_id"],
  ["timeout", "startup_timeout"],
  ["exit", "unexpected_exit"],
  ["home", "runtime_mismatch"],
  ["settings", "settings_mismatch"],
  ["sandbox-readonly", "invalid_message"],
  ["sandbox-external", "invalid_message"],
  ["sandbox-unknown", "invalid_message"],
  ["approval-policy", "invalid_message"],
  ["config-warning-settings", "settings_mismatch"],
  ["rpc-error", "rpc_rejected"],
  ["unknown", "unsupported_notification"],
  ["bad-advisory", "unsupported_notification"],
  ["events", "event_budget"],
  ["aggregate", "output_budget"],
])
  test(`startup fault: ${mode}`, async (t) => {
    const f = await fixture(t, mode, { startupTimeoutMs: 1500, requestTimeoutMs: 1500 });
    await assert.rejects(f.launch(), (error) => {
      assert.ok(
        (mode === "exit" ? ["unexpected_exit", "transport_failed"] : [code]).includes(error.code),
      );
      assert.equal(error.cleanup.cleanup, "ambiguous");
      assert.equal(error.cleanup.descendants, "unverified");
      return true;
    });
    assert.equal(
      (await f.rows()).some((r) => r.method === "turn/start"),
      false,
    );
  });

for (const [mode, code] of [
  ["bad-notification", "invalid_message"],
  ["stale", "stale_notification"],
  ["bad-request", "invalid_message"],
])
  test(`active turn fault: ${mode}`, async (t) => {
    const f = await fixture(t, mode);
    const host = await f.launch();
    const turn = await host.prompt("test");
    await assert.rejects(turn.completed, { code });
    assert.equal((await host.stop()).failure, code);
  });

test("unsupported server request is rejected with its exact ID, no params reflection", async (t) => {
  const f = await fixture(t, "requests");
  const host = await f.launch();
  const turn = await host.prompt("test");
  assert.equal((await turn.completed).status, "completed");
  assert.deepEqual(
    (await f.rows()).filter((r) => r.error),
    [0, "approval-file", "unknown"].map((id) => ({
      id,
      error: { code: -32601, message: "Unsupported server request" },
    })),
  );
  assert.equal(host.inspect().rejected, 3);
});

test("failed terminal stays failed", async (t) => {
  const host = await (await fixture(t, "failed")).launch();
  assert.equal((await (await host.prompt("test")).completed).status, "failed");
});

test("interrupt ack is not terminal; concurrent prompts rejected; invalid prompt never written", async (t) => {
  const f = await fixture(t, "hold");
  const host = await f.launch();
  await assert.rejects(host.prompt("x".repeat(65537)), { code: "invalid_message" });
  const turn = await host.prompt("hold");
  await assert.rejects(host.prompt("busy"), { code: "turn_busy" });
  let settled = false;
  const interrupted = host.interrupt().then((value) => {
    settled = true;
    return value;
  });
  await delay(30);
  assert.equal(settled, false);
  assert.equal((await interrupted).status, "interrupted");
  assert.equal((await turn.completed).status, "interrupted");
  assert.equal((await f.rows()).filter((r) => r.method === "turn/start").length, 1);
});

test("ack without terminal hits deadline and cannot report interruption", async (t) => {
  const host = await (await fixture(t, "ack-only", { turnTimeoutMs: 200 })).launch();
  const turn = await host.prompt("hold");
  await assert.rejects(host.interrupt(), { code: "turn_timeout" });
  await assert.rejects(turn.completed, { code: "turn_timeout" });
  assert.equal((await host.stop()).cleanup, "ambiguous");
});

for (const forced of [false, true])
  test(`owned detached fixture: ${forced ? "forced parent death is ambiguous" : "EOF removes known descendant but cannot prove containment"}`, async (t) => {
    const f = await fixture(t, forced ? "forced-descendant" : "descendant");
    const host = await f.launch();
    const pid = Number(await readFile(f.descendantFile, "utf8"));
    assert.equal(alive(pid), true);
    const receipt = await host.stop();
    assert.equal(receipt.shutdown, forced ? "forced" : "eof");
    assert.equal(receipt.parent, "exited");
    assert.equal(receipt.cleanup, "ambiguous");
    assert.equal(receipt.descendants, "unverified");
    if (forced) assert.equal(alive(pid), true);
    else await wait(() => !alive(pid));
  });

test("unexpected parent SIGKILL leaves exact owned descendant alive and active turn ambiguous", async (t) => {
  const f = await fixture(t, "descendant");
  const host = await f.launch();
  const pid = Number(await readFile(f.descendantFile, "utf8"));
  const turn = await host.prompt("hold");
  process.kill(host.inspect().pid, "SIGKILL");
  await assert.rejects(turn.completed, (error) =>
    ["unexpected_exit", "transport_failed"].includes(error.code),
  );
  const receipt = await host.stop();
  assert.ok(["unexpected", "eof"].includes(receipt.shutdown));
  assert.equal(receipt.descendants, "unverified");
  assert.equal(alive(pid), true);
});

for (const [model, effort] of [
  ["gpt-5.4", "high"],
  ["gpt-5.4", "low"],
  ["gpt-5.4", "xhigh"],
  ...["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ["gpt-6-astra", effort]),
])
  test(
    `real pinned binary / synthetic upstream: ${model} ${effort}`,
    { skip: !native, timeout: 60000 },
    async (t) => {
      const requests = [];
      let hold = false,
        held;
      const server = createServer(async (req, res) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        }
        assert.equal(req.url, "/backend-api/codex/responses");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({
          model: body.model,
          effort: body.reasoning.effort,
          auth: req.headers.authorization,
        });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type, fields) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send("response.created", { response: { id: "resp-component", status: "in_progress" } });
        if (hold) {
          held = res;
          return;
        }
        const item = {
          id: "msg-component",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "SYNTHETIC_OK", annotations: [] }],
        };
        send("response.output_item.added", {
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        send("response.content_part.added", {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        send("response.output_text.delta", {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: "SYNTHETIC_OK",
        });
        send("response.output_text.done", {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: "SYNTHETIC_OK",
        });
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", {
          response: {
            id: "resp-component",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        res.end();
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      let host;
      t.after(async () => {
        if (host) await host.stop();
        held?.destroy();
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      });
      host = await startCodexSession({
        binary: native,
        runtimeDir: join(stage, `native-${model}-${effort}`),
        workspace: join(stage, `native-workspace-${model}-${effort}`),
        model,
        credential,
        upstreamPort: server.address().port,
        effort,
      });
      assert.equal(requests.length, 0);
      assert.equal(host.inspect().settings.approvalPolicy, "never");
      assert.deepEqual(host.inspect().settings.sandbox, { type: "dangerFullAccess" });
      assert.equal(host.inspect().settings.reasoningEffort, effort);
      for (let i = 0; i < 2; i++) {
        const turn = await host.prompt("Return the synthetic answer.");
        const terminal = await turn.completed;
        assert.equal(terminal.status, "completed");
        assert.equal(terminal.items[0].text, "SYNTHETIC_OK");
      }
      assert.equal(host.inspect().rejected, 0);
      assert.ok(host.drainEvents().some((e) => e.method === "item/agentMessage/delta"));
      hold = true;
      const turn = await host.prompt("Wait for interruption.");
      await wait(() => held);
      assert.equal((await host.interrupt()).status, "interrupted");
      assert.equal((await turn.completed).status, "interrupted");
      assert.deepEqual(
        requests,
        Array.from({ length: 3 }, () => ({
          model,
          // Pinned client.rs maps astra ultra to its catalog multi-agent effort.
          effort: model === "gpt-6-astra" && effort === "ultra" ? "xhigh" : effort,
          auth: `Bearer ${credential.sentinel}`,
        })),
      );
      const receipt = await host.stop();
      assert.equal(receipt.shutdown, "eof");
      assert.equal(receipt.parent, "exited");
      assert.deepEqual(receipt.exit, { code: 0, signal: null });
      assert.equal(receipt.descendants, "unverified");
    },
  );

test(
  "pinned native failed turn saves and resumes with a distinct follow-up and first-party tool",
  { skip: !native, timeout: 60000 },
  async (t) => {
    let requests = 0;
    let held;
    const requestBodies = [];
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) {
        if (Buffer.byteLength(text) + chunk.length > 1024 * 1024) {
          req.destroy();
          return;
        }
        text += chunk.toString("utf8");
      }
      assert.equal(req.url, "/backend-api/codex/responses");
      requestBodies.push(JSON.parse(text));
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, fields) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      send("response.created", {
        response: { id: `resp-recovery-${requests}`, status: "in_progress" },
      });
      if (requests === 1) {
        held = res;
        return;
      }
      const item =
        requests === 2
          ? {
              id: "hatch-resumed-item",
              type: "function_call",
              call_id: "hatch-resumed-call",
              name: "scotty_hatch",
              arguments: JSON.stringify({ operation: "status" }),
            }
          : {
              id: "msg-recovery",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "RECOVERED_OK", annotations: [] }],
            };
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          id: `resp-recovery-${requests}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const scopes = [];
    t.after(async () => {
      for (const scope of scopes.reverse()) await Effect.runPromise(Scope.close(scope, Exit.void));
      held?.destroy();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const upstream = { port: server.address().port };
    const scoped = (scope, effect) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(CodexSyntheticUpstream, upstream),
          Scope.provide(scope),
          Effect.provide(NodeServices.layer),
        ),
      );
    const workspace = join(stage, "native-recovery-workspace");
    await mkdir(workspace);
    const launch = {
      binary: native,
      runtimeDir: join(stage, "native-recovery-first"),
      workspace,
      model: "gpt-5.4",
      effort: "high",
      ephemeral: false,
      credential,
      requestTimeoutMs: 2000,
    };
    const firstScope = await Effect.runPromise(Scope.make());
    scopes.push(firstScope);
    const host = await scoped(
      firstScope,
      acquireSession(launch, undefined, undefined, passiveFirstPartyTools),
    );
    const first = await scoped(firstScope, makeCodexRuntime(host, "generation-first"));
    const admitted = await scoped(
      firstScope,
      first.admit({
        threadId: host.inspect().threadId,
        text: "Wait for the synthetic response.",
        clientUserMessageId: "failed-message",
      }),
    );
    await wait(() => held);
    process.kill(host.inspect().pid, "SIGKILL");
    await wait(async () => (await scoped(firstScope, first.snapshot)).prompt.status === "failed");
    assert.equal((await scoped(firstScope, first.snapshot)).ready, false);
    const saved = await scoped(firstScope, first.save);
    assert.equal(saved.threadId, admitted.threadId);
    assert.equal(saved.initialTurnId, admitted.turnId);
    const state = await scoped(firstScope, readCodexSavedState(workspace, saved));
    assert.deepEqual(state.history.prompt, { status: "failed", turnId: admitted.turnId });
    assert.equal(state.history.turns[0].state, "failed");
    await Effect.runPromise(Scope.close(firstScope, Exit.void));
    held.destroy();

    const nextScope = await Effect.runPromise(Scope.make());
    scopes.push(nextScope);
    const resumedToolCalls = [];
    const resumedTools = {
      restore: async () => {},
      shutdown: async () => {},
      execute: async (tool, input) => {
        resumedToolCalls.push({ tool, input });
        return { text: "scotty-hatch:resumed-proof", success: true };
      },
    };
    const resumed = await scoped(
      nextScope,
      startCodexRuntime(
        {
          generation: "generation-next",
          launch: {
            ...launch,
            runtimeDir: join(stage, "native-recovery-next"),
            resumeThreadId: saved.threadId,
          },
          restore: saved,
        },
        resumedTools,
      ),
    );
    const ready = await scoped(nextScope, resumed.snapshot);
    assert.equal(ready.ready, true);
    assert.equal(ready.threadId, saved.threadId);
    assert.deepEqual(ready.prompt, state.history.prompt);
    const replay = await scoped(
      nextScope,
      resumed.message({
        threadId: saved.threadId,
        text: "Wait for the synthetic response.",
        clientUserMessageId: "failed-message",
        reconcileOnly: true,
      }),
    );
    assert.equal(replay.turnId, admitted.turnId);
    assert.equal(requests, 1);
    const followUp = await scoped(
      nextScope,
      resumed.message({
        threadId: saved.threadId,
        text: "Return RECOVERED_OK.",
        clientUserMessageId: "next-message",
      }),
    );
    assert.notEqual(followUp.turnId, admitted.turnId);
    await wait(
      async () => (await scoped(nextScope, resumed.snapshot)).prompt.status === "terminal",
    );
    const final = await scoped(nextScope, resumed.snapshot);
    assert.equal(final.prompt.outcome, "completed");
    for (const body of requestBodies.slice(0, 2))
      assert.equal(
        body.tools.filter((tool) => tool.type === "function" && tool.name === "scotty_hatch")
          .length,
        1,
      );
    assert.deepEqual(resumedToolCalls, [{ tool: "scotty_hatch", input: { operation: "status" } }]);
    assert.match(
      JSON.stringify(
        requestBodies[2].input.find(
          (item) => item.type === "function_call_output" && item.call_id === "hatch-resumed-call",
        ),
      ),
      /scotty-hatch:resumed-proof/u,
    );
    assert.equal(final.turns[0].state, "failed");
    assert.equal(final.turns[1].assistant, "RECOVERED_OK");
    assert.equal(requests, 3);
  },
);

test("live idle child clean stdout EOF revokes readiness and stops without a prompt", async (t) => {
  const host = await (await fixture(t, "clean-stdout-eof")).launch();
  const pid = host.inspect().pid;
  assert.equal(host.inspect().ready, true);
  assert.equal(alive(pid), true);
  const receipt = await Promise.race([
    host.closed,
    delay(3000).then(() => {
      throw new Error("stdout EOF did not close host");
    }),
  ]);
  assert.equal(receipt.failure, "transport_failed");
  assert.equal(host.inspect().ready, false);
  assert.equal(host.inspect().failure, "transport_failed");
  await assert.rejects(host.prompt("late"), { code: "not_ready" });
  assert.equal(await host.stop(), receipt);
  await wait(() => !alive(pid));
});

for (const boundary of ["executable", "effect-exit"])
  for (const outputMode of ["broken", "backpressured"])
    test(`native rejected command / ${boundary} with ${outputMode} parent output stops without EOF rescue`, async (t) => {
      const f = await fixture(t, outputMode === "broken" ? "normal" : "backpressure");
      const resultFile = `${f.log}.exit`;
      let entry = join(stage, "scotty-codex-session");
      if (boundary === "effect-exit") {
        entry = `${f.log}.mjs`;
        await writeFile(
          entry,
          `
import { writeFileSync } from 'node:fs';
import { program } from './scotty-codex-host.mjs';
import { Effect, Exit, Result, NodeServices, CodexSyntheticUpstream } from './native-harness.mjs';
const exit = await Effect.runPromise(Effect.exit(Effect.result(program(process.argv.slice(2,3)).pipe(Effect.provideService(CodexSyntheticUpstream, {port:Number(process.argv[3])}), Effect.scoped, Effect.provide(NodeServices.layer)))));
writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({defect: Exit.isFailure(exit), failure: Exit.isSuccess(exit) && Result.isFailure(exit.value) ? exit.value.failure.code : null}));
// Match runMain's nonzero teardown: an intentionally undrained stdout keeps Node alive.
process.exit(Exit.isFailure(exit) || Result.isFailure(exit.value) ? 1 : 0);
`,
        );
      }
      const child = spawn(process.execPath, [entry, ...args(f.options)], {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        exited = false,
        ownedPid;
      const exit = new Promise((done) =>
        child.once("exit", (code, signal) => {
          exited = true;
          done({ code, signal });
        }),
      );
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.resume();
      t.after(async () => {
        if (!exited) {
          child.kill("SIGKILL");
          await exit;
        }
        if (ownedPid) {
          killOwned(ownedPid);
          await wait(() => !alive(ownedPid));
        }
      });
      const ready = await wait(() =>
        output
          .split("\n")
          .slice(0, -1)
          .map(JSON.parse)
          .find((row) => row.type === "ready"),
      );
      ownedPid = ready.pid;
      assert.equal(alive(ownedPid), true);
      if (outputMode === "broken") child.stdout.destroy();
      else {
        child.stdout.pause();
        child.stdin.write('{"method":"prompt","text":"fill output"}\n');
        await wait(async () => (await f.rows()).some((row) => row.method === "turn/start"));
        await delay(100);
      }
      child.stdin.write('{"method":"prompt","text":""}\n');
      const result = await Promise.race([
        exit,
        delay(7000).then(() => {
          throw new Error("fatal command did not terminate main");
        }),
      ]);
      assert.deepEqual(result, { code: 1, signal: null });
      if (boundary === "effect-exit") {
        const exit = JSON.parse(await readFile(resultFile, "utf8"));
        assert.equal(exit.defect, false);
        assert.ok(
          (outputMode === "broken"
            ? ["invalid_message"]
            : ["turn_busy", "transport_failed"]
          ).includes(exit.failure),
        );
      }
      await wait(() => !alive(ownedPid));
    });

test("executable inherited-pipe interface stops on EOF", async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [join(stage, "scotty-codex-session"), ...args(f.options)], {
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let output = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((done) => child.once("exit", (code) => done(code)));
  await wait(() => output.includes('"type":"ready"'));
  child.stdin.write('{"method":"prompt","text":"hello"}\n');
  await wait(() => output.includes('"type":"terminal"'));
  child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(stderr, "");
  assert.deepEqual(
    output
      .trim()
      .split("\n")
      .map(JSON.parse)
      .map((r) => r.type)
      .filter((type) => type !== "event"),
    ["ready", "accepted", "terminal", "stopped"],
  );
});

for (const [forced, resistTerm] of [
  [false, false],
  [true, false],
  [true, true],
])
  test(
    `real native owned command / ${forced ? "parent SIGKILL" : "graceful EOF"}${resistTerm ? " / TERM-resistant" : ""}`,
    { skip: !native, timeout: 60000 },
    async (t) => {
      let host,
        ownedPid,
        held,
        calls = 0;
      const server = createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) {
          if (Buffer.byteLength(text) + chunk.length > 1024 * 1024) {
            req.destroy();
            return;
          }
          text += chunk.toString("utf8");
        }
        assert.equal(req.url, "/backend-api/codex/responses");
        assert.equal(req.headers.authorization, `Bearer ${credential.sentinel}`);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type, fields) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send("response.created", { response: { id: "resp-owned", status: "in_progress" } });
        if (++calls > 1) {
          // The exact PID comes from our own synthetic command's output, never a system process scan.
          const match = /SCOTTY_OWNED_PID=(\d+)/u.exec(text);
          if (match) ownedPid = Number(match[1]);
          held = res;
          return;
        }
        send("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc-owned",
            call_id: "call-owned",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: `${resistTerm ? "trap '' TERM; " : ""}echo SCOTTY_OWNED_PID=$$; exec /bin/sleep 60`,
              shell: "/bin/sh",
              login: false,
              yield_time_ms: 1000,
            }),
          },
        });
        send("response.completed", {
          response: {
            id: "resp-owned",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        res.end();
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      t.after(async () => {
        if (host) await host.stop();
        if (ownedPid) {
          killOwned(ownedPid);
          await wait(() => !alive(ownedPid));
        }
        held?.destroy();
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      });
      host = await startCodexSession({
        binary: native,
        runtimeDir: join(stage, `native-owned-${forced}-${resistTerm}`),
        workspace: join(stage, `native-owned-workspace-${forced}-${resistTerm}`),
        model: "gpt-5.2",
        credential,
        upstreamPort: server.address().port,
        effort: "high",
      });
      assert.equal(calls, 0);
      assert.equal(host.inspect().settings.approvalPolicy, "never");
      assert.deepEqual(host.inspect().settings.sandbox, { type: "dangerFullAccess" });
      const turn = await host.prompt("Run the bounded synthetic sleep command.");
      await wait(() => ownedPid && held);
      assert.equal(host.inspect().rejected, 0);
      assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 1);
      assert.equal(alive(ownedPid), true);
      assert.equal((await host.interrupt()).status, "interrupted");
      assert.equal((await turn.completed).status, "interrupted");
      assert.equal(alive(ownedPid), true);
      if (forced) {
        process.kill(-host.inspect().pid, "SIGKILL");
        await host.closed;
      }
      const receipt = await host.stop();
      assert.equal(receipt.parent, "exited");
      // Stdout EOF may beat the process-exit event; "eof" records our stop attempt, not its cause.
      assert.ok((forced ? ["unexpected", "eof"] : ["eof"]).includes(receipt.shutdown));
      assert.equal(receipt.cleanup, "ambiguous");
      assert.equal(receipt.descendants, "unverified");
      // Pinned utils/pty pipe spawn installs Linux PDEATHSIG(SIGTERM), not containment.
      if (forced && (process.platform !== "linux" || resistTerm))
        assert.equal(alive(ownedPid), true);
      else await wait(() => !alive(ownedPid));
    },
  );

test("spawn failure returns bounded local error and honest receipt", async () => {
  await assert.rejects(
    startCodexSession({
      binary: join(stage, "missing-binary"),
      runtimeDir: join(stage, "missing-runtime"),
      workspace: join(stage, "missing-workspace"),
      model: "gpt-5.2",
      credential,
      upstreamPort: 9,
      effort: "high",
    }),
    (error) => {
      assert.equal(error.code, "spawn_failed");
      assert.equal(error.cleanup.parent, "unverified");
      assert.equal(error.cleanup.descendants, "unverified");
      return true;
    },
  );
});

test("response decoder is selected by pending method", async (t) => {
  const host = await (await fixture(t, "wrong-method")).launch();
  await assert.rejects(host.prompt("hello"), { code: "invalid_message" });
  assert.equal((await host.closed).failure, "invalid_message");
});

test("duplicate response fails rather than settling twice", async (t) => {
  const host = await (await fixture(t, "duplicate-response")).launch();
  const turn = await host.prompt("hello");
  await assert.rejects(turn.completed, { code: "unexpected_response_id" });
});

test("follow-up cannot reuse a completed native turn identity", async (t) => {
  const host = await (await fixture(t, "reuse")).launch();
  await (
    await host.prompt("first")
  ).completed;
  await assert.rejects(host.prompt("second"), { code: "reused_turn_id" });
});

test("stop rejects an active terminal wait and closed resolves the same receipt", async (t) => {
  const host = await (await fixture(t, "hold")).launch();
  const turn = await host.prompt("hold");
  const stopped = host.stop();
  await assert.rejects(turn.completed, { code: "stopped" });
  assert.equal(await stopped, await host.closed);
});

test("lifetime outbound byte budget closes instead of buffering unbounded prompts", async (t) => {
  const host = await (await fixture(t)).launch();
  const text = "x".repeat(65536);
  for (let i = 0; i < 15; i++) await (await host.prompt(text)).completed;
  await assert.rejects(host.prompt(text), { code: "input_budget" });
  assert.equal((await host.closed).failure, "input_budget");
});

test("native scope disposal sends EOF before releasing the process service", async (t) => {
  const host = await (await fixture(t, "hold")).launch();
  const turn = await host.prompt("hold");
  await host.dispose();
  await assert.rejects(turn.completed, { code: "stopped" });
  const receipt = await host.closed;
  assert.equal(receipt.shutdown, "eof");
  assert.equal(receipt.parent, "exited");
  assert.equal(receipt.failure, null);
});

for (const signal of ["SIGTERM", "SIGINT"])
  test(`native runMain ${signal} interrupts the scope and preserves graceful cleanup`, async (t) => {
    const f = await fixture(t, "descendant");
    const child = spawn(
      process.execPath,
      [join(stage, "scotty-codex-session"), ...args(f.options)],
      { env: {}, stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => child.kill("SIGKILL"));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const exited = new Promise((done) => child.once("exit", done));
    await wait(() => output.includes('"type":"ready"'));
    child.stdin.write('{"method":"prompt","text":"hold"}\n');
    await wait(() => output.includes('"type":"accepted"'));
    const ownedPid = Number(await readFile(f.descendantFile, "utf8"));
    child.kill(signal);
    await exited;
    const receipt = output
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((record) => record.type === "stopped");
    assert.equal(receipt.shutdown, "eof");
    assert.equal(receipt.parent, "exited");
    assert.equal(receipt.descendants, "unverified");
    await wait(() => !alive(ownedPid));
  });

test("native Linux configWarning is advisory, never a substitute for settings readback", async (t) => {
  const f = await fixture(t, "config-warning");
  const host = await f.launch();
  assert.equal(host.inspect().ready, true);
  assert.equal(host.inspect().settings.reasoningEffort, "high");
  assert.ok(host.inspect().discarded >= 1);
  assert.equal((await (await host.prompt("hello")).completed).status, "completed");
});

test(
  "real native executable: YOLO readback precedes file write command and EOF cleanup",
  { skip: !native, timeout: 60000 },
  async (t) => {
    let child,
      held,
      calls = 0,
      commandOutput;
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) {
        if (Buffer.byteLength(text) + chunk.length > 1024 * 1024) {
          req.destroy();
          return;
        }
        text += chunk.toString("utf8");
      }
      assert.equal(req.url, "/backend-api/codex/responses");
      assert.equal(req.headers.authorization, `Bearer ${credential.sentinel}`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, fields) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      send("response.created", { response: { id: "resp-write", status: "in_progress" } });
      if (++calls > 1) {
        commandOutput = JSON.parse(text).input.filter(
          (item) => item.type === "function_call_output",
        );
        held = res;
        return;
      }
      send("response.output_item.done", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc-write",
          call_id: "call-write",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: 'case ":$PATH:" in *:/usr/local/bin:*) ;; *) exit 91;; esac; test "$SCOTTY_SESSION_ID" = a0b1c2d3e4f5 && printf SCOTTY_YOLO_WRITE_OK > yolo-proof.txt && /bin/cat yolo-proof.txt',
            shell: "/bin/sh",
            login: false,
            yield_time_ms: 1000,
          }),
        },
      });
      send("response.completed", {
        response: {
          id: "resp-write",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    let exited;
    t.after(async () => {
      if (child) {
        child.stdin.end();
        await exited;
      }
      held?.destroy();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    await mkdir(join(stage, "executable-workspace"));
    child = spawn(
      process.execPath,
      [
        join(stage, "scotty-codex-session"),
        ...args({
          binary: native,
          runtimeDir: join(stage, "native-executable-write"),
          sessionId: "a0b1c2d3e4f5",
          workspace: join(stage, "executable-workspace"),
          model: "gpt-5.2",
          effort: "high",
          credential,
          upstreamPort: server.address().port,
        }),
      ],
      { env: {}, stdio: ["pipe", "pipe", "pipe"] },
    );
    exited = new Promise((done) => child.once("exit", (code) => done(code)));
    let output = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const rows = () => output.split("\n").slice(0, -1).map(JSON.parse);
    const ready = await wait(() => rows().find((row) => row.type === "ready"));
    assert.equal(calls, 0);
    assert.equal(ready.settings.approvalPolicy, "never");
    assert.deepEqual(ready.settings.sandbox, { type: "dangerFullAccess" });
    child.stdin.write(
      '{"method":"prompt","text":"Run the bounded synthetic file write command."}\n',
    );
    await wait(() => held);
    const commandEvent = await wait(() =>
      rows().find(
        (row) =>
          row.type === "event" &&
          row.event.method === "item/completed" &&
          row.event.params.item.type === "commandExecution",
      ),
    );
    assert.equal(commandEvent.event.params.item.status, "completed");
    assert.match(commandEvent.event.params.item.command, /yolo-proof\.txt/u);
    assert.match(commandEvent.event.params.item.aggregatedOutput, /SCOTTY_YOLO_WRITE_OK/u);
    assert.equal(commandOutput.length, 1);
    assert.match(commandOutput[0].output, /SCOTTY_YOLO_WRITE_OK/u);
    assert.equal(
      await readFile(join(ready.homes.cwd, "yolo-proof.txt"), "utf8"),
      "SCOTTY_YOLO_WRITE_OK",
    );
    child.stdin.write('{"method":"interrupt"}\n');
    const terminal = await wait(() => rows().find((row) => row.type === "terminal"));
    assert.equal(terminal.turn.status, "interrupted");
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.equal(stderr, "");
    const receipt = rows().find((row) => row.type === "stopped");
    assert.equal(receipt.shutdown, "eof");
    assert.equal(receipt.parent, "exited");
    assert.equal(receipt.cleanup, "ambiguous");
    assert.equal(receipt.descendants, "unverified");
  },
);

test("expired credentials fail before spawn", async (t) => {
  const f = await fixture(t, "normal", { credential: { ...credential, expiresAt: 1 } });
  await assert.rejects(f.launch(), { code: "credential_expired" });
  await assert.rejects(readFile(f.log), { code: "ENOENT" });
});

test(
  "real pinned binary rejects upstream 401 without OAuth refresh or retry",
  { skip: !native, timeout: 15000 },
  async (t) => {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({ path: req.url, authorization: req.headers.authorization });
      req.resume();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "dummy expired credential",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }),
      );
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    let host;
    t.after(async () => {
      if (host) await host.stop();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    host = await startCodexSession({
      binary: native,
      runtimeDir: join(stage, "native-401"),
      workspace: join(stage, "native-401-workspace"),
      model: "gpt-5.4",
      effort: "high",
      credential,
      upstreamPort: server.address().port,
    });
    assert.equal(requests.length, 0);
    const accepted = await host.prompt("Return a response.");
    await assert.rejects(accepted.completed, { code: "upstream_failed" });
    assert.deepEqual(requests, [
      { path: "/backend-api/codex/responses", authorization: `Bearer ${credential.sentinel}` },
    ]);
    assert.equal((await host.stop()).parent, "exited");
  },
);

test("production executable accepts only explicit managed JSON and fixes URL/auth projection", async (t) => {
  const f = await fixture(t);
  const child = spawn(
    process.execPath,
    [join(stage, "production-entry"), JSON.stringify(selection(f.options))],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.resume();
  t.after(async () => {
    child.stdin.end();
    await exited;
  });
  const ready = await wait(() =>
    output
      .split("\n")
      .slice(0, -1)
      .map(JSON.parse)
      .find((row) => row.type === "ready"),
  );
  const [row] = await f.rows();
  assert.match(row.config, /base_url = "https:\/\/chatgpt.com\/backend-api\/codex"/u);
  assert.match(row.config, /env_key = "SCOTTY_CODEX_SENTINEL"/u);
  assert.match(row.config, /requires_openai_auth = false/u);
  assert.match(row.config, /supports_websockets = false/u);
  assert.equal(row.config.includes(credential.sentinel), false);
  assert.equal(row.config.includes("auth.command"), false);
  assert.equal(row.env.SCOTTY_CODEX_SENTINEL, credential.sentinel);
  assert.equal(row.env.HTTPS_PROXY, undefined);
  assert.equal(row.env.OPENAI_API_KEY, undefined);
  assert.equal(output.includes(credential.sentinel), false);
  await assert.rejects(readFile(join(ready.homes.codexHome, "auth.json")), { code: "ENOENT" });
  assert.equal(ready.homes.cwd, f.options.workspace);
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
  await wait(() => !alive(ready.pid));
});

test(
  "packaged gpt-6-astra executes code-mode and returns synthetic tool output",
  { skip: !native, timeout: 60000 },
  async (t) => {
    const requests = [];
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) {
        if (Buffer.byteLength(text) + chunk.length > 1024 * 1024) {
          req.destroy();
          return;
        }
        text += chunk.toString("utf8");
      }
      assert.equal(req.url, "/backend-api/codex/responses");
      assert.equal(req.headers.authorization, `Bearer ${credential.sentinel}`);
      const body = JSON.parse(text);
      requests.push(body);
      assert.equal(body.model, "gpt-6-astra");
      // Local ultra remains selected; upstream defines its wire effort as xhigh.
      assert.equal(body.reasoning.effort, "xhigh");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, fields) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      send("response.created", {
        response: { id: `resp-code-${requests.length}`, status: "in_progress" },
      });
      const item =
        requests.length === 1
          ? {
              type: "custom_tool_call",
              id: "cm-proof",
              call_id: "call-code",
              name: "exec",
              input: `text(await tools.exec_command({cmd: "printf 'SCOTTY_CODE_MODE_OK 42'", shell: "/bin/sh", login: false, yield_time_ms: 1000}));`,
            }
          : {
              type: "message",
              id: "msg-code",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "CODE_MODE_COMPLETE", annotations: [] }],
            };
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          id: `resp-code-${requests.length}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    let host;
    t.after(async () => {
      if (host) await host.stop();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    host = await startCodexSession({
      binary: native,
      runtimeDir: join(stage, "code-mode-runtime"),
      workspace: join(stage, "code-mode-workspace"),
      model: "gpt-6-astra",
      effort: "ultra",
      credential,
      upstreamPort: server.address().port,
    });
    assert.equal(requests.length, 0);
    assert.equal(host.inspect().settings.approvalPolicy, "never");
    assert.deepEqual(host.inspect().settings.sandbox, { type: "dangerFullAccess" });
    assert.equal(host.inspect().settings.reasoningEffort, "ultra");
    const turn = await host.prompt("Run the synthetic code-mode proof.");
    const terminal = await turn.completed;
    assert.equal(terminal.status, "completed");
    assert.equal(
      terminal.items.find((item) => item.type === "agentMessage").text,
      "CODE_MODE_COMPLETE",
    );
    assert.equal(requests.length, 2);
    // Astra uses Responses Lite: tool definitions are rendered into input, not tools.
    assert.equal(requests[0].tools, undefined);
    const namespaces = requests[0].input.find((item) => item.type === "additional_tools").tools;
    const tools = namespaces.find(
      (tool) => tool.type === "namespace" && tool.name === "functions",
    ).tools;
    assert.ok(tools.some((tool) => tool.name === "exec"));
    assert.ok(!tools.some((tool) => tool.name === "exec_command"));
    const output = requests[1].input.find(
      (item) => item.type === "custom_tool_call_output" && item.call_id === "call-code",
    );
    assert.ok(output);
    assert.match(JSON.stringify(output.output), /SCOTTY_CODE_MODE_OK 42/u);
    assert.ok(
      host
        .inspect()
        .tools.some(
          (tool) =>
            tool.state === "completed" &&
            tool.invocation.includes("SCOTTY_CODE_MODE_OK") &&
            tool.output?.includes("SCOTTY_CODE_MODE_OK 42"),
        ),
    );
    assert.equal(host.inspect().rejected, 0);
    assert.equal((await host.stop()).parent, "exited");
  },
);

test(
  "packaged Codex calls both Scotty first-party tools and consumes their results",
  { skip: !native, timeout: 60000 },
  async (t) => {
    const requests = [];
    const calls = [];
    const browserJob = {
      port: 4174,
      viewport: { width: 800, height: 600 },
      steps: [
        {
          name: "home",
          action: { kind: "goto", path: "/" },
          expect: [{ kind: "urlPath", expected: "/" }],
        },
      ],
      capture: { screenshots: "after-each-step", video: false },
    };
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) {
        if (Buffer.byteLength(text) + chunk.length > 1024 * 1024) {
          req.destroy();
          return;
        }
        text += chunk.toString("utf8");
      }
      assert.equal(req.url, "/backend-api/codex/responses");
      assert.equal(req.headers.authorization, `Bearer ${credential.sentinel}`);
      const body = JSON.parse(text);
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, fields) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      send("response.created", {
        response: { id: `resp-first-party-${requests.length}`, status: "in_progress" },
      });
      const item =
        requests.length === 1
          ? {
              type: "function_call",
              id: "hatch-item",
              call_id: "hatch-call",
              name: "scotty_hatch",
              arguments: JSON.stringify({ operation: "status" }),
            }
          : requests.length === 2
            ? {
                type: "function_call",
                id: "evidence-item",
                call_id: "evidence-call",
                name: "scotty_browser_test",
                arguments: JSON.stringify(browserJob),
              }
            : {
                type: "message",
                id: `msg-first-party-${requests.length}`,
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: requests.length === 3 ? "FIRST_PARTY_COMPLETE" : "FOLLOW_UP_COMPLETE",
                    annotations: [],
                  },
                ],
              };
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          id: `resp-first-party-${requests.length}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    let host;
    t.after(async () => {
      if (host) await host.stop();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    host = await startCodexSession(
      {
        binary: native,
        runtimeDir: join(stage, "first-party-runtime"),
        workspace: join(stage, "first-party-workspace"),
        model: "gpt-5.4",
        effort: "high",
        credential,
        upstreamPort: server.address().port,
      },
      {
        restore: async () => {},
        shutdown: async () => {},
        execute: async (tool, input) => {
          calls.push({ tool, input });
          return {
            text: tool === "scotty_hatch" ? "scotty-hatch:proof" : "scotty-evidence:proof",
            success: true,
          };
        },
      },
    );
    const first = await host.prompt("Use both Scotty tools and report their references.");
    const terminal = await first.completed;
    assert.equal(terminal.status, "completed");
    assert.equal(
      terminal.items.find((item) => item.type === "agentMessage").text,
      "FIRST_PARTY_COMPLETE",
    );
    assert.equal(requests.length, 3);
    for (const name of ["scotty_hatch", "scotty_browser_test"])
      assert.equal(
        requests[0].tools.filter((tool) => tool.type === "function" && tool.name === name).length,
        1,
      );
    assert.deepEqual(calls, [
      { tool: "scotty_hatch", input: { operation: "status" } },
      { tool: "scotty_browser_test", input: browserJob },
    ]);
    assert.match(
      JSON.stringify(
        requests[1].input.find(
          (item) => item.type === "function_call_output" && item.call_id === "hatch-call",
        ),
      ),
      /scotty-hatch:proof/u,
    );
    assert.match(
      JSON.stringify(
        requests[2].input.find(
          (item) => item.type === "function_call_output" && item.call_id === "evidence-call",
        ),
      ),
      /scotty-evidence:proof/u,
    );
    const followUp = await host.prompt("Finish one follow-up turn.");
    const followUpTerminal = await followUp.completed;
    assert.equal(followUpTerminal.status, "completed");
    assert.equal(
      followUpTerminal.items.find((item) => item.type === "agentMessage").text,
      "FOLLOW_UP_COMPLETE",
    );
    assert.equal(requests.length, 4);
    assert.equal(host.inspect().failure, null);
    assert.equal(host.inspect().rejected, 0);
    assert.equal((await host.stop()).parent, "exited");
  },
);

test(
  "packaged Codex delegation preserves parent turn identity",
  { skip: !native, timeout: 60000 },
  async (t) => {
    let requests = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* drain synthetic request */
      }
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, fields) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      send("response.created", {
        response: { id: `resp-delegate-${requests}`, status: "in_progress" },
      });
      const item =
        requests === 1
          ? {
              type: "function_call",
              id: "call-delegate",
              call_id: "call-delegate",
              namespace: "collaboration",
              name: "spawn_agent",
              arguments: JSON.stringify({
                task_name: "proof",
                message: "Reply CHILD_OK without tools.",
              }),
            }
          : {
              type: "message",
              id: `msg-delegate-${requests}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "DELEGATION_COMPLETE", annotations: [] }],
            };
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          id: `resp-delegate-${requests}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    let host;
    t.after(async () => {
      if (host) await host.stop();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    host = await startCodexSession({
      binary: native,
      runtimeDir: join(stage, "delegation-runtime"),
      workspace: join(stage, "delegation-workspace"),
      model: "gpt-6-astra",
      effort: "ultra",
      ephemeral: false,
      credential,
      upstreamPort: server.address().port,
    });
    const turn = await host.prompt("Spawn one child and wait for its answer.");
    assert.equal((await turn.completed).status, "completed");
    assert.equal(requests, 3);
    assert.ok(host.inspect().discarded >= 1);
    assert.ok(
      host.drainEvents().every((event) => event.params.threadId === host.inspect().threadId),
    );
    const followUp = await host
      .prompt("Complete one more turn after delegation.")
      .catch((error) => {
        throw new Error(JSON.stringify(observeCodexFailure(error)));
      });
    const followUpTerminal = await followUp.completed.catch((error) => {
      throw new Error(JSON.stringify(observeCodexFailure(error)));
    });
    assert.equal(followUpTerminal.status, "completed");
    assert.equal(requests, 4);
    assert.equal(host.inspect().failure, null);
  },
);

for (const mode of [
  "ready",
  "missing",
  "wrong-version",
  "truncated",
  "oversized",
  "hang",
  "nonzero",
]) {
  test(`code-mode preflight ${mode}: framed v1 before any app-server work`, async (t) => {
    const f = await fixture(t, "normal", {
      model: "gpt-6-astra",
      effort: "ultra",
      requestTimeoutMs: 1000,
    });
    const bin = await mkdtemp(join(stage, "helper-bin-"));
    await copyFile(f.options.binary, join(bin, "codex"));
    f.options.binary = join(bin, "codex");
    const log = join(bin, "hello.json");
    if (mode !== "missing") {
      await writeFile(
        join(bin, "codex-code-mode-host"),
        `#!${process.execPath}
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const chunks=[];
process.stdin.on('data', chunk=>chunks.push(chunk));
process.stdin.on('end', ()=>{
 const bytes=Buffer.concat(chunks);
 assert.equal(bytes.readUInt32LE(0),bytes.length-4);
 const hello=JSON.parse(bytes.subarray(4));
 assert.deepEqual(hello,{type:'connection/hello',supportedVersions:[1],requiredCapabilities:[],optionalCapabilities:['session-cell-execution-resource-limits']});
 writeFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,env:process.env,args:process.argv.slice(2),hello}));
 const mode=${JSON.stringify(mode)};
 if(mode==='hang'){setInterval(()=>{},1000);return;}
 const body=Buffer.from(JSON.stringify({type:'connection/ready',selectedVersion:mode==='wrong-version'?2:1,capabilities:['session-cell-execution-resource-limits']}));
 const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
 process.stdout.write(mode==='oversized'?Buffer.alloc(4097):mode==='truncated'?header:Buffer.concat([header,body]));
 process.exitCode=mode==='nonzero'?1:0;
});
`,
      );
      await chmod(join(bin, "codex-code-mode-host"), 0o755);
    }
    if (mode === "ready") {
      const host = await f.launch();
      assert.equal(host.inspect().ready, true);
      assert.equal((await f.rows()).filter((row) => row.method === "turn/start").length, 0);
      await host.stop();
    } else {
      await assert.rejects(f.launch(), (error) => error.code === "spawn_failed");
      await assert.rejects(readFile(f.log), { code: "ENOENT" });
    }
    if (mode !== "missing") {
      const observed = JSON.parse(await readFile(log, "utf8"));
      assert.deepEqual(observed.args, ["--listen", "stdio"]);
      assert.equal(observed.env.SCOTTY_CODEX_SENTINEL, undefined);
      assert.equal(observed.env.CODEX_HOME, undefined);
      assert.equal(observed.env.PATH, "/usr/bin:/bin");
      await wait(() => !alive(observed.pid));
    }
  });
}

test(
  "native missing packaged helper fails before ready or upstream work",
  { skip: !native, timeout: 15000 },
  async (t) => {
    const bin = await mkdtemp(join(stage, "missing-native-helper-"));
    await copyFile(native, join(bin, "codex"));
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(500);
      res.end();
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => server.close(done)));
    await assert.rejects(
      startCodexSession({
        binary: join(bin, "codex"),
        runtimeDir: join(bin, "runtime"),
        workspace: join(bin, "workspace"),
        model: "gpt-6-astra",
        effort: "max",
        credential,
        upstreamPort: server.address().port,
      }),
      (error) => error.code === "spawn_failed",
    );
    assert.equal(requests, 0);
  },
);

for (const selection of [
  { model: "gpt-6-astra-unknown", effort: "high" },
  { model: "gpt-5.4", effort: "ultra" },
]) {
  test(`model admission fails before spawn: ${selection.model}/${selection.effort}`, async (t) => {
    const f = await fixture(t, "normal", selection);
    await assert.rejects(f.launch(), (error) => error.code === "invalid_launch_selection");
    await assert.rejects(readFile(f.log), { code: "ENOENT" });
    await assert.rejects(readFile(join(f.options.runtimeDir, "codex-home", "config.toml")), {
      code: "ENOENT",
    });
  });
}
