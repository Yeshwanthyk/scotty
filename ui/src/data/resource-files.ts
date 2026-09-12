import type { CloudResourceFile, CloudResourceKind } from "../../../protocol/cloud-resources";

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

export const prepareBrowserResourceFiles = async (
  selected: ReadonlyArray<File>,
  kind: CloudResourceKind,
  directory: boolean,
): Promise<ReadonlyArray<CloudResourceFile>> =>
  Promise.all(
    selected.map(async (file) => ({
      path: directory ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name,
      contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      modeClass: kind === "tool" && !directory ? ("executable" as const) : ("regular" as const),
    })),
  );
