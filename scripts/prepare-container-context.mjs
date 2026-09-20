import { pathToFileURL } from "node:url";
import {
  CONTAINER_CONTEXT_PATH,
  CONTAINER_STATIC_INPUTS,
  discoverContainerBuildInputs,
  prepareContainerContext,
  projectContainerBuildInputs,
} from "../cli/src/deployment-packaging.mjs";

export {
  CONTAINER_CONTEXT_PATH,
  CONTAINER_STATIC_INPUTS,
  discoverContainerBuildInputs,
  prepareContainerContext,
  projectContainerBuildInputs,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await prepareContainerContext();
}
