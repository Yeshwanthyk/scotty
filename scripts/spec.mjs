import { spawn } from "node:child_process";
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
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => done({ status: null, output, error }));
    child.on("close", (status) => done({ status, output }));
  });
const models = [
  {
    file: "spec/quint/session_lease.qnt",
    invariants: ["safety"],
    witnesses: [
      "reachesWarm",
      "reachesGone",
      "reachesFailed",
      "reachesPreemptedCreate",
      "reachesVaporizeReconciling",
      "reachesStaleRedelivery",
    ],
  },
];

for (const model of models) {
  const typecheck = await execute(["typecheck", model.file]);
  if (typecheck.status !== 0) {
    console.error(`${model.file}: quint typecheck failed (${typecheck.status ?? typecheck.error})`);
    process.exit(1);
  }
  const run = await execute([
    "run",
    model.file,
    "--backend",
    "typescript",
    "--invariants",
    ...model.invariants,
    "--witnesses",
    ...model.witnesses,
    "--max-steps",
    "40",
    "--max-samples",
    "500",
    "--seed",
    "1",
  ]);
  if (run.status !== 0) {
    console.error(`${model.file}: quint run failed (${run.status ?? run.error})`);
    process.exit(1);
  }
  for (const witness of model.witnesses) {
    const line = run.output
      .split(/\r?\n/)
      .find((entry) => entry.startsWith(`${witness} was witnessed in `));
    const count = line?.match(/was witnessed in (\d+) trace\(s\) out of/);
    if (count === null || count === undefined || Number(count[1]) === 0) {
      console.error(`${model.file}: witness ${witness} was missing or reached in zero traces`);
      process.exit(1);
    }
  }
  console.log(`${model.file}: safety passed; all ${model.witnesses.length} witnesses reached`);
}
