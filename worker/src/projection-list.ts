import { Effect } from "effect";

export interface ProjectionPage {
  readonly keys: ReadonlyArray<string>;
  readonly cursor?: string;
}

interface ProjectionReader {
  readonly get: (key: string) => Promise<unknown | null>;
  readonly list: (cursor?: string) => Promise<ProjectionPage>;
}

interface ListProjectionValuesOptions<A, E> {
  readonly storage: ProjectionReader;
  readonly decode: (key: string, value: unknown) => A | undefined;
  readonly compare: (left: A, right: A) => number;
  readonly onGetError: (cause: unknown) => E;
  readonly onListError: (cause: unknown) => E;
}

export const listProjectionValues = Effect.fnUntraced(function* <A, E>(
  options: ListProjectionValuesOptions<A, E>,
): Effect.fn.Return<Array<A>, E> {
  const projections: Array<A> = [];
  let cursor: string | undefined;
  do {
    const page = yield* Effect.tryPromise({
      try: () => options.storage.list(cursor),
      catch: options.onListError,
    });
    const values = yield* Effect.all(
      page.keys.map((key) =>
        Effect.tryPromise({
          try: () => options.storage.get(key),
          catch: options.onGetError,
        }).pipe(Effect.map((value) => options.decode(key, value))),
      ),
      { concurrency: "unbounded" },
    );
    for (const value of values) {
      if (value !== undefined) projections.push(value);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);

  projections.sort(options.compare);
  return projections;
});
