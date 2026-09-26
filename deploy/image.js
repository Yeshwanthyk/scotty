import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthProviders } from "alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Cloudflare from "alchemy/Cloudflare";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  CopyError,
  Config,
  Index,
  Manifest,
  Token,
  bytes,
  call,
  check,
  decode,
  hash,
  json,
  registry,
  remove,
  spool,
  streamFile,
} from "./oci.ts";
const Source = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^(?:index\.docker\.io|docker\.io)\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+@sha256:[a-f0-9]{64}$/,
    ),
  ),
);
const Account = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{32}$/)));
const Repository = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/),
  ),
);
const Input = Schema.Struct({ source: Source, account: Account, repository: Repository });
const accept =
  "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const error = (step, status = 0) => new CopyError({ step, status });
export const copyImage = (raw) =>
  Effect.gen(function* () {
    const { source, account, repository } = yield* decode(Input, raw, "input");
    const match = /^(?:index\.docker\.io|docker\.io)\/(.+)@(sha256:[a-f0-9]{64})$/.exec(source);
    if (!match) return yield* error("source reference");
    let repo = match[1];
    const requested = match[2];
    if (!repo || !requested) return yield* error("source reference");
    if (!repo.includes("/")) repo = `library/${repo}`;
    const tokenUrl = new URL("https://auth.docker.io/token");
    tokenUrl.searchParams.set("service", "registry.docker.io");
    tokenUrl.searchParams.set("scope", `repository:${repo}:pull`);
    const tokenResponse = yield* call(tokenUrl.toString(), "GET", "source token", {});
    yield* check(tokenResponse, 200, "source token");
    const token = Redacted.make(
      (yield* decode(
        Token,
        yield* json(yield* bytes(tokenResponse, "source token"), "source token"),
        "source token",
      )).token,
    );
    const sourceBase = `https://registry-1.docker.io/v2/${repo}`;
    const sourceGet = (part, step) =>
      call(`${sourceBase}/${part}`, "GET", step, {
        authorization: `Bearer ${Redacted.value(token)}`,
        accept,
      });
    const getVerified = (digest, step) =>
      Effect.gen(function* () {
        const response = yield* sourceGet(`manifests/${digest}`, step);
        yield* check(response, 200, step);
        const content = yield* bytes(response, step);
        if (hash(content) !== digest) return yield* error(`${step} digest`, response.status);
        return { content, mediaType: response.headers.get("content-type")?.split(";")[0] ?? "" };
      });
    const root = yield* getVerified(requested, "source manifest/index");
    let chosen = requested;
    let selected = root;
    if (
      root.mediaType === "application/vnd.oci.image.index.v1+json" ||
      root.mediaType === "application/vnd.docker.distribution.manifest.list.v2+json"
    ) {
      const index = yield* decode(Index, yield* json(root.content, "index JSON"), "index schema");
      const entry = index.manifests.find(
        (m) => m.platform.os === "linux" && m.platform.architecture === "amd64",
      );
      if (!entry) return yield* error("linux/amd64 missing");
      chosen = entry.digest;
      selected = yield* getVerified(chosen, "selected manifest");
      if (selected.content.byteLength !== entry.size || selected.mediaType !== entry.mediaType)
        return yield* error("selected descriptor");
    }
    if (
      selected.mediaType !== "application/vnd.oci.image.manifest.v1+json" &&
      selected.mediaType !== "application/vnd.docker.distribution.manifest.v2+json"
    )
      return yield* error("manifest media type");
    const manifest = yield* decode(
      Manifest,
      yield* json(selected.content, "manifest JSON"),
      "manifest schema",
    );
    if (manifest.config.size > 1024 * 1024) return yield* error("config size limit");
    const configResponse = yield* sourceGet(`blobs/${manifest.config.digest}`, "config");
    yield* check(configResponse, 200, "config");
    const configBytes = yield* bytes(configResponse, "config");
    if (
      configBytes.byteLength !== manifest.config.size ||
      hash(configBytes) !== manifest.config.digest
    )
      return yield* error("config digest/size");
    const config = yield* decode(Config, yield* json(configBytes, "config JSON"), "config schema");
    if (config.os !== "linux" || config.architecture !== "amd64")
      return yield* error("config platform");
    const credential = yield* Containers.createContainerRegistryCredentials({
      accountId: account,
      registryId: "registry.cloudflare.com",
      permissions: ["pull", "push"],
      expirationMinutes: 10,
    }).pipe(Effect.mapError(() => error("registry credential")));
    const username = credential.username ?? credential.user;
    if (!username) return yield* error("registry username");
    const password = Redacted.isRedacted(credential.password)
      ? Redacted.value(credential.password)
      : credential.password;
    const target = registry(
      `https://registry.cloudflare.com/v2/${account}/${repository}`,
      Redacted.make(`Basic ${btoa(`${username}:${password}`)}`),
    );
    const temp = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "scotty-copy-")),
      catch: () => error("temp directory"),
    });
    const transfer = Effect.gen(function* () {
      const missing = [];
      for (const [index, blob] of [manifest.config, ...manifest.layers].entries()) {
        const head = yield* target.request("HEAD", `blobs/${blob.digest}`, "head blob");
        if (head.status === 200) {
          yield* Effect.log(`skip ${blob.digest} (${blob.size} bytes)`);
          continue;
        }
        if (head.status !== 404) return yield* error("head blob", head.status);
        const response = yield* sourceGet(`blobs/${blob.digest}`, "source blob");
        yield* check(response, 200, "source blob");
        const path = join(temp, `${index}`);
        const size = yield* spool(response, blob, path);
        yield* Effect.log(`verified ${blob.digest} (${size} bytes)`);
        missing.push({ blob, path });
      }
      for (const { blob, path } of missing) {
        const start = yield* target.request("POST", "blobs/uploads/", "begin blob");
        yield* check(start, 202, "begin blob");
        const location = start.headers.get("location");
        if (!location) return yield* error("upload location", start.status);
        const url = new URL(
          location,
          `https://registry.cloudflare.com/v2/${account}/${repository}/`,
        );
        url.searchParams.set("digest", blob.digest);
        const pushed = yield* target.upload(url, "push blob", () => streamFile(path));
        yield* check(pushed, 201, "push blob");
        yield* Effect.log(`pushed ${blob.digest} (${blob.size} bytes)`);
      }
      const pushed = yield* target.request(
        "PUT",
        `manifests/${chosen}`,
        "push manifest",
        () => selected.content,
        selected.mediaType,
      );
      yield* check(pushed, 201, "push manifest");
      const head = yield* target.request("HEAD", `manifests/${chosen}`, "head manifest");
      yield* check(head, 200, "head manifest");
      if (head.headers.get("docker-content-digest") !== chosen)
        return yield* error("target manifest digest", head.status);
      yield* Effect.log(`published ${chosen}`);
      return `registry.cloudflare.com/${account}/${repository}@${chosen}`;
    });
    return yield* Effect.onExit(transfer, () => remove(temp));
  });
export const copyLayer = Cloudflare.CloudflareApiLive().pipe(
  Layer.provideMerge(PlatformServices),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(Layer.succeed(AuthProviders, {})),
);
export const copy = (input) => Effect.runPromise(copyImage(input).pipe(Effect.provide(copyLayer)));
