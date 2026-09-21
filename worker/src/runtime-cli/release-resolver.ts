import { Context, Data, Effect, Layer, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import {
  RUNTIME_CLI_ASSET_NAME,
  type RuntimeCliArtifactDescriptor,
  type RuntimeCliCompatibility,
  verifyRuntimeCliManifest,
} from "../../../protocol/runtime/runtime-cli-manifest";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_DOWNLOAD_ORIGIN = "https://github.com";
const RELEASE_ASSET_ORIGIN = "https://release-assets.githubusercontent.com";
const RELEASE_REPOSITORY = "Yeshwanthyk/scotty";
const RUNTIME_CLI_MANIFEST_NAME = "scotty-runtime-manifest.json";
const RELEASES_PER_PAGE = 10;
const MAX_RELEASE_PAGES = 3;
const MAX_RELEASE_ASSETS = 16;
const MAX_RELEASES_RESPONSE_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT = "5 seconds";
const RESOLUTION_TIMEOUT = "30 seconds";
const MAX_MANIFEST_REDIRECTS = 2;

const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const PositiveSafeIntegerSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const GitHubReleaseAssetSchema = Schema.Struct({
  id: PositiveSafeIntegerSchema,
  name: Schema.String,
  size: PositiveSafeIntegerSchema,
  browser_download_url: Schema.String,
});
const GitHubReleaseSchema = Schema.Struct({
  id: PositiveSafeIntegerSchema,
  tag_name: Schema.NonEmptyString,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(GitHubReleaseAssetSchema).check(
    Schema.makeFilter((assets) => assets.length <= MAX_RELEASE_ASSETS, {
      expected: `at most ${MAX_RELEASE_ASSETS} release assets`,
    }),
  ),
});
const GitHubReleasesPageSchema = Schema.Array(GitHubReleaseSchema).check(
  Schema.makeFilter((releases) => releases.length <= RELEASES_PER_PAGE, {
    expected: `at most ${RELEASES_PER_PAGE} releases`,
  }),
);
const decodeGitHubReleasesPageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitHubReleasesPageSchema),
  { onExcessProperty: "ignore" },
);
const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type GitHubRelease = typeof GitHubReleaseSchema.Type;
type GitHubReleaseAsset = typeof GitHubReleaseAssetSchema.Type;

export type RuntimeCliReleaseLookupStage = "resolution" | "releases" | "manifest";

export class RuntimeCliReleaseLookupError extends Data.TaggedError("RuntimeCliReleaseLookupError")<{
  readonly reason: "outage" | "timeout";
  readonly stage: RuntimeCliReleaseLookupStage;
  readonly status?: number;
}> {}

export class NoCompatibleRuntimeCliReleaseError extends Data.TaggedError(
  "NoCompatibleRuntimeCliReleaseError",
)<{}> {}

export class RuntimeCliReleaseSearchTruncatedError extends Data.TaggedError(
  "RuntimeCliReleaseSearchTruncatedError",
)<{
  readonly pagesSearched: number;
  readonly releasesSearched: number;
}> {}

export class MalformedRuntimeCliReleaseDataError extends Data.TaggedError(
  "MalformedRuntimeCliReleaseDataError",
)<{
  readonly stage: RuntimeCliReleaseLookupStage;
}> {}

export type RuntimeCliReleaseIntegrityReason =
  | "missing_asset"
  | "duplicate_asset"
  | "unsafe_asset_url"
  | "unsafe_redirect"
  | "release_tag_mismatch"
  | "artifact_size_mismatch";

export class RuntimeCliReleaseIntegrityError extends Data.TaggedError(
  "RuntimeCliReleaseIntegrityError",
)<{
  readonly reason: RuntimeCliReleaseIntegrityReason;
  readonly releaseTag: string;
}> {}

export class RuntimeCliReleaseSignatureError extends Data.TaggedError(
  "RuntimeCliReleaseSignatureError",
)<{
  readonly reason: "invalid_signature" | "crypto_failure";
  readonly releaseTag: string;
}> {}

export type RuntimeCliReleaseResolverError =
  | RuntimeCliReleaseLookupError
  | NoCompatibleRuntimeCliReleaseError
  | RuntimeCliReleaseSearchTruncatedError
  | MalformedRuntimeCliReleaseDataError
  | RuntimeCliReleaseIntegrityError
  | RuntimeCliReleaseSignatureError;

export interface ResolvedRuntimeCliRelease {
  readonly releaseId: number;
  readonly releaseTag: string;
  /**
   * Authenticated release metadata only. The bytes at this URL have not been downloaded or
   * verified; the next cache/materialization slice must verify them against `descriptor`.
   */
  readonly artifactDownloadUrl: string;
  readonly descriptor: RuntimeCliArtifactDescriptor;
}

interface RuntimeCliReleaseResolverShape {
  readonly resolve: (
    supported: ReadonlyArray<RuntimeCliCompatibility>,
  ) => Effect.Effect<ResolvedRuntimeCliRelease, RuntimeCliReleaseResolverError>;
}

export class RuntimeCliReleaseResolver extends Context.Service<
  RuntimeCliReleaseResolver,
  RuntimeCliReleaseResolverShape
>()("scotty/RuntimeCliReleaseResolver") {}

const lookupError = (
  reason: "outage" | "timeout",
  stage: RuntimeCliReleaseLookupStage,
  status?: number,
): RuntimeCliReleaseLookupError =>
  new RuntimeCliReleaseLookupError({
    reason,
    stage,
    ...(status === undefined ? {} : { status }),
  });

const requestHeaders = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "scotty-runtime-release-resolver",
};

const execute = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  stage: RuntimeCliReleaseLookupStage,
) {
  return yield* client.execute(request).pipe(
    Effect.mapError(() => lookupError("outage", stage)),
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(lookupError("timeout", stage)),
    }),
  );
});

const readBoundedText = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number,
  stage: RuntimeCliReleaseLookupStage,
) {
  const chunks = yield* response.stream.pipe(
    Stream.mapError((): RuntimeCliReleaseResolverError => lookupError("outage", stage)),
    Stream.limitBytes(maximumBytes, () =>
      Stream.fail<RuntimeCliReleaseResolverError>(
        new MalformedRuntimeCliReleaseDataError({ stage }),
      ),
    ),
    Stream.runCollect,
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(lookupError("timeout", stage)),
    }),
  );
  const length = chunks.reduce((total, value) => total + value.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const value of chunks) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    catch: () => new MalformedRuntimeCliReleaseDataError({ stage }),
  });
});

const discardResponse = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<void> =>
  response.stream.pipe(
    Stream.runDrain,
    Effect.timeoutOrElse({ duration: 0, orElse: () => Effect.void }),
    Effect.ignore,
  );

const expectedDownloadUrl = (releaseTag: string, assetName: string): string =>
  `${GITHUB_DOWNLOAD_ORIGIN}/${RELEASE_REPOSITORY}/releases/download/${releaseTag}/${assetName}`;

const exactAsset = (
  release: GitHubRelease,
  name: string,
): Effect.Effect<GitHubReleaseAsset, RuntimeCliReleaseIntegrityError> => {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length === 0)
    return Effect.fail(
      new RuntimeCliReleaseIntegrityError({
        reason: "missing_asset",
        releaseTag: release.tag_name,
      }),
    );
  if (matches.length !== 1)
    return Effect.fail(
      new RuntimeCliReleaseIntegrityError({
        reason: "duplicate_asset",
        releaseTag: release.tag_name,
      }),
    );
  const asset = matches[0];
  if (
    asset === undefined ||
    asset.browser_download_url !== expectedDownloadUrl(release.tag_name, name)
  )
    return Effect.fail(
      new RuntimeCliReleaseIntegrityError({
        reason: "unsafe_asset_url",
        releaseTag: release.tag_name,
      }),
    );
  return Effect.succeed(asset);
};

interface RuntimeCliReleaseAssets {
  readonly manifest: GitHubReleaseAsset;
  readonly artifact: GitHubReleaseAsset;
}

const runtimeCliReleaseAssets = (
  release: GitHubRelease,
): Effect.Effect<RuntimeCliReleaseAssets | undefined, RuntimeCliReleaseIntegrityError> => {
  const hasManifest = release.assets.some((asset) => asset.name === RUNTIME_CLI_MANIFEST_NAME);
  const hasArtifact = release.assets.some((asset) => asset.name === RUNTIME_CLI_ASSET_NAME);
  if (!hasManifest && !hasArtifact) return Effect.succeed(undefined);
  return Effect.all({
    manifest: exactAsset(release, RUNTIME_CLI_MANIFEST_NAME),
    artifact: exactAsset(release, RUNTIME_CLI_ASSET_NAME),
  });
};

const trustedRedirect = (location: string, currentUrl: string): string | undefined => {
  const parsed = URL.parse(location, currentUrl);
  if (
    parsed === null ||
    parsed.origin !== RELEASE_ASSET_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  )
    return undefined;
  return parsed.href;
};

const fetchManifest = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  releaseTag: string,
  initialUrl: string,
) {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_MANIFEST_REDIRECTS; redirects += 1) {
    const response = yield* execute(
      client,
      HttpClientRequest.get(url, { headers: requestHeaders }),
      "manifest",
    );
    if (response.status === 200)
      return yield* readBoundedText(response, MAX_MANIFEST_BYTES, "manifest");
    yield* discardResponse(response);
    if (response.status < 300 || response.status >= 400)
      return yield* lookupError("outage", "manifest", response.status);
    const location = response.headers.location;
    const next = location === undefined ? undefined : trustedRedirect(location, url);
    if (next === undefined || redirects === MAX_MANIFEST_REDIRECTS)
      return yield* new RuntimeCliReleaseIntegrityError({
        reason: "unsafe_redirect",
        releaseTag,
      });
    url = next;
  }
  return yield* new RuntimeCliReleaseIntegrityError({ reason: "unsafe_redirect", releaseTag });
});

const sameCompatibility = (
  left: RuntimeCliCompatibility,
  right: RuntimeCliCompatibility,
): boolean =>
  left.bunVersion === right.bunVersion &&
  left.compileTarget === right.compileTarget &&
  left.cpu === right.cpu &&
  left.libc === right.libc &&
  left.cloudflareSandbox.packageVersion === right.cloudflareSandbox.packageVersion &&
  left.cloudflareSandbox.image === right.cloudflareSandbox.image;

const compareIntegerStrings = (left: string, right: string): number =>
  left.length === right.length ? left.localeCompare(right) : left.length - right.length;

const compareReleaseVersions = (left: string, right: string): number => {
  const leftParts = releaseTagPattern.exec(left);
  const rightParts = releaseTagPattern.exec(right);
  if (leftParts === null || rightParts === null) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) return 0;
    const compared = compareIntegerStrings(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
};

const candidate = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  release: GitHubRelease,
  supported: ReadonlyArray<RuntimeCliCompatibility>,
) {
  const assets = yield* runtimeCliReleaseAssets(release);
  if (assets === undefined) return undefined;
  const manifestText = yield* fetchManifest(
    client,
    release.tag_name,
    assets.manifest.browser_download_url,
  );
  const manifestJson = yield* decodeManifestJson(manifestText).pipe(
    Effect.mapError(() => new MalformedRuntimeCliReleaseDataError({ stage: "manifest" })),
  );
  const descriptor = yield* verifyRuntimeCliManifest(manifestJson).pipe(
    Effect.catchTags({
      MalformedRuntimeCliManifestError: () =>
        Effect.fail(new MalformedRuntimeCliReleaseDataError({ stage: "manifest" })),
      InvalidRuntimeCliManifestSignatureError: () =>
        Effect.fail(
          new RuntimeCliReleaseSignatureError({
            reason: "invalid_signature",
            releaseTag: release.tag_name,
          }),
        ),
      RuntimeCliManifestCryptoError: () =>
        Effect.fail(
          new RuntimeCliReleaseSignatureError({
            reason: "crypto_failure",
            releaseTag: release.tag_name,
          }),
        ),
    }),
  );
  if (descriptor.releaseTag !== release.tag_name)
    return yield* new RuntimeCliReleaseIntegrityError({
      reason: "release_tag_mismatch",
      releaseTag: release.tag_name,
    });
  if (descriptor.artifact.byteSize !== assets.artifact.size)
    return yield* new RuntimeCliReleaseIntegrityError({
      reason: "artifact_size_mismatch",
      releaseTag: release.tag_name,
    });
  if (!supported.some((requirement) => sameCompatibility(requirement, descriptor.compatibility)))
    return undefined;
  return {
    releaseId: release.id,
    releaseTag: release.tag_name,
    artifactDownloadUrl: assets.artifact.browser_download_url,
    descriptor,
  } satisfies ResolvedRuntimeCliRelease;
});

const makeRuntimeCliReleaseResolver = (
  client: HttpClient.HttpClient,
): RuntimeCliReleaseResolverShape => ({
  resolve: (supported) =>
    Effect.gen(function* () {
      let releasesSearched = 0;
      let best: ResolvedRuntimeCliRelease | undefined;
      for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
        const url = `${GITHUB_API_ORIGIN}/repos/${RELEASE_REPOSITORY}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`;
        const response = yield* execute(
          client,
          HttpClientRequest.get(url, { headers: requestHeaders }),
          "releases",
        );
        if (response.status !== 200) {
          yield* discardResponse(response);
          return yield* lookupError("outage", "releases", response.status);
        }
        const text = yield* readBoundedText(response, MAX_RELEASES_RESPONSE_BYTES, "releases");
        const releases = yield* decodeGitHubReleasesPageJson(text).pipe(
          Effect.mapError(() => new MalformedRuntimeCliReleaseDataError({ stage: "releases" })),
        );
        for (const release of releases) {
          if (release.draft || release.prerelease || !releaseTagPattern.test(release.tag_name))
            continue;
          releasesSearched += 1;
          const resolved = yield* candidate(client, release, supported);
          if (
            resolved !== undefined &&
            (best === undefined || compareReleaseVersions(resolved.releaseTag, best.releaseTag) > 0)
          )
            best = resolved;
        }
        const link = response.headers.link;
        if (link !== undefined && link.length > 4_096)
          return yield* new MalformedRuntimeCliReleaseDataError({ stage: "releases" });
        const hasNextPage = link !== undefined && link.includes('rel="next"');
        if (!hasNextPage) {
          if (best !== undefined) return best;
          return yield* new NoCompatibleRuntimeCliReleaseError();
        }
      }
      return yield* new RuntimeCliReleaseSearchTruncatedError({
        pagesSearched: MAX_RELEASE_PAGES,
        releasesSearched,
      });
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
      Effect.timeoutOrElse({
        duration: RESOLUTION_TIMEOUT,
        orElse: () => Effect.fail(lookupError("timeout", "resolution")),
      }),
    ),
});

/** Production resolver logic over an Effect HttpClient. Fetch clients are forced to manual redirects. */
export const runtimeCliReleaseResolverLayer: Layer.Layer<
  RuntimeCliReleaseResolver,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  RuntimeCliReleaseResolver,
  Effect.map(HttpClient.HttpClient, makeRuntimeCliReleaseResolver),
);

/** Exposed for contract tests and hosts that already own an Effect HttpClient. */
export const makeRuntimeCliReleaseResolverForClient = makeRuntimeCliReleaseResolver;
