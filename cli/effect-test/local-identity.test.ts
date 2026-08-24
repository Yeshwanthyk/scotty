import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem as PlatformFileSystem, Option, Result } from "effect";
import { join } from "node:path";
import {
  clientCredentialPath,
  credentialDirectoryPath,
  localCredentialPath,
  rootCredentialPath,
  scottyStateRoot,
} from "../src/local-paths";
import {
  loadClientIdentity,
  loadRootIdentity,
  removeRootIdentity,
  saveClientIdentity,
  saveRootIdentity,
} from "../src/local-identity";
import {
  CredentialStoreFailure,
  CredentialStoreUnavailable,
  type CredentialStoreShape,
  type FileSystemShape,
  makeProcessCredentialStore,
  PrivateFileError,
  cliLayer,
} from "../src/services";

const unavailableStore = (): CredentialStoreShape => ({
  load: () => Effect.fail(new CredentialStoreUnavailable({ operation: "load" })),
  save: () => Effect.fail(new CredentialStoreUnavailable({ operation: "save" })),
  remove: () => Effect.fail(new CredentialStoreUnavailable({ operation: "remove" })),
});

const runtimeOverrides = (
  home: string,
  state: string,
  credentialStore: CredentialStoreShape,
  fileSystem?: Partial<FileSystemShape>,
) => ({
  home,
  env: { XDG_STATE_HOME: state },
  credentialStore,
  fileSystem,
  stdoutIsTTY: false,
  stdinIsTTY: false,
});
const failureOf = <A, E>(result: Result.Result<A, E>): E =>
  Option.getOrThrow(Result.getFailure(result));

describe("CLI local identities", () => {
  it.effect("uses the injectable OS store without creating a fallback file", () =>
    Effect.gen(function* () {
      const platformFs = yield* PlatformFileSystem.FileSystem;
      const temporary = yield* platformFs.makeTempDirectoryScoped({
        prefix: "scotty-identity-keychain-",
      });
      const state = join(temporary, "state");
      yield* platformFs.makeDirectory(state, { mode: 0o700 });
      const calls: Array<string> = [];
      const store: CredentialStoreShape = {
        load: (name) => {
          calls.push(`load:${name}`);
          return Effect.succeed(name === "root" ? "keychain-root" : undefined);
        },
        save: (name, value) => {
          calls.push(`save:${name}:${value}`);
          return Effect.void;
        },
        remove: (name) => {
          calls.push(`remove:${name}`);
          return Effect.void;
        },
      };
      const layer = cliLayer(runtimeOverrides(temporary, state, store));

      assert.strictEqual(yield* loadRootIdentity().pipe(Effect.provide(layer)), "keychain-root");
      yield* saveClientIdentity("keychain-client").pipe(Effect.provide(layer));
      yield* removeRootIdentity().pipe(Effect.provide(layer));
      assert.deepStrictEqual(calls, ["load:root", "save:client:keychain-client", "remove:root"]);
      assert.isFalse(
        yield* platformFs.exists(credentialDirectoryPath(temporary, { XDG_STATE_HOME: state })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "falls back only when the OS store is unavailable and keeps both identities private",
    () =>
      Effect.gen(function* () {
        const platformFs = yield* PlatformFileSystem.FileSystem;
        const temporary = yield* platformFs.makeTempDirectoryScoped({
          prefix: "scotty-identity-fallback-",
        });
        const state = join(temporary, "state");
        yield* platformFs.makeDirectory(state, { mode: 0o700 });
        const layer = cliLayer(runtimeOverrides(temporary, state, unavailableStore()));

        yield* saveRootIdentity("root-fallback").pipe(Effect.provide(layer));
        yield* saveClientIdentity("client-fallback").pipe(Effect.provide(layer));
        assert.strictEqual(yield* loadRootIdentity().pipe(Effect.provide(layer)), "root-fallback");
        assert.strictEqual(
          yield* loadClientIdentity().pipe(Effect.provide(layer)),
          "client-fallback",
        );

        const stateRoot = scottyStateRoot(temporary, { XDG_STATE_HOME: state });
        const credentials = credentialDirectoryPath(temporary, { XDG_STATE_HOME: state });
        assert.strictEqual((yield* platformFs.stat(stateRoot)).mode & 0o777, 0o700);
        assert.strictEqual((yield* platformFs.stat(credentials)).mode & 0o777, 0o700);
        assert.strictEqual(
          (yield* platformFs.stat(rootCredentialPath(temporary, { XDG_STATE_HOME: state }))).mode &
            0o777,
          0o600,
        );
        assert.strictEqual(
          (yield* platformFs.stat(clientCredentialPath(temporary, { XDG_STATE_HOME: state })))
            .mode & 0o777,
          0o600,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes a fallback credential only through explicit removal", () =>
    Effect.gen(function* () {
      const platformFs = yield* PlatformFileSystem.FileSystem;
      const temporary = yield* platformFs.makeTempDirectoryScoped({
        prefix: "scotty-identity-remove-",
      });
      const state = join(temporary, "state");
      yield* platformFs.makeDirectory(state, { mode: 0o700 });
      const unavailableLayer = cliLayer(runtimeOverrides(temporary, state, unavailableStore()));
      yield* saveRootIdentity("explicit-only").pipe(Effect.provide(unavailableLayer));
      const path = rootCredentialPath(temporary, { XDG_STATE_HOME: state });
      assert.isTrue(yield* platformFs.exists(path));

      const calls: Array<string> = [];
      const store: CredentialStoreShape = {
        load: () => Effect.succeed(undefined),
        save: () => Effect.void,
        remove: (name) => {
          calls.push(name);
          return Effect.void;
        },
      };
      yield* removeRootIdentity().pipe(
        Effect.provide(cliLayer(runtimeOverrides(temporary, state, store))),
      );
      assert.deepStrictEqual(calls, ["root"]);
      assert.isFalse(yield* platformFs.exists(path));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not fall back after an OS-store permission failure", () =>
    Effect.gen(function* () {
      const platformFs = yield* PlatformFileSystem.FileSystem;
      const temporary = yield* platformFs.makeTempDirectoryScoped({
        prefix: "scotty-identity-permission-",
      });
      const state = join(temporary, "state");
      yield* platformFs.makeDirectory(state, { mode: 0o700 });
      let fallbackWrites = 0;
      const fileSystem: Partial<FileSystemShape> = {
        writePrivateCredential: () => {
          fallbackWrites += 1;
          return Effect.fail(new PrivateFileError({ path: "unused", reason: "write_failed" }));
        },
      };
      const store: CredentialStoreShape = {
        load: () =>
          Effect.fail(new CredentialStoreFailure({ operation: "load", reason: "permission" })),
        save: () =>
          Effect.fail(new CredentialStoreFailure({ operation: "save", reason: "permission" })),
        remove: () =>
          Effect.fail(new CredentialStoreFailure({ operation: "remove", reason: "permission" })),
      };
      const result = yield* Effect.result(
        saveRootIdentity("must-not-fallback").pipe(
          Effect.provide(cliLayer(runtimeOverrides(temporary, state, store, fileSystem))),
        ),
      );
      assert.isTrue(Result.isFailure(result));
      const error = failureOf(result);
      assert.strictEqual(error.reason, "credential_store_permission");
      assert.strictEqual(fallbackWrites, 0);

      const corruptStore: CredentialStoreShape = {
        load: () =>
          Effect.fail(new CredentialStoreFailure({ operation: "load", reason: "corrupt" })),
        save: () =>
          Effect.fail(new CredentialStoreFailure({ operation: "save", reason: "corrupt" })),
        remove: () =>
          Effect.fail(new CredentialStoreFailure({ operation: "remove", reason: "corrupt" })),
      };
      const corruptResult = yield* Effect.result(
        saveRootIdentity("must-not-fallback").pipe(
          Effect.provide(cliLayer(runtimeOverrides(temporary, state, corruptStore, fileSystem))),
        ),
      );
      assert.isTrue(Result.isFailure(corruptResult));
      assert.strictEqual(failureOf(corruptResult).reason, "credential_store_corrupt");
      assert.strictEqual(fallbackWrites, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unsafe fallback parents and files", () =>
    Effect.gen(function* () {
      const platformFs = yield* PlatformFileSystem.FileSystem;
      const temporary = yield* platformFs.makeTempDirectoryScoped({
        prefix: "scotty-identity-unsafe-",
      });
      const state = join(temporary, "state");
      const stateRoot = scottyStateRoot(temporary, { XDG_STATE_HOME: state });
      const credentials = credentialDirectoryPath(temporary, { XDG_STATE_HOME: state });
      yield* platformFs.makeDirectory(stateRoot, { recursive: true, mode: 0o700 });
      yield* platformFs.makeDirectory(credentials, { mode: 0o755 });
      const layer = cliLayer(runtimeOverrides(temporary, state, unavailableStore()));

      const unsafeParent = yield* Effect.result(
        saveRootIdentity("secret").pipe(Effect.provide(layer)),
      );
      assert.isTrue(Result.isFailure(unsafeParent));
      assert.strictEqual(failureOf(unsafeParent).reason, "permissions");

      yield* platformFs.chmod(credentials, 0o700);
      yield* platformFs.writeFileString(
        rootCredentialPath(temporary, { XDG_STATE_HOME: state }),
        "old\n",
        {
          mode: 0o600,
        },
      );
      yield* platformFs.chmod(rootCredentialPath(temporary, { XDG_STATE_HOME: state }), 0o644);
      const unsafeFile = yield* Effect.result(loadRootIdentity().pipe(Effect.provide(layer)));
      assert.isTrue(Result.isFailure(unsafeFile));
      assert.strictEqual(failureOf(unsafeFile).reason, "permissions");

      const linkTarget = join(temporary, "link-target");
      yield* platformFs.makeDirectory(linkTarget, { mode: 0o700 });
      yield* platformFs.remove(credentials, { recursive: true });
      yield* platformFs.symlink(linkTarget, credentials);
      const unsafeLink = yield* Effect.result(
        saveClientIdentity("secret").pipe(Effect.provide(layer)),
      );
      assert.isTrue(Result.isFailure(unsafeLink));
      assert.strictEqual(failureOf(unsafeLink).reason, "symlink");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves the previous value when an injected atomic write fails", () =>
    Effect.gen(function* () {
      const platformFs = yield* PlatformFileSystem.FileSystem;
      const temporary = yield* platformFs.makeTempDirectoryScoped({
        prefix: "scotty-identity-atomic-",
      });
      const state = join(temporary, "state");
      yield* platformFs.makeDirectory(state, { mode: 0o700 });
      const initialLayer = cliLayer(runtimeOverrides(temporary, state, unavailableStore()));
      yield* saveRootIdentity("previous").pipe(Effect.provide(initialLayer));

      const fileSystem: Partial<FileSystemShape> = {
        writePrivateCredential: (path) =>
          Effect.fail(new PrivateFileError({ path, reason: "atomic_replace_failed" })),
      };
      const layer = cliLayer(runtimeOverrides(temporary, state, unavailableStore(), fileSystem));
      const result = yield* Effect.result(
        saveRootIdentity("replacement").pipe(Effect.provide(layer)),
      );
      assert.isTrue(Result.isFailure(result));
      assert.strictEqual(failureOf(result).reason, "atomic_replace_failed");
      assert.strictEqual(
        (yield* platformFs.readFileString(
          rootCredentialPath(temporary, { XDG_STATE_HOME: state }),
        )).trim(),
        "previous",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("resolves canonical XDG root and client paths", () => {
    const env = {
      XDG_STATE_HOME: "/xdg/state",
    };
    assert.strictEqual(scottyStateRoot("/home/test", env), "/xdg/state/scotty");
    assert.strictEqual(credentialDirectoryPath("/home/test", env), "/xdg/state/scotty/credentials");
    assert.strictEqual(rootCredentialPath("/home/test", env), "/xdg/state/scotty/credentials/root");
    assert.strictEqual(
      clientCredentialPath("/home/test", env),
      "/xdg/state/scotty/credentials/client",
    );
    assert.strictEqual(
      localCredentialPath("/home/test", env, "client"),
      clientCredentialPath("/home/test", env),
    );
  });

  it.effect("keeps process-backed keychain commands free of secret arguments", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly command: ReadonlyArray<string>; readonly input?: string }> = [];
      const processRunner = {
        run: (command: ReadonlyArray<string>, options?: { readonly input?: string }) => {
          calls.push({ command, input: options?.input });
          return Effect.succeed({ exitCode: 0, stdout: "root-secret\n", stderr: "" });
        },
      };
      const store = makeProcessCredentialStore(processRunner, "darwin");
      assert.strictEqual(yield* store.load("root"), "root-secret");
      yield* store.save("client", "client-secret");
      assert.deepStrictEqual(calls[0], {
        command: ["security", "find-generic-password", "-s", "scotty", "-a", "root", "-w"],
        input: undefined,
      });
      assert.deepStrictEqual(calls[1], {
        command: ["security", "add-generic-password", "-s", "scotty", "-a", "client", "-U", "-w"],
        input: "client-secret\n",
      });
      assert.notInclude(
        calls.flatMap((call) => call.command),
        "client-secret",
      );
    }),
  );
});
