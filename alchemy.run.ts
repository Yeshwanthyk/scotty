import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Exit, Schema } from "effect";
import ScottyWorker from "./src/worker.js";

const image = process.env.SCOTTY_IMAGE;
const ownerEmail = process.env.SCOTTY_OWNER_EMAIL;
const stage = process.argv.find(
  (argument, index, arguments_) =>
    index > 0 && arguments_[index - 1] === "--stage" && argument !== "--stage",
);
if (Exit.isFailure(Schema.decodeUnknownExit(Schema.Literal("dev"))(stage)))
  throw new Error("Step 2 deploy requires explicit --stage dev");
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

export default Alchemy.Stack(
  "scotty",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* Cloudflare.R2.Bucket("SessionArtifacts");
    const worker = yield* ScottyWorker;
    return { url: worker.url.as<string>() };
  }),
);
