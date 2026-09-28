// A skill is one zip holding SKILL.md, at the root or in one folder. The Worker reads its
// frontmatter for the name and description; the supervisor unpacks the zip itself.

export const skillName = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const maxSkillBytes = 5 * 1024 * 1024;
export const maxInstructionBytes = 64 * 1024;

export const instructionsKey = "settings/instructions.md";
export const skillKey = (name: string) => `skills/${name}.zip`;

export type SkillInfo = { name: string; description: string };

const skillPath = /^(?:[^/]+\/)?SKILL\.md$/;

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The one SKILL.md entry, read through the central directory (sizes in local headers can be 0).
async function readSkillFile(zip: Uint8Array<ArrayBuffer>): Promise<string | undefined> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65535); at--)
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) return undefined;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count && at + 46 <= zip.length; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) return undefined;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + skip;
    if (!skillPath.test(name) || local + 30 > zip.length) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = zip.subarray(start, start + size);
    if (method === 0) return decoder.decode(body);
    if (method === 8) return decoder.decode(await inflate(body));
    return undefined;
  }
  return undefined;
}

// `name:` and `description:` from the YAML frontmatter; a folded or literal description
// (`>` or `|`) joins its indented lines.
export function frontmatter(text: string): Partial<SkillInfo> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return {};
  const lines = block.split(/\r?\n/);
  const out: Partial<SkillInfo> = {};
  lines.forEach((line, index) => {
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (field?.[1] === undefined) return;
    let value = (field[2] ?? "").trim();
    if (/^[>|][+-]?$/.test(value)) {
      const rest = lines.slice(index + 1);
      const end = rest.findIndex((next) => !/^\s/.test(next) && next.trim() !== "");
      value = (end < 0 ? rest : rest.slice(0, end))
        .map((next) => next.trim())
        .join(" ")
        .trim();
    }
    out[field[1] === "name" ? "name" : "description"] = value.replace(/^(["'])(.*)\1$/, "$2");
  });
  return out;
}

export async function readSkill(zip: Uint8Array<ArrayBuffer>): Promise<SkillInfo | string> {
  const file = await readSkillFile(zip).catch(() => undefined);
  if (file === undefined) return "The zip needs SKILL.md at its root or in one folder";
  const { name, description } = frontmatter(file);
  if (name === undefined || !skillName.test(name))
    return "SKILL.md needs a name of lowercase letters, digits and dashes";
  if (description === undefined || description === "") return "SKILL.md needs a description";
  return { name, description: description.slice(0, 1024) };
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
