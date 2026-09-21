export type SandboxBundleItemKind = "skill" | "package" | "tool" | "extension";

export type SandboxBundleItemShape = "file" | "directory";

const textEncoder = new TextEncoder();

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

export const sandboxBundleItemDigestMaterial = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly size: number;
    readonly modeClass: "regular" | "executable";
    readonly digest: string;
  }>,
): string =>
  [...files]
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((file) => `${file.path}\0${String(file.size)}\0${file.modeClass}\0${file.digest}\n`)
    .join("");

export const sandboxBundleItemRoot = (kind: SandboxBundleItemKind): string =>
  kind === "package" ? "pi-packages" : `${kind}s`;

export const sandboxBundleItemFilePath = (
  item: {
    readonly kind: SandboxBundleItemKind;
    readonly name: string;
    readonly shape: SandboxBundleItemShape;
  },
  path: string,
): string =>
  item.shape === "file"
    ? `${sandboxBundleItemRoot(item.kind)}/${path}`
    : `${sandboxBundleItemRoot(item.kind)}/${item.name}/${path}`;
