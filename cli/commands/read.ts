import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Conversation, View } from "../client.js";
import { output, sessionPath, url, usage, withClient } from "./common.js";

export const read = Command.make(
  "read",
  {
    url,
    id: Argument.String("id"),
    last: Flag.Int("last").pipe(Flag.withDefault(1)),
    role: Flag.Literals("role", ["user", "assistant"]).pipe(Flag.optional),
  },
  ({ url: target, id, last, role }) =>
    Effect.gen(function* () {
      if (last < 1 || last > 500)
        return yield* usage("--last must be an integer from 1 to 500", "read");
      const path = sessionPath(id);
      const api = yield* withClient(target);
      const view = yield* api(path, View);
      const conversation = yield* api(`${path}/conversation`, Conversation);
      const origin = Option.getOrElse(target, () => process.env.SCOTTY_URL ?? "");
      const latest = conversation.turns.at(-1);
      const messages = conversation.turns
        .flatMap((turn) => [
          { id: `${turn.id}:user`, role: "user", state: turn.state, text: turn.user },
          ...(turn.assistant === "" && turn.files.length === 0
            ? []
            : [
                {
                  id: `${turn.id}:assistant`,
                  role: "assistant",
                  state: turn.state,
                  text: turn.assistant,
                  files: turn.files.map(
                    (file) =>
                      `${file.name} (${file.type}, ${file.size} bytes) ${new URL(`${path}/files/${file.id}`, origin).href}`,
                  ),
                },
              ]),
        ])
        .filter((message) => Option.isNone(role) || message.role === role.value)
        .slice(-last);
      yield* output({
        id,
        authority: view.session.authority,
        turn: latest ? { id: latest.id, state: latest.state } : null,
        messages,
      });
    }),
).pipe(
  Command.withDescription(
    "Read a bounded conversation snapshot with current session and turn status",
  ),
);
