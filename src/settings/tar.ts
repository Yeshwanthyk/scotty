// A streaming reader for the tar files GitHub serves: ustar headers, pax `path` records and GNU
// long names. It never holds a whole file; each wanted file's bytes go to the sink `open` returns.

type Sink = (bytes: Uint8Array) => void;
type Open = (path: string) => Sink | undefined;

const block = 512;
const decoder = new TextDecoder();

const field = (header: Uint8Array, start: number, length: number) => {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
};

const octal = (header: Uint8Array, start: number, length: number) => {
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("tar: bad number");
  return text === "" ? 0 : parseInt(text, 8);
};

// `<length> path=<value>\n` records; only `path` matters here.
const paxPath = (body: Uint8Array) => {
  const text = decoder.decode(body);
  let at = 0;
  let path: string | undefined;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    const length = Number(text.slice(at, space));
    if (space < 0 || !Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, at + length - 1);
    if (record.startsWith("path=")) path = record.slice(5);
    at += length;
  }
  return path;
};

export function tarReader(open: Open) {
  let buffer: Uint8Array = new Uint8Array(0);
  // Bytes left in the current entry's body, padding included, and how many of them are file.
  let left = 0;
  let size = 0;
  let sink: Sink | undefined;
  let meta: { type: number; parts: Uint8Array[] } | undefined;
  let longPath: string | undefined;
  let ended = false;

  const header = (bytes: Uint8Array) => {
    if (bytes.every((byte) => byte === 0)) {
      ended = true;
      return;
    }
    const type = bytes[156] ?? 0;
    size = octal(bytes, 124, 12);
    left = Math.ceil(size / block) * block;
    const name = field(bytes, 0, 100);
    const prefix = field(bytes, 257, 6).startsWith("ustar") ? field(bytes, 345, 155) : "";
    const path = longPath ?? (prefix === "" ? name : `${prefix}/${name}`);
    sink = undefined;
    meta = undefined;
    // x: pax record for the next entry, g: global pax record, L: GNU long name.
    if (type === 0x78 || type === 0x67 || type === 0x4c) {
      if (size > 1024 * 1024) throw new Error("tar: oversized metadata");
      meta = { type, parts: [] };
      return;
    }
    longPath = undefined;
    // 0 or NUL: regular file, 7: contiguous file.
    if (type === 0x30 || type === 0 || type === 0x37) sink = open(path);
  };

  const finishMeta = () => {
    if (meta === undefined) return;
    const body = new Uint8Array(size);
    let at = 0;
    for (const part of meta.parts) {
      body.set(part, at);
      at += part.length;
    }
    if (meta.type === 0x78) longPath = paxPath(body) ?? longPath;
    if (meta.type === 0x4c) longPath = field(body, 0, body.length);
    meta = undefined;
  };

  const take = () => {
    while (!ended) {
      if (left === 0) {
        if (buffer.length < block) return;
        header(buffer.subarray(0, block));
        buffer = buffer.subarray(block);
        continue;
      }
      if (buffer.length === 0) return;
      const count = Math.min(left, buffer.length);
      const fileBytes = Math.max(
        0,
        Math.min(count, size - (Math.ceil(size / block) * block - left)),
      );
      const chunk = buffer.subarray(0, fileBytes);
      if (fileBytes > 0) {
        sink?.(chunk);
        meta?.parts.push(chunk.slice());
      }
      buffer = buffer.subarray(count);
      left -= count;
      if (left === 0) finishMeta();
    }
  };

  return {
    push(chunk: Uint8Array) {
      if (ended) return;
      if (buffer.length === 0) buffer = chunk;
      else {
        const joined = new Uint8Array(buffer.length + chunk.length);
        joined.set(buffer);
        joined.set(chunk, buffer.length);
        buffer = joined;
      }
      take();
    },
    // A tar that stops mid-entry is truncated.
    end() {
      if (left > 0 || (buffer.length > 0 && !ended)) throw new Error("tar: truncated");
    },
  };
}
