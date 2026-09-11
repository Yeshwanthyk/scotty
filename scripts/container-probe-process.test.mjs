import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  createJsonlAccumulator,
  observeChildExit,
  terminateObservedChild,
} from "./container-probe-process.mjs";

test("JSONL accumulation retains fragmented records until newline termination", () => {
  const parser = createJsonlAccumulator();
  assert.deepEqual(parser.push('{"type":"rea'), []);
  assert.equal(parser.remainder(), '{"type":"rea');
  assert.deepEqual(parser.push('dy","settings":{"model":"gpt-5.2"}}\n'), [
    { type: "ready", settings: { model: "gpt-5.2" } },
  ]);
  assert.equal(parser.remainder(), "");
});

test("observed child exit retains an early signal exit", async () => {
  const child = spawn(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")']);
  const observed = observeChildExit(child);
  const exit = await observed.exit;
  assert.deepEqual(exit, { code: null, signal: "SIGTERM" });
  assert.deepEqual(await terminateObservedChild(child, observed), exit);
});

test("bounded cleanup kills a child that resists SIGTERM", async (t) => {
  const child = spawn(process.execPath, [
    "-e",
    'process.on("SIGTERM",()=>{}); process.stdout.write("ready\\n"); setInterval(()=>{},1000)',
  ]);
  const observed = observeChildExit(child);
  t.after(async () => {
    if (!observed.isSettled()) await terminateObservedChild(child, observed);
  });
  await once(child.stdout, "data");
  const exit = await terminateObservedChild(child, observed, {
    termMilliseconds: 50,
    killMilliseconds: 1_000,
  });
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
});
