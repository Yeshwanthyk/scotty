import { createHmac, timingSafeEqual } from "node:crypto";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type Resource as AlchemyResource } from "alchemy/Resource";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

/**
 * Cloudflare Account Secrets Store destination adapter for Scotty M01B.
 *
 * The resource persists only stable Account Secrets Store identifiers
 * (storeId, secretId, secretName), a keyed digest of the trusted plaintext,
 * and an authenticated, versioned ownership marker embedded in the secret's
 * `comment` field. The plaintext value is resolved from a trusted
 * {@link SecretSource} inside `reconcile` immediately before a destination
 * POST/PATCH and never enters Alchemy props, news, attributes, plans, outputs,
 * state, errors, logs, telemetry, or bundles.
 *
 * Mutations target the exact persisted secretId (read/update/delete). There
 * are no remote plaintext digest or CAS assumptions: the only digest is the
 * local keyed digest signed into the ownership marker. Mutation retries are
 * disabled; ambiguous write/interruption recovery re-resolves the trusted
 * source and idempotently PATCHes the exact ID until one unambiguous success
 * plus an active observation. Foreign/unowned adoption fails closed because
 * pinned Alchemy beta.63 cannot carry current-run adoption authorization into
 * reconciliation without persisting it. Delete never resolves plaintext and
 * only deletes the persisted exact ID after owner/marker verification.
 */
export const WRITE_ONLY_SECRET_PROVIDER_VERSION = 1;

/** Conservative Scotty cap pending verification against the live beta API. */
export const SECRET_VALUE_MAX_BYTES = 1024;

/** Authorized scope for a Scotty-managed store secret. */
export const SECRET_SCOPES: readonly ["workers"] = ["workers"];

export type SecretStatus = "pending" | "active" | "deleted";

/**
 * Desired state. Identifier-only: the trusted source id, the stable Account
 * Secrets Store coordinates, the identifier-only Worker binding name, the
 * provider version, and a keyed digest of the plaintext. Never the value.
 */
export interface WriteOnlySecretProps {
  readonly sourceId: string;
  readonly accountId: string;
  readonly storeId: string;
  readonly secretName: string;
  readonly bindingName: string;
  readonly providerVersion: number;
  readonly keyedDigest: string;
}

/**
 * Persisted output attributes. Adds the stable Cloudflare-assigned secretId,
 * activation status, scopes, and the Scotty owner reference. Never the value.
 */
export interface WriteOnlySecretAttributes extends WriteOnlySecretProps {
  readonly secretId: string;
  readonly status: SecretStatus;
  readonly scopes: readonly string[];
  readonly ownerReference: string;
}

export interface WriteOnlySecretResource extends AlchemyResource<
  "Scotty.WriteOnlySecret",
  WriteOnlySecretProps,
  WriteOnlySecretAttributes
> {}

export const WriteOnlySecret = Resource<WriteOnlySecretResource>("Scotty.WriteOnlySecret");

/**
 * Sanitized provider failure. Carries only identifiers and a coarse code;
 * never the plaintext, the destination request body, or the raw response.
 */
export class WriteOnlySecretFailure extends Data.TaggedError("WriteOnlySecretFailure")<{
  readonly operation: "read" | "resolve" | "write" | "delete";
  readonly code:
    | "destination-failure"
    | "digest-mismatch"
    | "foreign-owner"
    | "source-failure"
    | "value-too-large"
    | "write-verification-failure";
  readonly sourceId: string;
  readonly storeId: string;
  readonly secretId: string | undefined;
  readonly secretName: string;
}> {}

/**
 * Structured failure from the destination adapter boundary. The adapter must
 * surface 404 (read/delete) and 409 (create collision) as typed codes so the
 * provider can recover without trusting raw response text.
 */
export class WriteOnlySecretDestinationError extends Data.TaggedError(
  "WriteOnlySecretDestinationError",
)<{
  readonly operation: "read" | "find" | "create" | "patch" | "delete";
  readonly code: "not-found" | "conflict" | "destination-failure";
  readonly accountId: string;
  readonly storeId: string;
  readonly secretId: string | undefined;
}> {}

export interface SecretSnapshot {
  readonly plaintext: string;
  readonly keyedDigest: string;
}

/** Trusted plaintext source. Resolved only inside reconcile. */
export class SecretSource extends Context.Service<
  SecretSource,
  {
    readonly resolve: (sourceId: string) => Effect.Effect<SecretSnapshot, unknown>;
  }
>()("Scotty/SecretSource") {}

/** Key used to authenticate the ownership marker. Scotty-only in production. */
export class SecretOwnerKey extends Context.Service<
  SecretOwnerKey,
  {
    readonly key: Uint8Array;
  }
>()("Scotty/SecretOwnerKey") {}

/** Metadata returned by the destination adapter. The value is never returned. */
export interface SecretMetadata {
  readonly secretId: string;
  readonly secretName: string;
  readonly storeId: string;
  readonly accountId: string;
  readonly status: SecretStatus;
  readonly scopes: readonly string[];
  readonly comment: string | undefined;
}

export interface DestinationAccountKey {
  readonly accountId: string;
  readonly storeId: string;
}

export interface DestinationSecretKey extends DestinationAccountKey {
  readonly secretId: string;
}

/**
 * Injectable Account Secrets Store adapter. All external HTTP/API lives
 * behind this service; local tests provide a synthetic/fake implementation
 * and never touch Cloudflare auth or mutation.
 */
export class WriteOnlySecretDestination extends Context.Service<
  WriteOnlySecretDestination,
  {
    /** GET .../secrets/{secretId}; 404 → undefined (typed not-found). */
    readonly read: (
      key: DestinationSecretKey,
    ) => Effect.Effect<SecretMetadata | undefined, unknown>;
    /** List store secrets filtered by name (recovery when secretId unknown). */
    readonly find: (
      key: DestinationAccountKey & {
        readonly secretName: string;
      },
    ) => Effect.Effect<SecretMetadata | undefined, unknown>;
    /** POST .../secrets; 409 → WriteOnlySecretDestinationError conflict. */
    readonly create: (
      key: DestinationAccountKey,
      body: {
        readonly name: string;
        readonly value: string;
        readonly scopes: readonly string[];
        readonly comment: string;
      },
    ) => Effect.Effect<SecretMetadata, unknown>;
    /** PATCH .../secrets/{secretId} exact ID. */
    readonly patch: (
      key: DestinationSecretKey,
      body: {
        readonly value: string;
        readonly scopes: readonly string[];
        readonly comment: string;
      },
    ) => Effect.Effect<SecretMetadata, unknown>;
    /** DELETE .../secrets/{secretId} exact ID; 404 → typed not-found. */
    readonly delete: (key: DestinationSecretKey) => Effect.Effect<void, unknown>;
  }
>()("Scotty/WriteOnlySecretDestination") {}

const MARKER_PREFIX = "scotty:v1";
const MARKER_DELIMITER = ";";

const ownerReference = (fqn: string, instanceId: string): string => `${fqn}#${instanceId}`;

const failure = (
  operation: WriteOnlySecretFailure["operation"],
  code: WriteOnlySecretFailure["code"],
  props: WriteOnlySecretProps,
  secretId: string | undefined,
): WriteOnlySecretFailure =>
  new WriteOnlySecretFailure({
    operation,
    code,
    sourceId: props.sourceId,
    storeId: props.storeId,
    secretId,
    secretName: props.secretName,
  });

const isDestinationError = (error: unknown): error is WriteOnlySecretDestinationError =>
  Predicate.isTagged(error, "WriteOnlySecretDestinationError");

/**
 * Validates that destination metadata matches the expected identity. A
 * buggy or malicious adapter that returns metadata for a different secret
 * must not be trusted. Returns false if account/store/name/secretId do not
 * match the request.
 */
const metadataMatchesKey = (
  metadata: SecretMetadata,
  expected: {
    readonly accountId: string;
    readonly storeId: string;
    readonly secretId?: string;
    readonly secretName?: string;
  },
): boolean =>
  metadata.secretId.length > 0 &&
  metadata.accountId === expected.accountId &&
  metadata.storeId === expected.storeId &&
  (expected.secretId === undefined || metadata.secretId === expected.secretId) &&
  (expected.secretName === undefined || metadata.secretName === expected.secretName);

/**
 * Authenticated, versioned ownership marker stored in the secret `comment`.
 * Format: `scotty:v1;owner=<ownerReference>;digest=<keyedDigest>;ver=<n>;sig=<hex>`
 * where `sig` is an HMAC-SHA256 over the prefix, owner, digest, and version.
 */
export const buildOwnerMarker = (
  ownerRef: string,
  keyedDigest: string,
  providerVersion: number,
  key: Uint8Array,
): string => {
  const sig = createHmac("sha256", key)
    .update(`${MARKER_PREFIX}\0${ownerRef}\0${keyedDigest}\0${providerVersion}`)
    .digest("hex");
  return `${MARKER_PREFIX}${MARKER_DELIMITER}owner=${ownerRef}${MARKER_DELIMITER}digest=${keyedDigest}${MARKER_DELIMITER}ver=${providerVersion}${MARKER_DELIMITER}sig=${sig}`;
};

export interface OwnerMarkerVerification {
  readonly authentic: boolean;
  readonly ownerReference: string | undefined;
  readonly keyedDigest: string | undefined;
  readonly providerVersion: number | undefined;
}

/**
 * Verifies an ownership marker read from a remote comment. Returns
 * `authentic: true` only when the HMAC signature validates, proving Scotty
 * authored the marker. Malformed or tampered markers are not authentic.
 */
export const verifyOwnerMarker = (
  comment: string | undefined,
  key: Uint8Array,
): OwnerMarkerVerification => {
  const rejected = {
    authentic: false,
    ownerReference: undefined,
    keyedDigest: undefined,
    providerVersion: undefined,
  } as const;
  if (comment === undefined) return rejected;
  // Strict canonical format: exactly five ordered fields separated by ";".
  // scotty:v1;owner=<ref>;digest=<hex>;ver=<int>;sig=<64-hex>
  // Reject unknown segments, duplicates, non-canonical integers, and
  // signatures that are not 64 lowercase hex characters.
  const segments = comment.split(MARKER_DELIMITER);
  if (segments.length !== 5) return rejected;
  if (segments[0] !== MARKER_PREFIX) return rejected;
  const parseField = (segment: string, name: string): string | undefined => {
    const equals = segment.indexOf("=");
    if (equals <= 0) return undefined;
    if (segment.slice(0, equals) !== name) return undefined;
    return segment.slice(equals + 1);
  };
  const ownerReference = parseField(segments[1] ?? "", "owner");
  if (ownerReference === undefined || ownerReference.length === 0) return rejected;
  const keyedDigest = parseField(segments[2] ?? "", "digest");
  if (keyedDigest === undefined || keyedDigest.length === 0) return rejected;
  const verString = parseField(segments[3] ?? "", "ver");
  if (verString === undefined || !/^[1-9][0-9]*$/u.test(verString)) return rejected;
  const providerVersion = Number.parseInt(verString, 10);
  if (!Number.isFinite(providerVersion)) return rejected;
  const sig = parseField(segments[4] ?? "", "sig");
  if (sig === undefined || !/^[0-9a-f]{64}$/u.test(sig)) return rejected;
  const expected = createHmac("sha256", key)
    .update(`${MARKER_PREFIX}\0${ownerReference}\0${keyedDigest}\0${providerVersion}`)
    .digest("hex");
  const authentic =
    expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  if (!authentic) return rejected;
  return {
    authentic: true,
    ownerReference,
    keyedDigest,
    providerVersion,
  };
};

const sameDestination = (
  left: Pick<WriteOnlySecretProps, "accountId" | "storeId" | "secretName">,
  right: Pick<WriteOnlySecretProps, "accountId" | "storeId" | "secretName">,
): boolean =>
  left.accountId === right.accountId &&
  left.storeId === right.storeId &&
  left.secretName === right.secretName;

type OwnedClassification = "ours" | "foreign" | "unowned";

interface ObservedSecret {
  readonly metadata: SecretMetadata;
  readonly marker: OwnerMarkerVerification;
}

const classifyObserved = (observed: ObservedSecret, expectedOwner: string): OwnedClassification => {
  if (!observed.marker.authentic) return "unowned";
  return observed.marker.ownerReference === expectedOwner ? "ours" : "foreign";
};

/**
 * Convergence predicate: the live secret is active, carries our authentic
 * marker with the desired digest and provider version, and has exactly the
 * `workers` scope. Used by `diff` (noop), `reconcile` (no-op reprojection
 * without source resolve), and post-write verification.
 */
const isConverged = (
  observed: ObservedSecret,
  news: WriteOnlySecretProps,
  expectedOwner: string,
): boolean => {
  if (observed.metadata.status !== "active") return false;
  if (!observed.marker.authentic) return false;
  if (observed.marker.ownerReference !== expectedOwner) return false;
  if (observed.marker.keyedDigest !== news.keyedDigest) return false;
  if (observed.marker.providerVersion !== news.providerVersion) return false;
  if (observed.metadata.scopes.length !== SECRET_SCOPES.length) return false;
  return observed.metadata.scopes.every((scope, index) => scope === SECRET_SCOPES[index]);
};

const observeSecret = Effect.fnUntraced(function* (
  props: WriteOnlySecretProps,
  output: WriteOnlySecretAttributes | undefined,
  markerKey: Uint8Array,
) {
  const destination = yield* WriteOnlySecretDestination;
  const accountKey: DestinationAccountKey = {
    accountId: props.accountId,
    storeId: props.storeId,
  };
  const fromMetadata = (metadata: SecretMetadata): ObservedSecret => ({
    metadata,
    marker: verifyOwnerMarker(metadata.comment, markerKey),
  });
  if (output?.secretId !== undefined) {
    // Exact-ID read: a 404 means the persisted secret is gone (out-of-band
    // delete or state loss). Do NOT fall back to find-by-name — that could
    // target a different secret with the same name. Return undefined so
    // reconcile creates fresh and delete is a no-op.
    return yield* Effect.suspend(() =>
      destination.read({ ...accountKey, secretId: output.secretId }),
    ).pipe(
      Effect.flatMap((metadata) => {
        if (metadata === undefined) return Effect.succeed(undefined);
        // Identity check: the adapter must return metadata for the exact
        // secret we requested. A mismatch is a protocol violation.
        if (
          !metadataMatchesKey(metadata, {
            ...accountKey,
            secretId: output.secretId,
            secretName: props.secretName,
          })
        ) {
          return Effect.fail(failure("read", "destination-failure", props, output.secretId));
        }
        return Effect.succeed(fromMetadata(metadata));
      }),
      Effect.catch((error) =>
        isDestinationError(error) && error.code === "not-found"
          ? Effect.succeed(undefined)
          : Effect.fail(failure("read", "destination-failure", props, output.secretId)),
      ),
      Effect.catchDefect(() =>
        Effect.fail(failure("read", "destination-failure", props, output.secretId)),
      ),
    );
  }
  // No persisted ID: initial discovery by name only.
  const byName = yield* Effect.suspend(() =>
    destination.find({ ...accountKey, secretName: props.secretName }),
  ).pipe(
    Effect.catch(() => Effect.fail(failure("read", "destination-failure", props, undefined))),
    Effect.catchDefect(() => Effect.fail(failure("read", "destination-failure", props, undefined))),
  );
  if (byName === undefined) return undefined;
  // Identity check for name lookup: account/store/name must match.
  if (!metadataMatchesKey(byName, { ...accountKey, secretName: props.secretName })) {
    return yield* Effect.fail(failure("read", "destination-failure", props, undefined));
  }
  return fromMetadata(byName);
});

const waitForActive = Effect.fnUntraced(function* (
  key: DestinationSecretKey,
  initial: SecretMetadata,
) {
  if (initial.status === "active") return initial;
  if (initial.status === "deleted") {
    return yield* Effect.fail(
      new WriteOnlySecretFailure({
        operation: "write",
        code: "write-verification-failure",
        sourceId: "",
        storeId: key.storeId,
        secretId: key.secretId,
        secretName: "",
      }),
    );
  }
  const destination = yield* WriteOnlySecretDestination;
  // Read-only observation poll (bounded). This is NOT a mutation retry.
  // Stop on active OR deleted; deleted fails immediately after the loop.
  const pollFailure = new WriteOnlySecretFailure({
    operation: "write",
    code: "write-verification-failure",
    sourceId: "",
    storeId: key.storeId,
    secretId: key.secretId,
    secretName: "",
  });
  const polled = yield* Effect.suspend(() => destination.read(key)).pipe(
    Effect.map((metadata) => {
      if (metadata === undefined) return initial;
      // Identity check: poll response must match the exact requested ID.
      if (
        !metadataMatchesKey(metadata, {
          ...key,
          secretName: initial.secretName,
        })
      )
        return initial;
      return metadata;
    }),
    Effect.repeat({
      schedule: Schedule.spaced("20 millis"),
      until: (metadata) => metadata.status === "active" || metadata.status === "deleted",
      times: 40,
    }),
    Effect.catch(() => Effect.fail(pollFailure)),
    Effect.catchDefect(() => Effect.fail(pollFailure)),
  );
  if (polled.status !== "active") {
    return yield* Effect.fail(pollFailure);
  }
  return polled;
});

const projectAttributes = (
  props: WriteOnlySecretProps,
  metadata: SecretMetadata,
  ownerRef: string,
): WriteOnlySecretAttributes => ({
  sourceId: props.sourceId,
  accountId: props.accountId,
  storeId: props.storeId,
  secretName: props.secretName,
  bindingName: props.bindingName,
  providerVersion: props.providerVersion,
  keyedDigest: props.keyedDigest,
  secretId: metadata.secretId,
  status: metadata.status,
  scopes: metadata.scopes,
  ownerReference: ownerRef,
});

const resolveTrustedPlaintext = Effect.fnUntraced(function* (
  news: WriteOnlySecretProps,
  output: WriteOnlySecretAttributes | undefined,
) {
  const source = yield* SecretSource;
  const snapshot = yield* Effect.suspend(() => source.resolve(news.sourceId)).pipe(
    Effect.catch(() => Effect.fail(failure("resolve", "source-failure", news, output?.secretId))),
    Effect.catchDefect(() =>
      Effect.fail(failure("resolve", "source-failure", news, output?.secretId)),
    ),
  );
  if (snapshot.keyedDigest !== news.keyedDigest) {
    return yield* Effect.fail(failure("resolve", "digest-mismatch", news, output?.secretId));
  }
  const valueBytes = new TextEncoder().encode(snapshot.plaintext).length;
  if (valueBytes > SECRET_VALUE_MAX_BYTES) {
    return yield* Effect.fail(failure("resolve", "value-too-large", news, output?.secretId));
  }
  return { plaintext: snapshot.plaintext };
});

const writeThroughPatch = Effect.fnUntraced(function* (
  props: WriteOnlySecretProps,
  output: WriteOnlySecretAttributes | undefined,
  secretId: string,
  comment: string,
) {
  const resolved = yield* resolveTrustedPlaintext(props, output);
  const destination = yield* WriteOnlySecretDestination;
  const accountKey: DestinationAccountKey = {
    accountId: props.accountId,
    storeId: props.storeId,
  };
  return yield* Effect.suspend(() =>
    destination.patch(
      { accountId: props.accountId, storeId: props.storeId, secretId },
      { value: resolved.plaintext, scopes: SECRET_SCOPES, comment },
    ),
  ).pipe(
    Effect.flatMap((metadata) => {
      if (
        !metadataMatchesKey(metadata, { ...accountKey, secretId, secretName: props.secretName })
      ) {
        return Effect.fail(failure("write", "destination-failure", props, secretId));
      }
      return Effect.succeed(metadata);
    }),
    Effect.catch(() => Effect.fail(failure("write", "destination-failure", props, secretId))),
    Effect.catchDefect(() => Effect.fail(failure("write", "destination-failure", props, secretId))),
  );
});

type CreateAttempt =
  | { readonly kind: "written"; readonly metadata: SecretMetadata }
  | { readonly kind: "conflict" };

const attemptCreate = Effect.fnUntraced(function* (
  props: WriteOnlySecretProps,
  output: WriteOnlySecretAttributes | undefined,
  accountKey: DestinationAccountKey,
  comment: string,
) {
  const resolved = yield* resolveTrustedPlaintext(props, output);
  const destination = yield* WriteOnlySecretDestination;
  return yield* Effect.suspend(() =>
    destination.create(accountKey, {
      name: props.secretName,
      value: resolved.plaintext,
      scopes: SECRET_SCOPES,
      comment,
    }),
  ).pipe(
    Effect.flatMap((metadata) => {
      if (!metadataMatchesKey(metadata, { ...accountKey, secretName: props.secretName })) {
        return Effect.fail(failure("write", "destination-failure", props, metadata.secretId));
      }
      return Effect.succeed({ kind: "written", metadata } as const);
    }),
    Effect.catch((error) =>
      isDestinationError(error) && error.code === "conflict"
        ? Effect.succeed({ kind: "conflict" } as const)
        : isDestinationError(error)
          ? Effect.fail(failure("write", "destination-failure", props, error.secretId))
          : Effect.fail(failure("write", "destination-failure", props, undefined)),
    ),
    Effect.catchDefect(() =>
      Effect.fail(failure("write", "destination-failure", props, undefined)),
    ),
  ) satisfies Effect.Effect<CreateAttempt, WriteOnlySecretFailure>;
});

export const writeOnlySecretProvider = Provider.succeed(
  WriteOnlySecret,
  WriteOnlySecret.Provider.of({
    version: WRITE_ONLY_SECRET_PROVIDER_VERSION,
    // secretId is intentionally NOT stable: persisted-ID 404 recovery can
    // replace it with a freshly created secret's ID.
    stables: ["storeId", "accountId", "secretName"],
    list: () => Effect.succeed([]),
    read: Effect.fnUntraced(function* ({ fqn, instanceId, olds, output }) {
      const markerKey = (yield* SecretOwnerKey).key;
      const observed = yield* observeSecret(olds, output, markerKey);
      if (observed === undefined) return undefined;
      const expectedOwner = ownerReference(fqn, instanceId);
      const classification = classifyObserved(observed, expectedOwner);
      if (classification === "ours") {
        return projectAttributes(olds, observed.metadata, expectedOwner);
      }
      // foreign or unowned: surface to the engine for adoption gating.
      return Unowned(
        projectAttributes(olds, observed.metadata, observed.marker.ownerReference ?? ""),
      );
    }),
    diff: Effect.fnUntraced(function* ({ fqn, instanceId, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (!sameDestination(olds, news)) {
        return { action: "replace" } as const;
      }
      if (
        olds.sourceId !== news.sourceId ||
        olds.providerVersion !== news.providerVersion ||
        olds.keyedDigest !== news.keyedDigest ||
        olds.bindingName !== news.bindingName
      ) {
        return { action: "update" } as const;
      }
      const markerKey = (yield* SecretOwnerKey).key;
      const observed = yield* observeSecret(news, output, markerKey);
      if (observed === undefined) return { action: "update" } as const;
      const expectedOwner = ownerReference(fqn, instanceId);
      if (isConverged(observed, news, expectedOwner)) {
        return { action: "noop" } as const;
      }
      // Force reconcile: foreign/unowned (adoption may claim it, managed
      // updates fail closed), marker digest/version drift, scope drift, or
      // non-active status.
      return { action: "update" } as const;
    }),
    reconcile: Effect.fnUntraced(function* ({ fqn, instanceId, news, output }) {
      const expectedOwner = ownerReference(fqn, instanceId);
      const markerKey = (yield* SecretOwnerKey).key;
      const observed = yield* observeSecret(news, output, markerKey);
      // Pinned Alchemy beta.63 does not carry current-run adoption approval
      // into reconcile. Persisted foreign output proves identity, not current
      // authorization, and can survive a failed adoption attempt. Therefore
      // every foreign/unowned observation fails closed, even if the caller
      // used adopt(true). Fresh create and already-owned updates still work.
      if (observed !== undefined) {
        const classification = classifyObserved(observed, expectedOwner);
        if (classification === "foreign" || classification === "unowned") {
          return yield* Effect.fail(
            failure("write", "foreign-owner", news, observed.metadata.secretId),
          );
        }
        // A live marker is not proof that an ambiguous write committed the
        // desired plaintext. Skip source resolution only when Alchemy already
        // persisted a successful output for this exact owner, secret, source,
        // digest, and provider version. Initial-create recovery (no output)
        // and updates whose output still describes the old material must
        // re-resolve and idempotently PATCH the exact ID once more.
        const desiredMaterialWasCommitted =
          output !== undefined &&
          output.ownerReference === expectedOwner &&
          output.secretId === observed.metadata.secretId &&
          sameDestination(output, news) &&
          output.sourceId === news.sourceId &&
          output.keyedDigest === news.keyedDigest &&
          output.providerVersion === news.providerVersion;
        if (
          classification === "ours" &&
          isConverged(observed, news, expectedOwner) &&
          desiredMaterialWasCommitted
        ) {
          return projectAttributes(news, observed.metadata, expectedOwner);
        }
      }

      // The mutation helpers own the short plaintext lifetime and return only
      // metadata before active-status polling begins. Mutation retries are
      // disabled; replay re-resolves and re-PATCHes the exact ID until one
      // unambiguous success plus an active observation.
      const comment = buildOwnerMarker(
        expectedOwner,
        news.keyedDigest,
        news.providerVersion,
        markerKey,
      );
      const accountKey: DestinationAccountKey = {
        accountId: news.accountId,
        storeId: news.storeId,
      };

      let written: SecretMetadata;
      if (observed === undefined) {
        // Missing: create. When output is undefined (initial create), tolerate
        // a concurrent create collision (409) by re-observing by name and
        // re-classifying before any further mutation. When a persisted ID 404'd
        // (output !== undefined), a 409 means a same-name replacement appeared
        // — do NOT fall back to find-by-name; fail closed.
        const attempt = yield* attemptCreate(news, output, accountKey, comment);
        written =
          attempt.kind === "written"
            ? attempt.metadata
            : output === undefined
              ? yield* recoverFromCollision(news, accountKey, comment, expectedOwner)
              : yield* Effect.fail(failure("write", "write-verification-failure", news, undefined));
      } else {
        written = yield* writeThroughPatch(news, output, observed.metadata.secretId, comment);
      }

      // Active observation: one unambiguous success requires seeing active.
      const active = yield* waitForActive({ ...accountKey, secretId: written.secretId }, written);
      // Post-write convergence: the read-back metadata must carry our
      // authentic marker with the desired digest/version and exact workers
      // scope, not just active status.
      const activeObserved: ObservedSecret = {
        metadata: active,
        marker: verifyOwnerMarker(active.comment, markerKey),
      };
      if (!isConverged(activeObserved, news, expectedOwner)) {
        return yield* Effect.fail(
          failure("write", "write-verification-failure", news, written.secretId),
        );
      }
      return projectAttributes(news, active, expectedOwner);
    }),
    delete: Effect.fnUntraced(function* ({ fqn, instanceId, olds, output }) {
      const expectedOwner = ownerReference(fqn, instanceId);
      const markerKey = (yield* SecretOwnerKey).key;
      // Delete never resolves plaintext. Observe the exact persisted ID and
      // verify owner/marker before deleting only that ID.
      // Never derive the deletion target from response metadata — use the
      // persisted output.secretId that observeSecret validated against.
      if (output?.secretId === undefined) return;
      const observed = yield* observeSecret(olds, output, markerKey);
      if (observed === undefined) return;
      const classification = classifyObserved(observed, expectedOwner);
      if (classification !== "ours") {
        return yield* Effect.fail(
          failure("delete", "foreign-owner", olds, observed.metadata.secretId),
        );
      }
      const destination = yield* WriteOnlySecretDestination;
      // Use the persisted exact ID, not the response metadata's ID.
      const secretId = output.secretId;
      yield* Effect.suspend(() =>
        destination.delete({ accountId: olds.accountId, storeId: olds.storeId, secretId }),
      ).pipe(
        Effect.catch((error) =>
          isDestinationError(error) && error.code === "not-found"
            ? Effect.void
            : Effect.fail(failure("delete", "destination-failure", olds, secretId)),
        ),
        Effect.catchDefect(() =>
          Effect.fail(failure("delete", "destination-failure", olds, secretId)),
        ),
      );
    }),
  }),
);

const recoverFromCollision = Effect.fnUntraced(function* (
  news: WriteOnlySecretProps,
  accountKey: DestinationAccountKey,
  comment: string,
  expectedOwner: string,
) {
  const markerKey = (yield* SecretOwnerKey).key;
  const destination = yield* WriteOnlySecretDestination;
  const found = yield* Effect.suspend(() =>
    destination.find({ ...accountKey, secretName: news.secretName }),
  ).pipe(
    Effect.catch(() => Effect.fail(failure("write", "destination-failure", news, undefined))),
    Effect.catchDefect(() => Effect.fail(failure("write", "destination-failure", news, undefined))),
  );
  if (found === undefined) {
    return yield* Effect.fail(failure("write", "write-verification-failure", news, undefined));
  }
  // Identity check: the found metadata must match the requested account,
  // store, and secret name before we read its marker or use its ID.
  if (!metadataMatchesKey(found, { ...accountKey, secretName: news.secretName })) {
    return yield* Effect.fail(failure("write", "destination-failure", news, found.secretId));
  }
  const observed: ObservedSecret = {
    metadata: found,
    marker: verifyOwnerMarker(found.comment, markerKey),
  };
  const classification = classifyObserved(observed, expectedOwner);
  // Collision recovery only runs during an initial create (output undefined).
  // A foreign/unowned colliding secret is never engine-approved here.
  if (classification === "foreign" || classification === "unowned") {
    return yield* Effect.fail(failure("write", "foreign-owner", news, found.secretId));
  }
  // Resolve trusted plaintext only inside the recovery PATCH helper, after
  // the colliding identity and ownership marker have been verified.
  return yield* writeThroughPatch(news, undefined, found.secretId, comment);
});
