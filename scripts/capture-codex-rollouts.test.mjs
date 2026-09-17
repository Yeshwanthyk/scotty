import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
