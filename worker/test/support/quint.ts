import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const quint = resolve(root, "node_modules/.bin/quint");

export const generateTraces = (options: {
  model: string;
  seed: string;
  traces: number;
  maxSteps: number;
  step?: string;
}): ReadonlyArray<unknown> => {
  const directory = mkdtempSync(join(tmpdir(), "scotty-quint-"));
  try {
    const result = spawnSync(
      quint,
      [
        "run",
        options.model,
        "--backend",
        "typescript",
        "--mbt",
        ...(options.step === undefined ? [] : ["--step", options.step]),
        "--max-steps",
        String(options.maxSteps),
        "--max-samples",
        String(options.traces),
        "--n-traces",
        String(options.traces),
        "--out-itf",
        join(directory, "t_{seq}.itf.json"),
        "--seed",
        options.seed,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `quint failed (${result.status ?? result.error}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    return Array.from({ length: options.traces }, (_, index) =>
      JSON.parse(readFileSync(join(directory, `t_${index}.itf.json`), "utf8")),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

export const normalizeItf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeItf);
  if (typeof value !== "object" || value === null) return value;
  const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(value);
  const field = (key: string): unknown => entries.find(([name]) => name === key)?.[1];
  const bigint = field("#bigint");
  if (typeof bigint === "string") {
    const number = Number(bigint);
    if (!Number.isSafeInteger(number)) {
      throw new Error(`unsafe ITF integer: ${bigint}`);
    }
    return number;
  }
  const set = field("#set");
  if (Array.isArray(set)) return set.map(normalizeItf);
  const tuple = field("#tup");
  if (Array.isArray(tuple)) return tuple.map(normalizeItf);
  const map = field("#map");
  if (Array.isArray(map))
    return map.map((pair) => {
      const normalized = normalizeItf(pair);
      if (!Array.isArray(normalized) || normalized.length !== 2) {
        throw new Error("invalid ITF map pair");
      }
      return normalized;
    });
  const tag = field("tag");
  if (typeof tag === "string" && entries.some(([key]) => key === "value"))
    return { _tag: tag, value: normalizeItf(field("value")) };
  return Object.fromEntries(
    entries
      .filter(([key]) => !key.startsWith("#meta"))
      .map(([key, item]) => [key, normalizeItf(item)]),
  );
};
