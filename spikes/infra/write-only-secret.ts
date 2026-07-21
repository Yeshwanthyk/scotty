import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type Resource as AlchemyResource } from "alchemy/Resource";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export const WRITE_ONLY_SECRET_PROVIDER_VERSION = 1;

export interface WriteOnlySecretProps {
  readonly sourceId: string;
  readonly accountId: string;
  readonly scriptName: string;
  readonly bindingName: string;
  readonly providerVersion: number;
  readonly keyedDigest: string;
}

export interface WriteOnlySecretAttributes extends WriteOnlySecretProps {
  readonly ownerReference: string;
}

export interface WriteOnlySecretResource extends AlchemyResource<
  "Scotty.WriteOnlySecret",
  WriteOnlySecretProps,
  WriteOnlySecretAttributes
> {}

export const WriteOnlySecret = Resource<WriteOnlySecretResource>("Scotty.WriteOnlySecret");

export class WriteOnlySecretFailure extends Data.TaggedError("WriteOnlySecretFailure")<{
  readonly operation: "read" | "resolve" | "write" | "delete";
  readonly code:
    | "destination-failure"
    | "digest-mismatch"
    | "foreign-owner"
    | "source-failure"
    | "write-verification-failure";
  readonly sourceId: string;
  readonly destinationReference: string;
}> {}

export interface SecretSnapshot {
  readonly plaintext: string;
  readonly keyedDigest: string;
}

export class SecretSource extends Context.Service<
  SecretSource,
  {
    readonly resolve: (sourceId: string) => Effect.Effect<SecretSnapshot, unknown>;
  }
>()("Scotty/SecretSource") {}

export interface DestinationKey {
  readonly accountId: string;
  readonly scriptName: string;
  readonly bindingName: string;
}

export class WriteOnlySecretDestination extends Context.Service<
  WriteOnlySecretDestination,
  {
    readonly read: (
      key: DestinationKey,
    ) => Effect.Effect<WriteOnlySecretAttributes | undefined, unknown>;
    readonly write: (
      key: DestinationKey,
      value: {
        readonly plaintext: string;
        readonly metadata: WriteOnlySecretAttributes;
      },
    ) => Effect.Effect<WriteOnlySecretAttributes, unknown>;
    readonly delete: (key: DestinationKey, ownerReference: string) => Effect.Effect<void, unknown>;
  }
>()("Scotty/WriteOnlySecretDestination") {}

const destinationKey = (props: WriteOnlySecretProps): DestinationKey => ({
  accountId: props.accountId,
  scriptName: props.scriptName,
  bindingName: props.bindingName,
});

const destinationReference = (props: WriteOnlySecretProps): string =>
  `${props.accountId}/${props.scriptName}/${props.bindingName}`;

const ownerReference = (fqn: string, instanceId: string): string => `${fqn}#${instanceId}`;

const failure = (
  operation: WriteOnlySecretFailure["operation"],
  code: WriteOnlySecretFailure["code"],
  props: WriteOnlySecretProps,
): WriteOnlySecretFailure =>
  new WriteOnlySecretFailure({
    operation,
    code,
    sourceId: props.sourceId,
    destinationReference: destinationReference(props),
  });

const sameDestination = (left: WriteOnlySecretProps, right: WriteOnlySecretProps): boolean =>
  left.accountId === right.accountId &&
  left.scriptName === right.scriptName &&
  left.bindingName === right.bindingName;

const sameMaterial = (
  attributes: WriteOnlySecretAttributes,
  props: WriteOnlySecretProps,
): boolean =>
  sameDestination(attributes, props) &&
  attributes.sourceId === props.sourceId &&
  attributes.providerVersion === props.providerVersion &&
  attributes.keyedDigest === props.keyedDigest;

const projectAttributes = (attributes: WriteOnlySecretAttributes): WriteOnlySecretAttributes => ({
  sourceId: attributes.sourceId,
  accountId: attributes.accountId,
  scriptName: attributes.scriptName,
  bindingName: attributes.bindingName,
  providerVersion: attributes.providerVersion,
  keyedDigest: attributes.keyedDigest,
  ownerReference: attributes.ownerReference,
});

const readDestination = Effect.fnUntraced(function* (props: WriteOnlySecretProps) {
  const destination = yield* WriteOnlySecretDestination;
  const attributes = yield* destination
    .read(destinationKey(props))
    .pipe(Effect.catch(() => Effect.fail(failure("read", "destination-failure", props))));
  return attributes === undefined ? undefined : projectAttributes(attributes);
});

export const writeOnlySecretProvider = Provider.succeed(
  WriteOnlySecret,
  WriteOnlySecret.Provider.of({
    version: WRITE_ONLY_SECRET_PROVIDER_VERSION,
    list: () => Effect.succeed([]),
    read: Effect.fnUntraced(function* ({ fqn, instanceId, olds }) {
      const live = yield* readDestination(olds);
      if (live === undefined) return undefined;
      return live.ownerReference === ownerReference(fqn, instanceId) ? live : Unowned(live);
    }),
    diff: Effect.fnUntraced(function* ({ fqn, instanceId, news, olds }) {
      if (!isResolved(news)) return undefined;
      if (!sameDestination(olds, news)) {
        return { action: "replace" };
      }
      if (
        olds.sourceId !== news.sourceId ||
        olds.providerVersion !== news.providerVersion ||
        olds.keyedDigest !== news.keyedDigest
      ) {
        return { action: "update" };
      }
      const live = yield* readDestination(news);
      if (live === undefined) return { action: "update" };
      if (live.ownerReference !== ownerReference(fqn, instanceId)) {
        // Planning cannot distinguish explicit adoption from ownership drift.
        // Force reconcile: adoption may claim it, while managed updates fail closed.
        return { action: "update" };
      }
      return sameMaterial(live, news) ? { action: "noop" } : { action: "update" };
    }),
    reconcile: Effect.fnUntraced(function* ({ fqn, instanceId, news, output }) {
      const expectedOwner = ownerReference(fqn, instanceId);
      const live = yield* readDestination(news);
      const isAdoption =
        live !== undefined &&
        output?.ownerReference === live.ownerReference &&
        output.ownerReference !== expectedOwner;
      if (live !== undefined && live.ownerReference !== expectedOwner && !isAdoption) {
        return yield* Effect.fail(failure("write", "foreign-owner", news));
      }
      if (live !== undefined && live.ownerReference === expectedOwner && sameMaterial(live, news)) {
        return live;
      }

      const source = yield* SecretSource;
      const destination = yield* WriteOnlySecretDestination;
      const snapshot = yield* source
        .resolve(news.sourceId)
        .pipe(Effect.catch(() => Effect.fail(failure("resolve", "source-failure", news))));
      if (snapshot.keyedDigest !== news.keyedDigest) {
        return yield* Effect.fail(failure("resolve", "digest-mismatch", news));
      }

      const metadata: WriteOnlySecretAttributes = {
        sourceId: news.sourceId,
        accountId: news.accountId,
        scriptName: news.scriptName,
        bindingName: news.bindingName,
        providerVersion: news.providerVersion,
        keyedDigest: news.keyedDigest,
        ownerReference: expectedOwner,
      };
      const written = yield* destination
        .write(destinationKey(news), {
          plaintext: snapshot.plaintext,
          metadata,
        })
        .pipe(Effect.catch(() => Effect.fail(failure("write", "destination-failure", news))));
      if (written.ownerReference !== expectedOwner || !sameMaterial(written, news)) {
        return yield* Effect.fail(failure("write", "write-verification-failure", news));
      }
      return metadata;
    }),
    delete: Effect.fnUntraced(function* ({ fqn, instanceId, output, olds }) {
      const expectedOwner = ownerReference(fqn, instanceId);
      const live = yield* readDestination(olds);
      if (live === undefined) return;
      if (output.ownerReference !== expectedOwner || live.ownerReference !== expectedOwner) {
        return yield* Effect.fail(failure("delete", "foreign-owner", olds));
      }
      const destination = yield* WriteOnlySecretDestination;
      return yield* destination
        .delete(destinationKey(olds), expectedOwner)
        .pipe(Effect.catch(() => Effect.fail(failure("delete", "destination-failure", olds))));
    }),
  }),
);
