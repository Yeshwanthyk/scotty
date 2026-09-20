import { Clock, Data, Effect, Result, Schema } from "effect";
import type { RuntimeCliCompatibility } from "../../../protocol/runtime-cli-manifest";
import { RuntimeCliPinSchema, type RuntimeCliPin } from "../../../protocol/runtime-cli-pin";
import type { RuntimeCliReleaseResolver } from "./release-resolver";
import type { RuntimeCliCache } from "./cache";

const AuthoritySchema = Schema.Struct({
  issued: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  committed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pin: Schema.NullOr(RuntimeCliPinSchema),
});
type Authority = typeof AuthoritySchema.Type;
const decodeAuthority = Schema.decodeUnknownResult(AuthoritySchema, { onExcessProperty: "error" });
export class RuntimeCliSelectionFailure extends Data.TaggedError("RuntimeCliSelectionFailure")<{
  readonly reason: "storage" | "invalid_authority" | "no_cached_selection";
}> {}
export interface RuntimeCliSelectionStorage {
  readonly transaction: <A>(
    operation: (transaction: {
      readonly get: () => Promise<unknown>;
      readonly put: (value: Authority) => Promise<void>;
    }) => Promise<A>,
  ) => Promise<A>;
}
export const sameRuntimeCompatibility = (a: RuntimeCliCompatibility, b: RuntimeCliCompatibility) =>
  a.bunVersion === b.bunVersion &&
  a.compileTarget === b.compileTarget &&
  a.cpu === b.cpu &&
  a.libc === b.libc &&
  a.cloudflareSandbox.packageVersion === b.cloudflareSandbox.packageVersion &&
  a.cloudflareSandbox.image === b.cloudflareSandbox.image;

export const makeRuntimeCliSelection = (
  storage: RuntimeCliSelectionStorage,
  resolver: RuntimeCliReleaseResolver["Service"],
  cache: RuntimeCliCache["Service"],
) => {
  const transact = <A>(
    update: (value: Authority) => { readonly value: A; readonly authority: Authority },
  ) =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const raw = await transaction.get();
          const decoded =
            raw === undefined
              ? Result.succeed({ issued: 0, committed: 0, pin: null } satisfies Authority)
              : decodeAuthority(raw);
          if (Result.isFailure(decoded))
            return Result.fail(new RuntimeCliSelectionFailure({ reason: "invalid_authority" }));
          const next = update(decoded.success);
          await transaction.put(next.authority);
          return Result.succeed(next.value);
        }),
      catch: () => new RuntimeCliSelectionFailure({ reason: "storage" }),
    }).pipe(Effect.flatMap(Effect.fromResult));
  return {
    select: Effect.fnUntraced(function* (supported: RuntimeCliCompatibility) {
      const ticket = yield* transact((value) => ({
        value: value.issued + 1,
        authority: { ...value, issued: value.issued + 1 },
      }));
      const resolved = yield* resolver.resolve([supported]).pipe(
        Effect.map((value) => ({ release: value })),
        Effect.catchTag("RuntimeCliReleaseLookupError", (error) =>
          error.status === undefined ||
          error.status === 429 ||
          (error.status >= 500 && error.status <= 599)
            ? Effect.succeed({ release: undefined })
            : Effect.fail(error),
        ),
      );
      if (resolved.release === undefined) {
        const previous = yield* transact((value) => ({ value: value.pin, authority: value }));
        if (
          previous === null ||
          !sameRuntimeCompatibility(previous.descriptor.compatibility, supported)
        )
          return yield* new RuntimeCliSelectionFailure({ reason: "no_cached_selection" });
        // Caller must read the immutable object before admitting this selection. Never repair it.
        return { ...previous, freshness: "cached_during_lookup_outage" as const };
      }
      const ensured = yield* cache.ensure(resolved.release);
      const pin: RuntimeCliPin = {
        descriptor: ensured.release.descriptor,
        verifiedAt: yield* Clock.currentTimeMillis,
        freshness: "github_verified",
      };
      // A slower earlier lookup may finish, but cannot roll back a later committed selection.
      yield* transact((value) => ({
        value: undefined,
        authority: ticket > value.committed ? { ...value, committed: ticket, pin } : value,
      }));
      return pin;
    }),
  };
};
