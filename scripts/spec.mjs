import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quint = resolve(root, "node_modules/.bin/quint");
const execute = (args) =>
  new Promise((done) => {
    const child = spawn(quint, args, { cwd: root });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => done({ status: null, output, error }));
    child.on("close", (status) => done({ status, output }));
  });
const models = [
  {
    file: "spec/quint/session_lease.qnt",
    invariants: ["safety"],
    expectedViolations: ["failedHasExit"],
    witnesses: ["reachesSleeping", "reachesStoppedSleep"],
  },
];

for (const model of models) {
  const runArgs = [
    "run",
    model.file,
    "--backend",
    "typescript",
    "--max-steps",
    "40",
    "--max-samples",
    "500",
    "--seed",
    "1",
  ];
  const typecheck = await execute(["typecheck", model.file]);
  if (typecheck.status !== 0) {
    console.error(`${model.file}: quint typecheck failed (${typecheck.status ?? typecheck.error})`);
    process.exit(1);
  }
  const run = await execute([...runArgs, "--invariants", ...model.invariants]);
  if (run.status !== 0) {
    console.error(`${model.file}: quint run failed (${run.status ?? run.error})`);
    process.exit(1);
  }
  const witnesses = await execute([
    ...runArgs,
    "--step",
    "guidedStep",
    "--witnesses",
    ...model.witnesses,
  ]);
  if (witnesses.status !== 0) {
    console.error(
      `${model.file}: guided witnesses failed (${witnesses.status ?? witnesses.error})`,
    );
    process.exit(1);
  }
  for (const witness of model.witnesses) {
    const line = witnesses.output
      .split(/\r?\n/)
      .find((entry) => entry.startsWith(`${witness} was witnessed in `));
    const count = line?.match(/was witnessed in (\d+) trace\(s\) out of/);
    if (count === null || count === undefined || Number(count[1]) === 0) {
      console.error(`${model.file}: witness ${witness} was missing or reached in zero traces`);
      process.exit(1);
    }
  }
  console.log(`${model.file}: safety passed; all ${model.witnesses.length} witnesses reached`);
  for (const invariant of model.expectedViolations) {
    const expected = await execute([...runArgs, "--invariants", invariant]);
    // Only this invariant is checked, so any violation is this one.
    if (expected.status !== 1 || !expected.output.includes("Invariant violated")) {
      console.error(
        `${model.file}: expected violation ${invariant} was not found (status ${expected.status ?? expected.error})`,
      );
      process.exit(1);
    }
    console.log(`${model.file}: expected violation ${invariant} found`);
  }
}

const replay = spawnSync(
  resolve(root, "node_modules/.bin/vitest"),
  ["run", "worker/test/session-actor/session-lease.replay.test.ts"],
  { cwd: root, stdio: "inherit", env: { ...process.env, SCOTTY_SPEC: "1" } },
);
process.exit(replay.status ?? 1);
