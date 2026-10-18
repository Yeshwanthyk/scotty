import { Effect, Schema } from "effect";
import { tarReader } from "./tar.js";

// A skill source is a GitHub repository, a folder in it and a ref. Each skill is a folder
// right under that folder holding SKILL.md. Scotty keeps the repository's tarball at one commit
// in R2 and the supervisor unpacks the folder whole, so links between skills keep working.

export const skillName = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const maxInstructionBytes = 64 * 1024;
export const maxSourceBytes = 64 * 1024 * 1024;
const maxSkillFile = 256 * 1024;

export const instructionsKey = "settings/instructions.md";
export const sourceKey = (repo: string, commit: string) => `skills/${repo}/${commit}.tar.gz`;

const owner = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const repository = "[A-Za-z0-9._-]{1,100}";
const segment = "(?!\\.\\.?(?:/|$))[A-Za-z0-9._-]+";
const ref = "[A-Za-z0-9._/-]{1,200}";
// owner/repo[/path][@ref], or a github.com link to the repository or a folder in it.
const spec = new RegExp(`^(${owner}/${repository})((?:/${segment})*)(?:@(${ref}))?$`);
const link = new RegExp(
  `^https://github\\.com/(${owner}/${repository})(?:/tree/([A-Za-z0-9._-]{1,200})((?:/${segment})*))?/?$`,
);

export type SourceSpec = { repo: string; path: string; ref: string | null };

export const parseSource = (text: string): SourceSpec | undefined => {
  const trimmed = text.trim();
  const short = spec.exec(trimmed);
  if (short?.[1] !== undefined)
    return { repo: short[1], path: (short[2] ?? "").slice(1), ref: short[3] ?? null };
  const long = link.exec(trimmed);
  if (long?.[1] !== undefined)
    return {
      repo: long[1].replace(/\.git$/, ""),
      path: (long[3] ?? "").slice(1),
      ref: long[2] ?? null,
    };
  return undefined;
};

// The source's name everywhere: owner/repo or owner/repo/path.
export const sourceId = (source: { repo: string; path: string }) =>
  source.path === "" ? source.repo : `${source.repo}/${source.path}`;

export const SourceId = Schema.String.check(
  Schema.makeFilter((text: string) => {
    const parsed = parseSource(text);
    return parsed !== undefined && parsed.ref === null && sourceId(parsed) === text;
  }),
);

type Frontmatter = { name?: string; description?: string; manual?: boolean };

// `name`, `description` and `disable-model-invocation` from the YAML frontmatter; a folded or
// literal description (`>` or `|`) joins its indented lines.
function frontmatter(text: string): Frontmatter {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return {};
  const lines = block.split(/\r?\n/);
  const out: Frontmatter = {};
  lines.forEach((line, index) => {
    const found = /^(name|description|disable-model-invocation):\s*(.*)$/.exec(line);
    if (found?.[1] === undefined) return;
    let value = (found[2] ?? "").trim();
    if (/^[>|][+-]?$/.test(value)) {
      const rest = lines.slice(index + 1);
      const end = rest.findIndex((next) => !/^\s/.test(next) && next.trim() !== "");
      value = (end < 0 ? rest : rest.slice(0, end))
        .map((next) => next.trim())
        .join(" ")
        .trim();
    }
    value = value.replace(/^(["'])(.*)\1$/, "$2");
    if (found[1] === "name") out.name = value;
    else if (found[1] === "description") out.description = value;
    else out.manual = value === "true";
  });
  return out;
}

// A cheap running hash of each skill folder's paths and bytes, to tell which skills a refresh
// changed. Not a security check.
const mix = (hash: [number, number], bytes: Uint8Array) => {
  let [a, b] = hash;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 2654435761);
    b = Math.imul(b ^ byte, 1597334677);
  }
  hash[0] = a;
  hash[1] = b;
};
const hex = (hash: [number, number]) =>
  hash.map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");

export type FoundSkill = { name: string; description: string; manual: boolean; digest: string };
export type Scan = { skills: FoundSkill[]; skipped: string[] };

// One pass over a GitHub tarball (gzip): every `<top>/<path>/<name>/SKILL.md` and a digest of
// each skill folder.
export const scanTarball = (gzip: ReadableStream<BufferSource>, path: string) =>
  Effect.tryPromise({
    try: async (): Promise<Scan> => {
      const folders = new Map<
        string,
        { hash: [number, number]; file: Uint8Array[]; size: number }
      >();
      const encoder = new TextEncoder();
      const prefix = path === "" ? "" : `${path}/`;
      const reader = tarReader((entry) => {
        const inside = entry.slice(entry.indexOf("/") + 1);
        if (!inside.startsWith(prefix)) return undefined;
        const [folder, ...rest] = inside.slice(prefix.length).split("/");
        if (folder === undefined || folder === "" || rest.length === 0) return undefined;
        const seen = folders.get(folder) ?? { hash: [0x811c9dc5, 0x2545f491], file: [], size: 0 };
        folders.set(folder, seen);
        mix(seen.hash, encoder.encode(rest.join("/")));
        const isSkill = rest.length === 1 && rest[0] === "SKILL.md";
        return (bytes) => {
          mix(seen.hash, bytes);
          if (isSkill && seen.size + bytes.length <= maxSkillFile) {
            seen.file.push(bytes.slice());
            seen.size += bytes.length;
          }
        };
      });
      const stream = gzip.pipeThrough(new DecompressionStream("gzip"));
      for await (const chunk of stream) reader.push(chunk);
      reader.end();
      const skills: FoundSkill[] = [];
      const skipped: string[] = [];
      for (const [folder, seen] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
        if (seen.size === 0) continue;
        const text = new TextDecoder().decode(
          seen.file.reduce((all, part) => {
            const joined = new Uint8Array(all.length + part.length);
            joined.set(all);
            joined.set(part, all.length);
            return joined;
          }, new Uint8Array(0)),
        );
        const { name, description, manual } = frontmatter(text);
        if (name !== folder || !skillName.test(name))
          skipped.push(`${folder}: SKILL.md's name must be the folder's name, in a-z, 0-9 and -`);
        else if (description === undefined || description === "")
          skipped.push(`${folder}: SKILL.md needs a description`);
        else
          skills.push({
            name,
            description: description.slice(0, 1024),
            manual: manual === true,
            digest: hex(seen.hash),
          });
      }
      return { skills, skipped };
    },
    catch: () => new SourceFailure({ message: "The tarball is not a readable tar.gz" }),
  });

export class SourceFailure extends Schema.TaggedError<SourceFailure>()("SourceFailure", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

const github = (token: string, accept: string) => ({
  accept,
  authorization: `Bearer ${token}`,
  "user-agent": "scotty-rebuild",
});

// The commit a ref names; no ref is the default branch.
export const resolveCommit = (source: SourceSpec, token: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(source.ref ?? "HEAD")}`,
          { headers: github(token, "application/vnd.github.sha") },
        ),
      catch: () => new SourceFailure({ message: "GitHub is unreachable" }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new SourceFailure({ message: "GitHub's answer was cut off" }),
    });
    if (response.status === 404 || response.status === 422)
      return yield* new SourceFailure({
        message: `GitHub has no ${source.repo}${source.ref === null ? "" : `@${source.ref}`} this token can see`,
        status: 404,
      });
    if (!response.ok || !/^[0-9a-f]{40}$/.test(text.trim()))
      return yield* new SourceFailure({ message: `GitHub answered HTTP ${response.status}` });
    return text.trim();
  });

// The repository's tarball at a commit, read whole (it goes to R2 as it came) up to the cap.
export const fetchTarball = (repo: string, commit: string, token: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`https://api.github.com/repos/${repo}/tarball/${commit}`, {
          headers: github(token, "application/vnd.github+json"),
        }),
      catch: () => new SourceFailure({ message: "GitHub is unreachable" }),
    });
    if (!response.ok || response.body === null)
      return yield* new SourceFailure({
        message: `GitHub answered HTTP ${response.status} for the tarball`,
      });
    const body = response.body;
    const read = yield* Effect.tryPromise({
      try: async () => {
        const parts: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        for await (const chunk of body) {
          size += chunk.length;
          if (size > maxSourceBytes) {
            await body.cancel();
            return undefined;
          }
          parts.push(chunk);
        }
        return { parts, size };
      },
      catch: () => new SourceFailure({ message: "GitHub's tarball was cut off" }),
    });
    if (read === undefined)
      return yield* new SourceFailure({
        message: `The repository's tarball is over ${maxSourceBytes / 1024 / 1024} MiB`,
        status: 413,
      });
    return read;
  });

export const partsStream = (parts: ReadonlyArray<Uint8Array<ArrayBuffer>>) =>
  new ReadableStream<BufferSource>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
