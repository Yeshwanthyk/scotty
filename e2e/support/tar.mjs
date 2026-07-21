import path from "node:path";

const BLOCK_SIZE = 512;

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(buffer, offset, length, value) {
  const encoded =
    Math.max(0, value)
      .toString(8)
      .padStart(length - 1, "0") + "\0";
  writeString(buffer, offset, length, encoded);
}

function checksum(header) {
  let total = 0;
  for (const byte of header) total += byte;
  return total;
}

export function createTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const name = entry.name.replaceAll("\\", "/");
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body);
    const header = Buffer.alloc(BLOCK_SIZE);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, entry.mode ?? 0o600);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    writeOctal(header, 148, 8, checksum(header));
    chunks.push(header, body);
    const padding = (BLOCK_SIZE - (body.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

export function readTar(buffer) {
  const entries = [];
  for (let offset = 0; offset + BLOCK_SIZE <= buffer.length;) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString().split("\0", 1)[0];
    const sizeText = header.subarray(124, 136).toString().split("\0", 1)[0].trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const start = offset + BLOCK_SIZE;
    entries.push({ name, body: buffer.subarray(start, start + size) });
    offset = start + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return entries;
}

export function assertSafeTarPath(name) {
  if (name.includes("\0") || path.posix.isAbsolute(name)) return false;
  const normalized = path.posix.normalize(name);
  return normalized !== ".." && !normalized.startsWith("../");
}
