import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { monolithGreenfieldProgram } from "./spikes/infra/monolith-greenfield.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point reports missing operator metadata
    throw new Error(`Scotty deployment requires ${name}.`);
  }
  return value;
};

const accountId = required("SCOTTY_CLOUDFLARE_ACCOUNT_ID");
const providerAccountId = required("CLOUDFLARE_ACCOUNT_ID");
const absenceConfirmation = required("SCOTTY_CHUNK2_ABSENCE_CONFIRMED");
if (providerAccountId !== accountId) {
  // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point binds operator approval to the provider account
  throw new Error("Scotty deployment account does not match CLOUDFLARE_ACCOUNT_ID.");
}

export default Alchemy.Stack(
  "Scotty",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    return yield* monolithGreenfieldProgram({
      stage,
      telemetryDisabled: process.env.ALCHEMY_TELEMETRY_DISABLED === "1",
      accountId,
      absenceEvidence: {
        accountId,
        worker: absenceConfirmation === `absent:${accountId}:scotty-worker`,
        durableObject: absenceConfirmation === `absent:${accountId}:scotty-worker`,
        container: absenceConfirmation === `absent:${accountId}:scotty-worker`,
        kv: absenceConfirmation === `absent:${accountId}:scotty-worker`,
        r2: absenceConfirmation === `absent:${accountId}:scotty-worker`,
      },
      approval: process.env.SCOTTY_CHUNK2_APPROVE_GREENFIELD,
    });
  }),
);
