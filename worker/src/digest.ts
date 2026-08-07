const textEncoder = new TextEncoder();

const sha256Bytes = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));

const bytesToHex = (digest: Uint8Array): string =>
  Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

export async function sha256BytesHex(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)));
}

export async function constantTimeStringEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }
  return difference === 0 && left.length === right.length;
}
