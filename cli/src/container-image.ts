import {
  RuntimeImageCompatibilityEvidenceSchema,
  verifyRuntimeImageCompatibility,
  type RuntimeImageCompatibilityEvidence,
} from "../../protocol/runtime/runtime-image-compatibility";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform as hostPlatform, arch as hostArchitecture, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { Data, Duration, Effect, Option, Predicate, Redacted, Schedule, Schema } from "effect";

export const CONTAINER_IMAGE_PLATFORM = "linux/amd64" as const;
export const CRANE_VERSION = "0.20.3" as const;
const CRANE_RELEASE_ROOT = `https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}`;
const MAX_CRANE_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_CRANE_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const TERMINATION_GRACE_MS = 2_000;
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));
const ImageReference = Schema.String.check(
  Schema.isPattern(
    /^(?:localhost(?::[0-9]+)?|[a-z0-9.-]*\.[a-z0-9.-]+)\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u,
  ),
);
const Descriptor = Schema.Struct({
  mediaType: Schema.NonEmptyString,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digest: Digest,
});
const ImageManifest = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  mediaType: Schema.optionalKey(Schema.NonEmptyString),
  config: Descriptor,
  layers: Schema.Array(Descriptor),
});
const ImageConfiguration = Schema.Struct({
  architecture: Schema.Literal("amd64"),
  os: Schema.Literal("linux"),
});
export const ContainerImageReleaseManifestSchema = Schema.Struct({
  runtimeCompatibility: Schema.optionalKey(RuntimeImageCompatibilityEvidenceSchema),
  version: Schema.Literal(1),
  releaseTag: Schema.NonEmptyString,
  image: Schema.Struct({
    repository: Schema.NonEmptyString,
    digest: Digest,
    reference: ImageReference,
    platform: Schema.Literal(CONTAINER_IMAGE_PLATFORM),
    configDigest: Digest,
    revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  }),
});

const decodeReleaseManifestJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ContainerImageReleaseManifestSchema),
  { onExcessProperty: "ignore" },
);
const decodeManifestJson = Schema.decodeUnknownOption(Schema.fromJsonString(ImageManifest), {
  onExcessProperty: "ignore",
});
const decodeConfigurationJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ImageConfiguration),
  { onExcessProperty: "ignore" },
);
const isImageReference = Schema.is(ImageReference);
const isDigest = Schema.is(Digest);

export interface ContainerImageSource {
  readonly runtimeCompatibility?: RuntimeImageCompatibilityEvidence;
  readonly reference: string;
  readonly digest: string;
  readonly expectedConfigDigest?: string;
}

export class ContainerImageError extends Data.TaggedError("ContainerImageError")<{
  readonly reason:
    | "unsupported_host"
    | "helper_download_failed"
    | "helper_invalid"
    | "invalid_source"
    | "credentials_failed"
    | "copy_failed"
    | "verification_failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isContainerImageError = (value: unknown): value is ContainerImageError =>
  Predicate.isTagged(value, "ContainerImageError") &&
  Predicate.hasProperty(value, "reason") &&
  typeof value.reason === "string" &&
  Predicate.hasProperty(value, "message") &&
  typeof value.message === "string";

export interface CraneAsset {
  readonly archiveName: string;
  readonly archiveSha256: string;
  readonly executableSha256: string;
  readonly executableBytes: number;
}

const CRANE_ASSETS = {
  "darwin-arm64": {
    archiveName: "go-containerregistry_Darwin_arm64.tar.gz",
    archiveSha256: "7a46898cf7ba8b995ae8eed3a6c29d7038058b409d92ead456ff12b47a9dde37",
    executableSha256: "d34f51061a226d1b183480cc7fdc1f7ec410676445cbb2432d89900ac2eb1cb3",
    executableBytes: 10_646_450,
  },
  "darwin-x64": {
    archiveName: "go-containerregistry_Darwin_x86_64.tar.gz",
    archiveSha256: "03e520639a1898ceee815f88a07e41f2bd810e16d4f70506d7c399d925476bb6",
    executableSha256: "86d4e287adfdaf7de162ac89055d2ecc6da93f6365b602f79695099522d5601f",
    executableBytes: 11_096_128,
  },
  "linux-arm64": {
    archiveName: "go-containerregistry_Linux_arm64.tar.gz",
    archiveSha256: "d2235f7779cd39c6e40f43701d2512c997409f629fb53e621ede0d57d3f995e2",
    executableSha256: "34bdb2ae7a56139c69cf745ab5cad3d7368e69896d8980e7bcf1ca194854a2ef",
    executableBytes: 10_354_840,
  },
  "linux-x64": {
    archiveName: "go-containerregistry_Linux_x86_64.tar.gz",
    archiveSha256: "36c67a932f489b3f2724b64af90b599a8ef2aa7b004872597373c0ad694dc059",
    executableSha256: "675f3b2f1696c1f6bc55b1ef535163364119776999f3d1471e4558ed35bab548",
    executableBytes: 10_838_168,
  },
} as const satisfies Record<string, CraneAsset>;

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const reject = (error: ContainerImageError): never => {
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: host file/download adapters reject into the typed Effect wrapper
  throw error;
};

const readBounded = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  if (!response.ok)
    return reject(
      new ContainerImageError({
        reason: "helper_download_failed",
        message: `Crane download returned HTTP ${response.status}.`,
      }),
    );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes)
    return reject(
      new ContainerImageError({
        reason: "helper_download_failed",
        message: "Crane download exceeded its size limit.",
      }),
    );
  if (response.body === null)
    return reject(
      new ContainerImageError({
        reason: "helper_download_failed",
        message: "Download response had no body.",
      }),
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => void reader.cancel();
  signal.addEventListener("abort", abort, { once: true });
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: bounded web-stream reads must always release the reader
  try {
    while (true) {
      const next = await reader.read();
      if (signal.aborted)
        return reject(
          new ContainerImageError({
            reason: "helper_download_failed",
            message: "Download timed out or was interrupted.",
          }),
        );
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return reject(
          new ContainerImageError({
            reason: "helper_download_failed",
            message: "Download exceeded its size limit.",
          }),
        );
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const selectCraneAsset = (
  platform: NodeJS.Platform = hostPlatform(),
  architecture: string = hostArchitecture(),
): CraneAsset => {
  const selected = CRANE_ASSETS[`${platform}-${architecture}` as keyof typeof CRANE_ASSETS];
  if (selected === undefined)
    return reject(
      new ContainerImageError({
        reason: "unsupported_host",
        message: `Docker-free installation supports darwin/linux on arm64/x64, not ${platform}/${architecture}.`,
      }),
    );
  return selected;
};

const requireSecureDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    return reject(
      new ContainerImageError({
        reason: "helper_invalid",
        message: "Crane helper cache ancestry is not a real directory.",
      }),
    );
};

const validCachedCrane = async (path: string, asset: CraneAsset): Promise<boolean> => {
  const metadata = await lstat(path).then(
    (value) => value,
    () => undefined,
  );
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== asset.executableBytes ||
    (metadata.mode & 0o777) !== 0o700
  )
    return false;
  return (await sha256(await readFile(path))) === asset.executableSha256;
};

export type ContainerImageFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CraneInstallerOptions {
  readonly cacheRoot?: string;
  readonly fetch?: ContainerImageFetch;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly asset?: CraneAsset;
  readonly releaseRoot?: string;
  readonly downloadTimeoutMs?: number;
  readonly extract?: (archive: Uint8Array, staging: string) => Promise<void>;
}

export const installCrane = (options: CraneInstallerOptions = {}) =>
  Effect.tryPromise({
    try: async (signal) => {
      const asset = options.asset ?? selectCraneAsset(options.platform, options.architecture);
      const cacheRoot = options.cacheRoot ?? join(homedir(), ".cache", "scotty", "helpers");
      const targetDirectory = join(cacheRoot, `crane-v${CRANE_VERSION}`);
      const target = join(
        targetDirectory,
        `${options.platform ?? hostPlatform()}-${options.architecture ?? hostArchitecture()}`,
        "crane",
      );
      const targetParent = dirname(target);
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      await requireSecureDirectory(cacheRoot);
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      await requireSecureDirectory(targetDirectory);
      const release = await lockfile.lock(targetDirectory, {
        realpath: true,
        retries: { retries: 4, minTimeout: 50, maxTimeout: 500 },
      });
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: helper cache lock and staging directory require unconditional cleanup
      try {
        await requireSecureDirectory(cacheRoot);
        await requireSecureDirectory(targetDirectory);
        await mkdir(targetParent, { recursive: true, mode: 0o700 });
        await requireSecureDirectory(targetParent);
        if (await validCachedCrane(target, asset)) return target;
        await requireSecureDirectory(targetParent);
        await rm(target, { force: true });
        const downloadSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS),
        ]);
        const response = await (options.fetch ?? fetch)(
          `${options.releaseRoot ?? CRANE_RELEASE_ROOT}/${asset.archiveName}`,
          {
            headers: { "user-agent": "scotty-container-installer" },
            redirect: "follow",
            signal: downloadSignal,
          },
        );
        const archive = await readBounded(response, MAX_CRANE_ARCHIVE_BYTES, downloadSignal);
        if ((await sha256(archive)) !== asset.archiveSha256)
          return reject(
            new ContainerImageError({
              reason: "helper_invalid",
              message: "Downloaded Crane archive did not match Scotty's pinned digest.",
            }),
          );
        const staging = await mkdtemp(join(targetDirectory, ".install-"));
        // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: verified helper extraction removes staging on every exit
        try {
          if (options.extract) await options.extract(archive, staging);
          else await new Bun.Archive(archive).extract(staging);
          const extracted = join(staging, "crane");
          await chmod(extracted, 0o700);
          if (!(await validCachedCrane(extracted, asset)))
            return reject(
              new ContainerImageError({
                reason: "helper_invalid",
                message: "Extracted Crane executable did not match Scotty's pinned identity.",
              }),
            );
          await requireSecureDirectory(cacheRoot);
          await requireSecureDirectory(targetDirectory);
          await requireSecureDirectory(targetParent);
          await rename(extracted, target);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
        return target;
      } finally {
        await release();
      }
    },
    catch: (cause) =>
      isContainerImageError(cause)
        ? cause
        : new ContainerImageError({
            reason: "helper_download_failed",
            message: "Could not install the pinned Crane helper.",
            cause,
          }),
  });

export const parseContainerImageSource = (
  reference: string,
  expectedConfigDigest?: string,
): ContainerImageSource => {
  if (!isImageReference(reference))
    return reject(
      new ContainerImageError({
        reason: "invalid_source",
        message: "Container image must be a fully qualified digest-pinned OCI reference.",
      }),
    );
  const digest = reference.slice(reference.lastIndexOf("@") + 1);
  if (expectedConfigDigest !== undefined && !isDigest(expectedConfigDigest))
    return reject(
      new ContainerImageError({
        reason: "invalid_source",
        message: "Container image configuration digest is invalid.",
      }),
    );
  return { reference, digest, ...(expectedConfigDigest ? { expectedConfigDigest } : {}) };
};

export const decodeReleasedContainerImage = (
  text: string,
  releaseTag: string,
): ContainerImageSource => {
  const decoded = decodeReleaseManifestJson(text);
  if (Option.isNone(decoded) || decoded.value.releaseTag !== releaseTag)
    return reject(
      new ContainerImageError({
        reason: "invalid_source",
        message: "The Scotty release image manifest is invalid or belongs to another release.",
      }),
    );
  const source = parseContainerImageSource(
    decoded.value.image.reference,
    decoded.value.image.configDigest,
  );
  if (
    decoded.value.image.reference !==
      `${decoded.value.image.repository}@${decoded.value.image.digest}` ||
    source.digest !== decoded.value.image.digest
  )
    return reject(
      new ContainerImageError({
        reason: "invalid_source",
        message: "The Scotty release image manifest contains inconsistent image identity fields.",
      }),
    );
  return {
    ...source,
    ...(decoded.value.runtimeCompatibility === undefined
      ? {}
      : { runtimeCompatibility: decoded.value.runtimeCompatibility }),
  };
};

export const fetchReleasedContainerImage = Effect.fnUntraced(function* (
  version: string,
  fetcher: ContainerImageFetch = fetch,
) {
  const releaseTag = `v${version}`;
  const url = `https://github.com/Yeshwanthyk/scotty/releases/download/${releaseTag}/scotty-image-manifest.json`;
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetcher(url, {
        headers: { "user-agent": "scotty-container-installer" },
        redirect: "follow",
        signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      }),
    catch: (cause) =>
      new ContainerImageError({
        reason: "invalid_source",
        message: "Could not download the Scotty release image manifest.",
        cause,
      }),
  });
  if (!response.ok)
    return yield* new ContainerImageError({
      reason: "invalid_source",
      message: `Scotty release image manifest returned HTTP ${response.status}.`,
    });
  const bytes = yield* Effect.tryPromise({
    try: (signal) =>
      readBounded(
        response,
        128 * 1024,
        AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      ),
    catch: (cause) =>
      new ContainerImageError({
        reason: "invalid_source",
        message: "Could not read the Scotty release image manifest.",
        cause,
      }),
  });
  const source = yield* Effect.try({
    try: () => decodeReleasedContainerImage(new TextDecoder().decode(bytes), releaseTag),
    catch: (cause) =>
      isContainerImageError(cause)
        ? cause
        : new ContainerImageError({
            reason: "invalid_source",
            message: "The Scotty release image manifest could not be decoded.",
            cause,
          }),
  });
  yield* verifyContainerRuntimeCompatibility(source);
  return source;
});

export const verifyContainerRuntimeCompatibility = (source: ContainerImageSource) =>
  verifyRuntimeImageCompatibility(source.runtimeCompatibility, source.digest).pipe(
    Effect.mapError(
      () =>
        new ContainerImageError({
          reason: "invalid_source",
          message: "Standard image runtime compatibility evidence is missing or invalid.",
        }),
    ),
  );

export interface CraneCommand {
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

export type RunCrane = (
  executable: string,
  command: CraneCommand,
) => Effect.Effect<string, ContainerImageError>;

const readBoundedProcessOutput = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_CRANE_OUTPUT_BYTES) {
      await reader.cancel();
      return reject(
        new ContainerImageError({
          reason: "verification_failed",
          message: "Crane output exceeded its safety limit.",
        }),
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

export const runCraneProcess: RunCrane = (executable, command) =>
  Effect.try({
    try: () =>
      Bun.spawn([executable, ...command.args], {
        env: command.environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: (cause) =>
      new ContainerImageError({
        reason: "verification_failed",
        message: "Could not start the pinned Crane helper.",
        cause,
      }),
  }).pipe(
    Effect.flatMap((child) =>
      Effect.callback<string, ContainerImageError>((resume) => {
        let termination: Promise<void> | undefined;
        const terminateAndReap = (): Promise<void> => {
          if (termination !== undefined) return termination;
          termination = (async () => {
            child.kill("SIGTERM");
            const exitedDuringGrace = await Promise.race([
              child.exited.then(() => true),
              new Promise<false>((resolve) =>
                // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native child escalation requires a bounded host timer
                setTimeout(() => resolve(false), TERMINATION_GRACE_MS),
              ),
            ]);
            if (!exitedDuringGrace) child.kill("SIGKILL");
            await child.exited;
          })();
          return termination;
        };
        let completed = false;
        const failAfterReap = async (error: ContainerImageError): Promise<void> => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          await terminateAndReap();
          resume(Effect.fail(error));
        };
        // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native child timeout is escalated and reaped before completion
        const timer = setTimeout(
          () =>
            void failAfterReap(
              new ContainerImageError({
                reason: "verification_failed",
                message: "Crane execution timed out.",
              }),
            ),
          PROCESS_TIMEOUT_MS,
        );
        void Promise.all([
          readBoundedProcessOutput(child.stdout),
          readBoundedProcessOutput(child.stderr),
          child.exited,
        ]).then(
          ([stdout, _stderr, exitCode]) => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            resume(
              exitCode === 0
                ? Effect.succeed(stdout)
                : Effect.fail(
                    new ContainerImageError({
                      reason: command.args[0] === "copy" ? "copy_failed" : "verification_failed",
                      message:
                        command.args[0] === "copy"
                          ? "Docker-free container image transfer failed."
                          : "Container image verification failed.",
                    }),
                  ),
            );
          },
          (cause) =>
            failAfterReap(
              isContainerImageError(cause)
                ? cause
                : new ContainerImageError({
                    reason: "verification_failed",
                    message: "Could not execute the pinned Crane helper.",
                    cause,
                  }),
            ),
        );
        return Effect.promise(terminateAndReap);
      }),
    ),
  );

const inspectImage = Effect.fnUntraced(function* (
  executable: string,
  reference: string,
  environment: Readonly<Record<string, string>>,
  run: RunCrane,
) {
  const base = { environment };
  const [digestText, manifestText, configText] = yield* Effect.all(
    [
      run(executable, {
        ...base,
        args: ["digest", "--platform", CONTAINER_IMAGE_PLATFORM, reference],
      }),
      run(executable, {
        ...base,
        args: ["manifest", "--platform", CONTAINER_IMAGE_PLATFORM, reference],
      }),
      run(executable, {
        ...base,
        args: ["config", "--platform", CONTAINER_IMAGE_PLATFORM, reference],
      }),
    ],
    { concurrency: 3 },
  );
  const digest = digestText.trim();
  const manifest = decodeManifestJson(manifestText);
  const configuration = decodeConfigurationJson(configText);
  if (!isDigest(digest) || Option.isNone(manifest) || Option.isNone(configuration))
    return yield* new ContainerImageError({
      reason: "verification_failed",
      message: "Container image manifest, digest, or linux/amd64 configuration is invalid.",
    });
  return { digest, manifest: manifest.value };
});

export interface TransferContainerImageInput {
  readonly source: ContainerImageSource;
  readonly accountId: string;
  readonly repository: string;
  readonly username: string;
  readonly password: string | Redacted.Redacted<string>;
  readonly helper?: string;
  readonly cacheRoot?: string;
  readonly retryBaseDelay?: Duration.Input;
}

export const transferContainerImage = Effect.fnUntraced(function* (
  input: TransferContainerImageInput,
  run: RunCrane = runCraneProcess,
) {
  const executable = input.helper ?? (yield* installCrane({ cacheRoot: input.cacheRoot }));
  const authRoot = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "scotty-registry-auth-")),
      catch: (cause) =>
        new ContainerImageError({
          reason: "credentials_failed",
          message: "Could not create isolated registry authentication storage.",
          cause,
        }),
    }),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const password = Redacted.isRedacted(input.password)
    ? Redacted.value(input.password)
    : input.password;
  const auth = Buffer.from(`${input.username}:${password}`, "utf8").toString("base64");
  yield* Effect.tryPromise({
    try: () =>
      writeFile(
        join(authRoot, "config.json"),
        `${JSON.stringify({ auths: { "registry.cloudflare.com": { auth } } })}\n`,
        { mode: 0o600, flag: "wx" },
      ),
    catch: (cause) =>
      new ContainerImageError({
        reason: "credentials_failed",
        message: "Could not stage isolated registry credentials.",
        cause,
      }),
  });
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: authRoot,
    DOCKER_CONFIG: authRoot,
  };
  const source = yield* inspectImage(executable, input.source.reference, environment, run);
  if (
    source.digest !== input.source.digest ||
    (input.source.expectedConfigDigest !== undefined &&
      source.manifest.config.digest !== input.source.expectedConfigDigest)
  )
    return yield* new ContainerImageError({
      reason: "verification_failed",
      message: "Source image identity does not match the selected immutable release.",
    });
  const tag = input.source.digest.replace(":", "-");
  const targetTag = `registry.cloudflare.com/${input.accountId}/${input.repository}:${tag}`;
  yield* run(executable, {
    environment,
    args: ["copy", "--platform", CONTAINER_IMAGE_PLATFORM, input.source.reference, targetTag],
  }).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential(input.retryBaseDelay ?? Duration.seconds(1)).pipe(
        Schedule.jittered,
      ),
    }),
  );
  const target = yield* inspectImage(executable, targetTag, environment, run);
  if (
    target.digest !== source.digest ||
    target.manifest.config.digest !== source.manifest.config.digest ||
    JSON.stringify(target.manifest.layers) !== JSON.stringify(source.manifest.layers)
  )
    return yield* new ContainerImageError({
      reason: "verification_failed",
      message: "Transferred image manifest, configuration, or layers changed in transit.",
    });
  return `registry.cloudflare.com/${input.accountId}/${input.repository}@${target.digest}`;
});
