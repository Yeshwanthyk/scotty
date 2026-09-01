import { Option, Schema } from "effect";

// oxlint-disable-next-line scotty/no-storage-key-literal -- this store owns the local Sandbox provider observation
export const LOCAL_CONTAINER_INCARNATION_STORAGE_KEY = "scotty:sandbox:local-container-incarnation";

const LocalContainerIncarnationSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
});
const decodeLocalContainerIncarnation = Schema.decodeUnknownOption(
  LocalContainerIncarnationSchema,
  { onExcessProperty: "error" },
);

export interface SandboxRuntimeIncarnationStore {
  readonly markLocalStarted: () => Promise<string>;
  readonly readLocal: () => Promise<string | null>;
  readonly clearLocal: () => Promise<void>;
}

export const durableObjectSandboxRuntimeIncarnationStore = (
  storage: DurableObjectStorage,
): SandboxRuntimeIncarnationStore => ({
  markLocalStarted: async () => {
    const id = `local:${crypto.randomUUID()}`;
    await storage.put(LOCAL_CONTAINER_INCARNATION_STORAGE_KEY, { version: 1, id });
    return id;
  },
  readLocal: async () => {
    const decoded = decodeLocalContainerIncarnation(
      await storage.get(LOCAL_CONTAINER_INCARNATION_STORAGE_KEY),
    );
    return Option.isSome(decoded) ? decoded.value.id : null;
  },
  clearLocal: async () => {
    await storage.delete(LOCAL_CONTAINER_INCARNATION_STORAGE_KEY);
  },
});
