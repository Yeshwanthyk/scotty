import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const failureMessage = "Codex rollout capture failed; inspect the private output directory.\n";

async function runCaptureWithTar(root, tarScript, prepareOutput = async () => {}) {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "tar"), tarScript, { mode: 0o755 });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-tar" });
    response.end("synthetic archive");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const tokenFile = path.join(root, "token");
  await writeFile(tokenFile, "dummy-token\n", { mode: 0o600 });
  const output = path.join(root, "captured");
  await prepareOutput(output);
  const child = spawn(
    process.execPath,
    [
      new URL("./capture-codex-rollouts.mjs", import.meta.url).pathname,
      "a0b1c2d3e4f5",
      `http://127.0.0.1:${address.port}/`,
      tokenFile,
      output,
    ],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve) => child.once("exit", resolve));
  server.close();
  return { exit, output, stderr };
}

test("streams large rollout archives and listings into private files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scotty-rollout-capture-test-"));
  const source = path.join(root, "source");
  const relative = Array.from(
    { length: 300 },
    (_, index) =>
      `sessions/2026/09/12/rollout-${String(index).padStart(3, "0")}-${"x".repeat(180)}.jsonl`,
  );
  for (const [index, name] of relative.entries()) {
    const file = path.join(source, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, index === 0 ? Buffer.alloc(21 * 1024 * 1024, 120) : `${name}\n`);
  }
  const tarPath = path.join(root, "fixture.tar");
  execFileSync("tar", ["-cf", tarPath, "-C", source, ...relative]);
  const archive = await readFile(tarPath);
  assert.ok(archive.byteLength > 20 * 1024 * 1024);
  assert.ok(Buffer.byteLength(`${relative.join("\n")}\n`) > 64 * 1024);
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/sessions/a0b1c2d3e4f5/codex/rollouts");
    assert.equal(request.headers.authorization, "Bearer dummy-token");
    response.writeHead(200, { "content-type": "application/x-tar" });
    response.end(archive);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const tokenFile = path.join(root, "token");
  await writeFile(tokenFile, "dummy-token\n", { mode: 0o600 });
  const output = path.join(root, "captured");
  const child = spawn(
    process.execPath,
    [
      new URL("./capture-codex-rollouts.mjs", import.meta.url).pathname,
      "a0b1c2d3e4f5",
      `http://127.0.0.1:${address.port}/`,
      tokenFile,
      output,
    ],
    { stdio: "ignore" },
  );
  const exit = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exit, 0);
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.archiveSha256, sha256(archive));
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    relative.sort(),
  );
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(output, file.path));
    assert.equal(file.sha256, sha256(bytes));
    assert.equal((await stat(path.join(output, file.path))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(path.join(output, "rollouts.tar"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(output, "manifest.json"))).mode & 0o777, 0o600);
});

test("observes a failing tar child while extraction output is active", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scotty-rollout-child-failure-"));
  const result = await runCaptureWithTar(
    root,
    `#!/bin/sh
if [ "$1" = "-tf" ]; then
  printf 'sessions/2026/09/12/rollout-failure.jsonl\\n'
  exit 0
fi
printf 'synthetic tar failure\\n' >&2
exit 23
`,
  );

  assert.equal(result.exit, 1);
  assert.equal(result.stderr, failureMessage);
  await assert.rejects(stat(path.join(result.output, "sessions/2026/09/12/rollout-failure.jsonl")));
});

test("kills and waits for tar when the extraction output fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scotty-rollout-output-failure-"));
  const member = "sessions/2026/09/12/rollout-output.jsonl";
  const result = await runCaptureWithTar(
    root,
    `#!/bin/sh
if [ "$1" = "-tf" ]; then
  printf '${member}\\n'
  exit 0
fi
printf 'payload'
sleep 10
`,
    async (output) => {
      await mkdir(path.join(output, member), { recursive: true, mode: 0o700 });
    },
  );

  assert.equal(result.exit, 1);
  assert.equal(result.stderr, failureMessage);
  assert.ok((await stat(path.join(result.output, member))).isDirectory());
});
