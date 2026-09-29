import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Exit, Schema } from "effect";
import { SessionArtifacts } from "./src/session/object.js";
import ScottyWorker from "./src/worker.js";

const image = process.env.SCOTTY_IMAGE;
const ownerEmail = process.env.SCOTTY_OWNER_EMAIL;
const hatchBase = process.env.SCOTTY_HATCH_BASE;
const hatchZoneId = process.env.SCOTTY_HATCH_ZONE_ID;
const host = process.env.SCOTTY_HOST;
const stage = process.argv.find(
  (argument, index, arguments_) =>
    index > 0 && arguments_[index - 1] === "--stage" && argument !== "--stage",
);
// Every resource is named `scotty-<stage>…`, so the stage is always given, never a default.
if (
  Exit.isFailure(
    Schema.decodeUnknownExit(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,19}$/)))(
      stage,
    ),
  )
)
  throw new Error("Deploy requires an explicit --stage (lowercase, at most 20 characters)");
if (
  Exit.isFailure(Schema.decodeUnknownExit(Schema.String.check(Schema.isMinLength(1)))(ownerEmail))
)
  throw new Error("SCOTTY_OWNER_EMAIL is required");
if (
  Exit.isFailure(
    Schema.decodeUnknownExit(
      Schema.String.check(
        Schema.isPattern(/^registry\.cloudflare\.com\/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$/),
      ),
    )(image),
  )
)
  throw new Error("SCOTTY_IMAGE must be a prepushed Cloudflare registry digest reference");
const HatchBase = Schema.String.check(Schema.isPattern(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/));
const ZoneId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const base = Schema.decodeUnknownExit(HatchBase)(hatchBase);
const zoneId = Schema.decodeUnknownExit(ZoneId)(hatchZoneId);
if (Exit.isFailure(base) || Exit.isFailure(zoneId))
  throw new Error("SCOTTY_HATCH_BASE and SCOTTY_HATCH_ZONE_ID (32 hex) are required");
// The Worker's own host, in the same zone. The preview route below matches it too; the Worker
// tells them apart by name, and a preview-shaped host would be ambiguous.
if (
  Exit.isFailure(Schema.decodeUnknownExit(HatchBase)(host)) ||
  !host?.endsWith(`.${base.value}`) ||
  /^\d{1,5}-[a-z0-9-]{6,32}\./.test(host)
)
  throw new Error("SCOTTY_HOST must be a host under SCOTTY_HATCH_BASE, not a preview host");

export default Alchemy.Stack(
  "scotty",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* SessionArtifacts;
    const worker = yield* ScottyWorker;
    // Preview hosts `<port>-<id>.<base>`. Both may already exist from an earlier deploy, so
    // they are adopted; the route moves to this Worker.
    yield* Cloudflare.DNS.Record("HatchWildcard", {
      zoneId: zoneId.value,
      name: `*.${base.value}`,
      type: "AAAA",
      content: "100::",
      proxied: true,
    }).pipe(Alchemy.AdoptPolicy.adopt(true));
    yield* Cloudflare.WorkerRoute("HatchRoute", {
      zoneId: zoneId.value,
      pattern: `*.${base.value}/*`,
      script: worker.workerName,
    }).pipe(Alchemy.AdoptPolicy.adopt(true));
    return { url: worker.url.as<string>() };
  }),
);
