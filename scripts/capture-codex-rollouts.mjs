#!/usr/bin/env node
// Downloads one authorized, read-only Codex archive. Raw rollouts stay in 0600
// local files; stdout contains only counts and hashes.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const ROLLOUT_PATH = /^sessions\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/rollout-[A-Za-z0-9_.-]+\.jsonl$/u;

async function writePrivate(file, bytes) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadArchive(sessionId, base, token, destination) {
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
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

const tarProcess = (args) => {
  const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  const settled = new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
  return { child, settled };
};

async function listArchive(archiveFile) {
  const { child, settled } = tarProcess(["-tf", archiveFile]);
  child.stdout.setEncoding("utf8");
  let listing = "";
  for await (const chunk of child.stdout) listing += chunk;
  await settled;
  const names = listing.trimEnd().split("\n");
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    names.some((name) => !ROLLOUT_PATH.test(name))
  )
    throw new Error("Codex rollout archive contains unexpected members");
  return names;
}

async function extractMember(archiveFile, name, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let bytes = 0;
  const account = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const { child, settled } = tarProcess(["-xOf", archiveFile, name]);
  try {
    await Promise.all([
      pipeline(child.stdout, account, createWriteStream(destination, { flags: "wx", mode: 0o600 })),
      settled,
    ]);
  } catch (error) {
    child.kill();
    await settled.catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  }
  return { path: name, bytes, sha256: hash.digest("hex") };
}

async function saveArchive(sessionId, archiveFile, outputDirectory) {
  const names = await listArchive(archiveFile);
  const files = [];
  for (const name of names)
    files.push(await extractMember(archiveFile, name, path.join(outputDirectory, name)));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const archiveSha256 = await fileDigest(archiveFile);
  await writePrivate(
    path.join(outputDirectory, "manifest.json"),
    Buffer.from(`${JSON.stringify({ sessionId, archiveSha256, files }, null, 2)}\n`),
  );
  process.stdout.write(
    `Captured ${files.length} private rollouts; archive sha256 ${archiveSha256}\n`,
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
  await mkdir(outputDirectory, { mode: 0o700 });
  if (((await stat(outputDirectory)).mode & 0o077) !== 0)
    throw new Error("Output directory is not private");
  const archiveFile = path.join(outputDirectory, "rollouts.tar");
  await downloadArchive(sessionId, base, token, archiveFile);
  await saveArchive(sessionId, archiveFile, outputDirectory);
}

main().catch(() => {
  process.stderr.write("Codex rollout capture failed; inspect the private output directory.\n");
  process.exitCode = 1;
});
