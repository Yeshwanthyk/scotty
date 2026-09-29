import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Effect, Exit, Schema } from "effect";
import { Config } from "../cli/config.js";
import { root } from "../cli/commands/deploy.js";
import { leftovers } from "../deploy/cloudflare.js";

// Runs `scotty init` as the owner does, in a terminal, on a stage of its own: stops it with Ctrl-C
// mid-deploy, runs it again until the address is live, checks that a second stage may not take
// the address over, then tears the stage down. Its domain must have no other stage on it.
//
//   npm run e2e -- init --stage <name>

// Bun's pty; the repository has no Bun types.
declare const Bun: {
  spawn(
    command: ReadonlyArray<string>,
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      terminal: { cols: number; rows: number; data(terminal: unknown, data: Uint8Array): void };
    },
  ): {
    readonly terminal: { write(data: string): void };
    readonly exited: Promise<number>;
    kill(): void;
  };
};

const Args = Schema.Tuple([Schema.Literal("--stage"), Config.fields.stage]);
const args = Schema.decodeUnknownExit(Args)(process.argv.slice(3));
if (Exit.isFailure(args)) throw new Error("Usage: npm run e2e -- init --stage <name>");
const stage = args.value[1];
if (stage === "dev") throw new Error("Stage dev is the shared test stage; pick another name");

const Env = Schema.Struct({
  SCOTTY_OWNER_EMAIL: Config.fields.email,
  CLOUDFLARE_ACCOUNT_ID: Config.fields.accountId,
  SCOTTY_HATCH_BASE: Config.fields.domain,
  SCOTTY_HATCH_ZONE_ID: Config.fields.zoneId,
});
const env = Schema.decodeUnknownExit(Env)(process.env);
if (Exit.isFailure(env))
  throw new Error(
    "Set SCOTTY_OWNER_EMAIL, CLOUDFLARE_ACCOUNT_ID, SCOTTY_HATCH_BASE and SCOTTY_HATCH_ZONE_ID",
  );
const config: Config = {
  stage,
  email: env.value.SCOTTY_OWNER_EMAIL,
  accountId: env.value.CLOUDFLARE_ACCOUNT_ID,
  domain: env.value.SCOTTY_HATCH_BASE,
  zoneId: env.value.SCOTTY_HATCH_ZONE_ID,
  host: `scotty-${stage}.${env.value.SCOTTY_HATCH_BASE}`,
};

const folder = mkdtempSync(join(tmpdir(), "scotty-init-"));
const configFile = join(folder, "config.json");
writeFileSync(configFile, JSON.stringify(config));
// Access sign-in opens a browser for a person, so cloudflared here always declines; init then
// stops right after the address is live.
writeFileSync(join(folder, "cloudflared"), "#!/bin/sh\nexit 1\n");
chmodSync(join(folder, "cloudflared"), 0o755);
const childEnv = (file: string) => ({
  ...process.env,
  SCOTTY_CONFIG: file,
  PATH: [folder, process.env.PATH ?? ""].join(delimiter),
});

const say = (text: string) => console.error(`· ${text}`);
const check = (ok: boolean, message: string, screen: string) => {
  if (!ok) throw new Error(`${message}\n--- screen ---\n${screen.slice(-3000)}`);
};

// One init in a terminal: answers each prompt as it appears and reports what the screen showed.
const run = async (
  file: string,
  answers: ReadonlyArray<readonly [prompt: string, keys: string]>,
  stopAt?: { readonly text: ReadonlyArray<string>; readonly keys?: string },
) => {
  let screen = "";
  let next = 0;
  let stopped = false;
  const child = Bun.spawn(["bun", "cli/main.ts", "init"], {
    cwd: root,
    env: childEnv(file),
    terminal: {
      cols: 120,
      rows: 40,
      data: (_, data) => {
        screen += stripVTControlCharacters(new TextDecoder().decode(data));
        const answer = answers[next];
        if (answer !== undefined && screen.includes(answer[0])) {
          next += 1;
          say(`${answer[0]} → ${JSON.stringify(answer[1])}`);
          setTimeout(() => child.terminal.write(answer[1]), 300);
        }
        if (!stopped && stopAt !== undefined && stopAt.text.some((text) => screen.includes(text))) {
          stopped = true;
          if (stopAt.keys === undefined) child.kill();
          else child.terminal.write(stopAt.keys);
        }
      },
    },
  });
  const code = await child.exited;
  return { code, screen };
};

const answers = [
  ["Use these settings?", "\r"],
  ["Which agents", "\r"],
  ["Deploy now?", "\r"],
] as const;

const teardown = async () => {
  say(`Tearing down scotty-${stage}`);
  const child = Bun.spawn(["bun", "cli/main.ts", "teardown", "--stage", stage], {
    cwd: root,
    env: childEnv(configFile),
    terminal: { cols: 120, rows: 40, data: (_, data) => process.stderr.write(data) },
  });
  return child.exited;
};

let deployed = false;
try {
  say(`Init for scotty-${stage}, stopped with Ctrl-C once the deploy is under way`);
  const first = await run(configFile, answers, { text: ["· Setting up"], keys: "\u0003" });
  deployed = true;
  check(first.code === 130, `Ctrl-C ended init with ${first.code}, not 130`, first.screen);
  check(
    first.screen.includes("picks up where this stopped"),
    "Ctrl-C did not say how to go on",
    first.screen,
  );

  say("Init again, until the address is live");
  const second = await run(configFile, answers, {
    text: ["Waiting for this Mac's DNS cache"],
  });
  check(
    second.screen.includes(`https://${config.host} is live`) ||
      second.screen.includes("Waiting for this Mac's DNS cache"),
    `https://${config.host} did not come up`,
    second.screen,
  );
  check(
    second.screen.includes(`Deployed scotty-${stage}`),
    "The deploy did not finish",
    second.screen,
  );

  say("A second stage may not take the address over");
  const otherFile = join(folder, "other.json");
  writeFileSync(otherFile, JSON.stringify({ ...config, stage: `${stage.slice(0, 18)}-b` }));
  const other = await run(otherFile, [["Use these settings?", "\r"]]);
  check(other.code === 2, `A second stage ended with ${other.code}, not 2`, other.screen);
  check(other.screen.includes("is already in use"), "A second stage was not refused", other.screen);
} finally {
  // Failures here are reported, not thrown, so they cannot hide why the test failed.
  if (deployed) {
    if ((await teardown()) !== 0) {
      process.exitCode = 1;
      console.error(
        `✗ Teardown of scotty-${stage} failed; run it again with SCOTTY_CONFIG=${configFile}`,
      );
    }
    // A deploy stopped by Ctrl-C must not go on creating things after the teardown.
    const left = await Effect.runPromise(leftovers(config.accountId, stage));
    if (left.length > 0) {
      process.exitCode = 1;
      console.error(`✗ Still in Cloudflare after teardown: ${left.join(", ")}`);
    }
  }
}
if (process.exitCode === undefined) say(`init passed for scotty-${stage}`);
