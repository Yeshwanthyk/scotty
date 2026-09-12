#!/usr/bin/env node
// Downloads one authorized, read-only Codex archive. Raw rollouts stay in 0600
// local files; stdout contains only counts and hashes.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const ROLLOUT_PATH = /^sessions\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/rollout-[A-Za-z0-9_.-]+\.jsonl$/u;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function writePrivate(file, bytes) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function downloadArchive(sessionId, base, token) {
  const endpoint = new URL(`/api/sessions/${sessionId}/codex/rollouts`, base);
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
  });
  if (
    !response.ok ||
    response.headers.get("content-type") !== "application/x-tar" ||
    !response.body
  )
    throw new Error(`Codex rollout export unavailable (HTTP ${response.status})`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > MAX_ARCHIVE_BYTES) throw new Error("Codex rollout archive exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function saveArchive(sessionId, archive, outputDirectory) {
  const names = execFileSync("tar", ["-tf", "-"], {
    input: archive,
    maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString("utf8")
    .trimEnd()
    .split("\n");
  if (
    names.length === 0 ||
    names.length > 128 ||
    new Set(names).size !== names.length ||
    names.some((name) => !ROLLOUT_PATH.test(name))
  )
    throw new Error("Codex rollout archive contains unexpected members");

  await mkdir(outputDirectory, { mode: 0o700 });
  if (((await stat(outputDirectory)).mode & 0o077) !== 0)
    throw new Error("Output directory is not private");
  await writePrivate(path.join(outputDirectory, "rollouts.tar"), archive);
  const files = [];
  for (const name of names) {
    const bytes = execFileSync("tar", ["-xOf", "-", name], {
      input: archive,
      maxBuffer: MAX_ARCHIVE_BYTES,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const destination = path.join(outputDirectory, name);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writePrivate(destination, bytes);
    files.push({ path: name, bytes: bytes.byteLength, sha256: digest(bytes) });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  await writePrivate(
    path.join(outputDirectory, "manifest.json"),
    Buffer.from(
      `${JSON.stringify({ sessionId, archiveSha256: digest(archive), files }, null, 2)}\n`,
    ),
  );
  process.stdout.write(
    `Captured ${files.length} private rollouts; archive sha256 ${digest(archive)}\n`,
  );
}

async function main() {
  const [sessionId, baseUrl, tokenFile, outputDirectory] = process.argv.slice(2);
  if (!/^[0-9a-f]{12}$/u.test(sessionId ?? "") || !baseUrl || !tokenFile || !outputDirectory)
    throw new Error("Invalid capture arguments");
  const base = new URL(baseUrl);
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && base.hostname === "127.0.0.1")) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("Invalid capture origin");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error("Empty capture token");
  await saveArchive(sessionId, await downloadArchive(sessionId, base, token), outputDirectory);
}

main().catch(() => {
  process.stderr.write("Codex rollout capture failed; inspect the private output directory.\n");
  process.exitCode = 1;
});
