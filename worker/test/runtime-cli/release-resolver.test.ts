import { assert, describe, it } from "@effect/vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  canonicalRuntimeCliManifestBytes,
  RUNTIME_CLI_ASSET_NAME,
  type RuntimeCliArtifactDescriptor,
  type RuntimeCliCompatibility,
  type RuntimeCliManifest,
} from "../../../protocol/runtime-cli-manifest";
import { Effect, Fiber, Predicate, Result } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";
import {
  makeRuntimeCliReleaseResolverForClient,
  type RuntimeCliReleaseIntegrityError,
  type RuntimeCliReleaseLookupError,
  type RuntimeCliReleaseResolverError,
  type RuntimeCliReleaseSearchTruncatedError,
  type RuntimeCliReleaseSignatureError,
} from "../../src/runtime-cli/release-resolver";

const MANIFEST_NAME = "scotty-runtime-manifest.json";
const SANDBOX_IMAGE =
  "docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe";
const OTHER_SANDBOX_IMAGE =
  "docker.io/cloudflare/sandbox:0.12.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MANIFEST_ASSET_SIZE = 2_048;
const ARTIFACT_SIZE = 123;

const compatibility = (image = SANDBOX_IMAGE): RuntimeCliCompatibility => ({
  bunVersion: "1.3.13",
  compileTarget: "bun-linux-x64-baseline",
  cpu: "x86-64-baseline",
  libc: "glibc",
  cloudflareSandbox: { packageVersion: "0.12.9", image },
});

const descriptor = (
  version: string,
  compatible = compatibility(),
): RuntimeCliArtifactDescriptor => ({
  schemaVersion: 1,
  releaseTag: `v${version}`,
  artifact: {
    name: RUNTIME_CLI_ASSET_NAME,
    cliVersion: version,
    revision: "a".repeat(40),
    target: "linux/amd64",
    byteSize: ARTIFACT_SIZE,
    sha256: "b".repeat(64),
    installMode: "0755",
  },
  compatibility: compatible,
});

const downloadUrl = (tag: string, name: string): string =>
  `https://github.com/Yeshwanthyk/scotty/releases/download/${tag}/${name}`;

const release = (
  version: string,
  options: {
    readonly draft?: boolean;
    readonly prerelease?: boolean;
    readonly assets?: ReadonlyArray<{
      readonly id: number;
      readonly name: string;
      readonly size: number;
      readonly browser_download_url: string;
    }>;
  } = {},
) => {
  const tag = `v${version}`;
  return {
    id: 100,
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    assets: options.assets ?? [
      {
        id: 1,
        name: MANIFEST_NAME,
        size: MANIFEST_ASSET_SIZE,
        browser_download_url: downloadUrl(tag, MANIFEST_NAME),
      },
      {
        id: 2,
        name: RUNTIME_CLI_ASSET_NAME,
        size: ARTIFACT_SIZE,
        browser_download_url: downloadUrl(tag, RUNTIME_CLI_ASSET_NAME),
      },
    ],
  };
};

type TestKeys = {
  readonly privateKey: KeyObject;
  readonly publicKey: Uint8Array;
};

const keyPair = (): TestKeys => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, publicKey: Uint8Array.from(publicKeyDer.subarray(-32)) };
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const trust = (publicKey: Uint8Array): void => {
  const subtle = crypto.subtle;
  vi.stubGlobal("crypto", {
    subtle: {
      importKey: () =>
        subtle.importKey("raw", toArrayBuffer(publicKey), "Ed25519", false, ["verify"]),
      verify: subtle.verify.bind(subtle),
    },
  });
};

const signed = (
  value: RuntimeCliArtifactDescriptor,
  privateKey: KeyObject,
): RuntimeCliManifest => ({
  ...value,
  signature: Buffer.from(sign(null, canonicalRuntimeCliManifestBytes(value), privateKey)).toString(
    "base64",
  ),
});

type Route =
  | Response
  | "transport"
  | "pending"
  | { readonly response: Response; readonly delay: `${number} seconds` };

const harness = (routes: ReadonlyMap<string, Route>) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    const route = routes.get(request.url);
    if (route === "pending") return Effect.never;
    if (route === undefined || route === "transport")
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "network unavailable" }),
        }),
      );
    if (!(route instanceof Response))
      return Effect.succeed(HttpClientResponse.fromWeb(request, route.response)).pipe(
        Effect.delay(route.delay),
      );
    return Effect.succeed(HttpClientResponse.fromWeb(request, route));
  });
  return { requests, resolver: makeRuntimeCliReleaseResolverForClient(client) };
};

const cancellableResponse = (status = 200) => {
  let cancellations = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel: () => {
        cancellations += 1;
      },
    }),
    { status },
  );
  return { response, cancellations: () => cancellations };
};

const listUrl = (page = 1): string =>
  `https://api.github.com/repos/Yeshwanthyk/scotty/releases?per_page=10&page=${page}`;

const failure = (
  result: Result.Result<unknown, RuntimeCliReleaseResolverError>,
): RuntimeCliReleaseResolverError =>
  Result.match(result, {
    onFailure: (error) => error,
    onSuccess: () => assert.fail("expected resolver failure"),
  });
const integrityFailure = (result: Result.Result<unknown, RuntimeCliReleaseResolverError>) => {
  const error = failure(result);
  assert.isTrue(Predicate.isTagged("RuntimeCliReleaseIntegrityError")(error));
  return error as RuntimeCliReleaseIntegrityError;
};

const signatureFailure = (result: Result.Result<unknown, RuntimeCliReleaseResolverError>) => {
  const error = failure(result);
  assert.isTrue(Predicate.isTagged("RuntimeCliReleaseSignatureError")(error));
  return error as RuntimeCliReleaseSignatureError;
};

const lookupFailure = (result: Result.Result<unknown, RuntimeCliReleaseResolverError>) => {
  const error = failure(result);
  assert.isTrue(Predicate.isTagged("RuntimeCliReleaseLookupError")(error));
  return error as RuntimeCliReleaseLookupError;
};

const truncatedFailure = (result: Result.Result<unknown, RuntimeCliReleaseResolverError>) => {
  const error = failure(result);
  assert.isTrue(Predicate.isTagged("RuntimeCliReleaseSearchTruncatedError")(error));
  return error as RuntimeCliReleaseSearchTruncatedError;
};

afterEach(() => vi.unstubAllGlobals());

describe("RuntimeCliReleaseResolver", () => {
  it.effect(
    "skips excluded releases and a newer incompatible release, then selects the older compatible release",
    () =>
      Effect.gen(function* () {
        const keys = keyPair();
        trust(keys.publicKey);
        const newest = descriptor("3.0.0", compatibility(OTHER_SANDBOX_IMAGE));
        const selected = descriptor("2.0.0");
        const releases = [
          release("5.0.0", { draft: true }),
          release("4.0.0-beta.1", { prerelease: true }),
          release("3.0.0"),
          release("2.0.0"),
        ];
        const { resolver, requests } = harness(
          new Map([
            [listUrl(), Response.json(releases)],
            [downloadUrl("v3.0.0", MANIFEST_NAME), Response.json(signed(newest, keys.privateKey))],
            [
              downloadUrl("v2.0.0", MANIFEST_NAME),
              Response.json(signed(selected, keys.privateKey)),
            ],
          ]),
        );

        const result = yield* resolver.resolve([compatibility()]);

        assert.strictEqual(result.releaseTag, "v2.0.0");
        assert.strictEqual(
          result.artifactDownloadUrl,
          downloadUrl("v2.0.0", RUNTIME_CLI_ASSET_NAME),
        );
        assert.deepStrictEqual(result.descriptor, selected);
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [listUrl(), downloadUrl("v3.0.0", MANIFEST_NAME), downloadUrl("v2.0.0", MANIFEST_NAME)],
        );
        assert.isTrue(requests.every((request) => request.headers.authorization === undefined));
      }),
  );

  it.effect(
    "selects the highest authenticated compatible version instead of trusting API order",
    () =>
      Effect.gen(function* () {
        const keys = keyPair();
        trust(keys.publicKey);
        const versions = ["2.0.0", "10.0.0", "999999999999999999999999.0.0"];
        const { resolver } = harness(
          new Map([
            [listUrl(), Response.json(versions.map((version) => release(version)))],
            ...versions.map(
              (version) =>
                [
                  downloadUrl(`v${version}`, MANIFEST_NAME),
                  Response.json(signed(descriptor(version), keys.privateKey)),
                ] as const,
            ),
          ]),
        );

        const result = yield* resolver.resolve([compatibility()]);

        assert.strictEqual(result.releaseTag, "v999999999999999999999999.0.0");
      }),
  );

  it.effect("finds a higher compatible version on a later page before selecting", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      trust(keys.publicKey);
      const { resolver, requests } = harness(
        new Map([
          [
            listUrl(1),
            Response.json([release("2.0.0")], {
              headers: { link: `<${listUrl(2)}>; rel="next"` },
            }),
          ],
          [listUrl(2), Response.json([release("20.0.0")])],
          [
            downloadUrl("v2.0.0", MANIFEST_NAME),
            Response.json(signed(descriptor("2.0.0"), keys.privateKey)),
          ],
          [
            downloadUrl("v20.0.0", MANIFEST_NAME),
            Response.json(signed(descriptor("20.0.0"), keys.privateKey)),
          ],
        ]),
      );

      const result = yield* resolver.resolve([compatibility()]);

      assert.strictEqual(result.releaseTag, "v20.0.0");
      assert.isTrue(requests.some((request) => request.url === listUrl(2)));
    }),
  );

  it.effect("rejects a signed manifest whose tag does not bind to its GitHub release", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      trust(keys.publicKey);
      const { resolver } = harness(
        new Map([
          [listUrl(), Response.json([release("2.0.0")])],
          [
            downloadUrl("v2.0.0", MANIFEST_NAME),
            Response.json(signed(descriptor("1.0.0"), keys.privateKey)),
          ],
        ]),
      );

      const error = integrityFailure(yield* Effect.result(resolver.resolve([compatibility()])));
      assert.strictEqual(error.reason, "release_tag_mismatch");
    }),
  );

  it.effect(
    "skips a pre-artifact release with neither runtime asset and accepts a later pair",
    () =>
      Effect.gen(function* () {
        const keys = keyPair();
        trust(keys.publicKey);
        const selected = descriptor("1.0.0");
        const { resolver, requests } = harness(
          new Map([
            [
              listUrl(),
              Response.json([
                release("2.0.0", {
                  assets: [
                    {
                      id: 9,
                      name: "unrelated.txt",
                      size: 1,
                      browser_download_url: downloadUrl("v2.0.0", "unrelated.txt"),
                    },
                  ],
                }),
                release("1.0.0"),
              ]),
            ],
            [
              downloadUrl("v1.0.0", MANIFEST_NAME),
              Response.json(signed(selected, keys.privateKey)),
            ],
          ]),
        );

        assert.strictEqual((yield* resolver.resolve([compatibility()])).releaseTag, "v1.0.0");
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [listUrl(), downloadUrl("v1.0.0", MANIFEST_NAME)],
        );
      }),
  );

  for (const [label, assets, reason] of [
    [
      "missing manifest",
      [
        {
          id: 2,
          name: RUNTIME_CLI_ASSET_NAME,
          size: ARTIFACT_SIZE,
          browser_download_url: downloadUrl("v1.0.0", RUNTIME_CLI_ASSET_NAME),
        },
      ],
      "missing_asset",
    ],
    [
      "missing executable",
      [
        {
          id: 1,
          name: MANIFEST_NAME,
          size: MANIFEST_ASSET_SIZE,
          browser_download_url: downloadUrl("v1.0.0", MANIFEST_NAME),
        },
      ],
      "missing_asset",
    ],
    [
      "duplicate",
      [
        {
          id: 1,
          name: MANIFEST_NAME,
          size: MANIFEST_ASSET_SIZE,
          browser_download_url: downloadUrl("v1.0.0", MANIFEST_NAME),
        },
        {
          id: 2,
          name: MANIFEST_NAME,
          size: MANIFEST_ASSET_SIZE,
          browser_download_url: downloadUrl("v1.0.0", MANIFEST_NAME),
        },
        {
          id: 3,
          name: RUNTIME_CLI_ASSET_NAME,
          size: ARTIFACT_SIZE,
          browser_download_url: downloadUrl("v1.0.0", RUNTIME_CLI_ASSET_NAME),
        },
      ],
      "duplicate_asset",
    ],
  ] as const) {
    it.effect(`rejects ${label} exact release assets`, () =>
      Effect.gen(function* () {
        const { resolver } = harness(
          new Map([[listUrl(), Response.json([release("1.0.0", { assets })])]]),
        );
        const error = integrityFailure(yield* Effect.result(resolver.resolve([compatibility()])));
        assert.strictEqual(error.reason, reason);
      }),
    );
  }

  it.effect("accepts sixteen metadata assets without imposing a binary-size cap", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      trust(keys.publicKey);
      const byteSize = 9_000_000_000;
      const value: RuntimeCliArtifactDescriptor = {
        ...descriptor("1.0.0"),
        artifact: { ...descriptor("1.0.0").artifact, byteSize },
      };
      const base = release("1.0.0");
      const assets = [
        ...base.assets.map((asset) =>
          asset.name === RUNTIME_CLI_ASSET_NAME ? { ...asset, size: byteSize } : asset,
        ),
        ...Array.from({ length: 14 }, (_, index) => ({
          id: index + 3,
          name: `extra-${index}.txt`,
          size: 1,
          browser_download_url: downloadUrl("v1.0.0", `extra-${index}.txt`),
        })),
      ];
      const { resolver } = harness(
        new Map([
          [listUrl(), Response.json([release("1.0.0", { assets })])],
          [downloadUrl("v1.0.0", MANIFEST_NAME), Response.json(signed(value, keys.privateKey))],
        ]),
      );

      const result = yield* resolver.resolve([compatibility()]);
      assert.strictEqual(result.descriptor.artifact.byteSize, byteSize);
    }),
  );

  it.effect("rejects a hostile asset URL without requesting it", () =>
    Effect.gen(function* () {
      const hostile = "https://attacker.example/runtime-manifest.json";
      const bad = release("1.0.0");
      const assets = bad.assets.map((asset) =>
        asset.name === MANIFEST_NAME ? { ...asset, browser_download_url: hostile } : asset,
      );
      const { resolver, requests } = harness(
        new Map([[listUrl(), Response.json([{ ...bad, assets }])]]),
      );

      const error = integrityFailure(yield* Effect.result(resolver.resolve([compatibility()])));
      assert.strictEqual(error.reason, "unsafe_asset_url");
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [listUrl()],
      );
    }),
  );

  it.effect("follows only a bounded trusted manifest redirect and rejects hostile redirects", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      trust(keys.publicKey);
      const value = descriptor("1.0.0");
      const initial = downloadUrl("v1.0.0", MANIFEST_NAME);
      const trustedUrl =
        "https://release-assets.githubusercontent.com/github-production-release-asset/1/manifest?sig=x";
      const trustedHarness = harness(
        new Map([
          [listUrl(), Response.json([release("1.0.0")])],
          [initial, new Response(null, { status: 302, headers: { location: trustedUrl } })],
          [trustedUrl, Response.json(signed(value, keys.privateKey))],
        ]),
      );
      assert.strictEqual(
        (yield* trustedHarness.resolver.resolve([compatibility()])).releaseTag,
        "v1.0.0",
      );

      const hostileHarness = harness(
        new Map([
          [listUrl(), Response.json([release("1.0.0")])],
          [
            initial,
            new Response(null, {
              status: 302,
              headers: { location: "https://attacker.example/manifest" },
            }),
          ],
        ]),
      );
      const error = integrityFailure(
        yield* Effect.result(hostileHarness.resolver.resolve([compatibility()])),
      );
      assert.strictEqual(error.reason, "unsafe_redirect");
    }),
  );

  it.effect("reports an invalid manifest signature separately from malformed metadata", () =>
    Effect.gen(function* () {
      const trusted = keyPair();
      const untrusted = keyPair();
      trust(trusted.publicKey);
      const { resolver } = harness(
        new Map([
          [listUrl(), Response.json([release("1.0.0")])],
          [
            downloadUrl("v1.0.0", MANIFEST_NAME),
            Response.json(signed(descriptor("1.0.0"), untrusted.privateKey)),
          ],
        ]),
      );

      const error = signatureFailure(yield* Effect.result(resolver.resolve([compatibility()])));
      assert.strictEqual(error.reason, "invalid_signature");
    }),
  );

  it.effect("does not downgrade to a verified candidate after a later integrity failure", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      trust(keys.publicKey);
      const bad = release("1.0.0");
      const badAssets = bad.assets.map((asset) =>
        asset.name === RUNTIME_CLI_ASSET_NAME ? { ...asset, size: ARTIFACT_SIZE + 1 } : asset,
      );
      const { resolver } = harness(
        new Map([
          [listUrl(), Response.json([release("2.0.0"), { ...bad, assets: badAssets }])],
          [
            downloadUrl("v2.0.0", MANIFEST_NAME),
            Response.json(signed(descriptor("2.0.0"), keys.privateKey)),
          ],
          [
            downloadUrl("v1.0.0", MANIFEST_NAME),
            Response.json(signed(descriptor("1.0.0"), keys.privateKey)),
          ],
        ]),
      );

      const error = integrityFailure(yield* Effect.result(resolver.resolve([compatibility()])));
      assert.strictEqual(error.reason, "artifact_size_mismatch");
    }),
  );

  it.effect("reports malformed GitHub metadata before selection", () =>
    Effect.gen(function* () {
      const { resolver } = harness(new Map([[listUrl(), Response.json([{ id: 1 }])]]));
      const error = failure(yield* Effect.result(resolver.resolve([compatibility()])));
      assert.isTrue(Predicate.isTagged("MalformedRuntimeCliReleaseDataError")(error));
    }),
  );

  it.effect("classifies transport outages and request timeouts without retaining causes", () =>
    Effect.gen(function* () {
      const outage = harness(new Map([[listUrl(), "transport"]]));
      const outageError = lookupFailure(
        yield* Effect.result(outage.resolver.resolve([compatibility()])),
      );
      assert.strictEqual(outageError.reason, "outage");
      assert.notInclude(JSON.stringify(outageError), "network unavailable");

      const timeout = harness(new Map([[listUrl(), "pending"]]));
      const pending = yield* timeout.resolver
        .resolve([compatibility()])
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const timeoutError = lookupFailure(yield* Fiber.join(pending));
      assert.strictEqual(timeoutError.reason, "timeout");
    }),
  );

  it.effect("applies one outer deadline to the complete authenticated search", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      trust(keys.publicKey);
      const versions = Array.from({ length: 10 }, (_, index) => `1.${index}.0`);
      const routes = new Map<string, Route>([
        [listUrl(), Response.json(versions.map((version) => release(version)))],
        ...versions.map(
          (version) =>
            [
              downloadUrl(`v${version}`, MANIFEST_NAME),
              {
                response: Response.json(signed(descriptor(version), keys.privateKey)),
                delay: "4 seconds" as const,
              },
            ] as const,
        ),
      ]);
      const { resolver, requests } = harness(routes);
      const pending = yield* resolver
        .resolve([compatibility()])
        .pipe(Effect.result, Effect.forkChild);

      yield* TestClock.adjust("30 seconds");
      const error = lookupFailure(yield* Fiber.join(pending));

      assert.strictEqual(error.reason, "timeout");
      assert.strictEqual(error.stage, "resolution");
      assert.isBelow(requests.length, 11);
    }),
  );

  it.effect("cancels a release response body when streaming times out", () =>
    Effect.gen(function* () {
      const body = cancellableResponse();
      const { resolver } = harness(new Map([[listUrl(), body.response]]));
      const pending = yield* resolver
        .resolve([compatibility()])
        .pipe(Effect.result, Effect.forkChild);

      yield* TestClock.adjust("5 seconds");
      const error = lookupFailure(yield* Fiber.join(pending));

      assert.strictEqual(error.reason, "timeout");
      assert.strictEqual(error.stage, "releases");
      assert.strictEqual(body.cancellations(), 1);
    }),
  );

  it.effect("cancels an unread non-200 response body", () =>
    Effect.gen(function* () {
      const body = cancellableResponse(503);
      const { resolver } = harness(new Map([[listUrl(), body.response]]));

      const error = lookupFailure(yield* Effect.result(resolver.resolve([compatibility()])));

      assert.strictEqual(error.reason, "outage");
      assert.strictEqual(error.status, 503);
      assert.strictEqual(body.cancellations(), 1);
    }),
  );

  it.effect("returns truncation instead of a bounded-window candidate", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      trust(keys.publicKey);
      const pages = new Map<string, Route>();
      for (let page = 1; page <= 3; page += 1) {
        const releases = Array.from({ length: 10 }, (_, index) =>
          page === 1 && index === 0
            ? release("1.0.0")
            : release(`${page}.${index + 1}.0`, { assets: [] }),
        );
        pages.set(
          listUrl(page),
          Response.json(releases, {
            headers: { link: `<${listUrl(page + 1)}>; rel="next"` },
          }),
        );
      }
      pages.set(
        downloadUrl("v1.0.0", MANIFEST_NAME),
        Response.json(signed(descriptor("1.0.0"), keys.privateKey)),
      );
      const { resolver } = harness(pages);

      const error = truncatedFailure(yield* Effect.result(resolver.resolve([compatibility()])));

      assert.strictEqual(error.pagesSearched, 3);
      assert.strictEqual(error.releasesSearched, 30);
    }),
  );

  it.effect(
    "returns truncated after the fixed pagination bound and never requests another page",
    () =>
      Effect.gen(function* () {
        const pages = new Map<string, Route>();
        for (let page = 1; page <= 3; page += 1) {
          pages.set(
            listUrl(page),
            Response.json(
              Array.from({ length: 10 }, (_, index) =>
                release(`${page}.${index}.0`, { draft: true }),
              ),
              {
                headers: {
                  link: `<${listUrl(page + 1)}>; rel="next"`,
                },
              },
            ),
          );
        }
        const { resolver, requests } = harness(pages);

        const error = truncatedFailure(yield* Effect.result(resolver.resolve([compatibility()])));
        assert.strictEqual(error.pagesSearched, 3);
        assert.strictEqual(error.releasesSearched, 0);
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [listUrl(1), listUrl(2), listUrl(3)],
        );
      }),
  );

  it.effect("distinguishes an exhausted bounded search from truncation", () =>
    Effect.gen(function* () {
      const { resolver } = harness(new Map([[listUrl(), Response.json([])]]));
      const error = failure(yield* Effect.result(resolver.resolve([compatibility()])));
      assert.isTrue(Predicate.isTagged("NoCompatibleRuntimeCliReleaseError")(error));
    }),
  );
});
