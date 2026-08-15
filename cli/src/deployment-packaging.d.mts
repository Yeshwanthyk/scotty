export {
  ARCHIVE_PUBLIC_ASSETS,
  CLI_SOURCE_TREES,
  CONTAINER_CONTEXT_BUDGET,
  CONTAINER_CONTEXT_PATH,
  CONTAINER_IMAGE_BUDGET,
  CONTAINER_INPUTS,
  CONTAINER_RUNTIME_ASSETS,
  CONTAINER_STATIC_INPUTS,
  DEPLOYMENT_ARCHIVE_NAME,
  DEPLOYMENT_ENTRIES,
  DEPLOYMENT_EXCLUSIONS,
  DEPLOYMENT_INPUTS,
  DEPLOYMENT_PACKAGING,
  coversProjectPath,
  isCoveredByProjectInputs,
  isDeploymentArchiveFileName,
  isExcludedProjectPath,
  isIncludedProjectPath,
  isSafeProjectPath,
  normalizeProjectPath,
  projectContainerContextInputs,
} from "./deployment-packaging.ts";

export type {
  DeploymentPackagingCategory,
  DeploymentPackagingEntry,
} from "./deployment-packaging.ts";

export const assertSafeProjectPath: (source: string) => string;
export const projectContainerCliInputs: (metafile: unknown) => string[];
export const discoverContainerCliInputs: (
  root?: string,
  execute?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ) => Promise<unknown>,
) => Promise<string[]>;
export const listPackagedFiles: (root: string, inputs: readonly string[]) => Promise<string[]>;
export const materializeProjectInputs: (
  root: string,
  destination: string,
  inputs: readonly string[],
) => Promise<void>;
export const measureContainerContext: (contextRoot: string) => Promise<{
  readonly files: string[];
  readonly fileCount: number;
  readonly bytes: number;
}>;
export const assertContainerContextBudget: (contextRoot: string) => Promise<{
  readonly files: string[];
  readonly fileCount: number;
  readonly bytes: number;
}>;
export const assertContainerImageBudget: (sizeBytes: number) => number;
export const inspectContainerImageBudget: (
  image: string,
  options?: {
    readonly exec?: (
      command: string,
      args: readonly string[],
    ) => Promise<{ readonly stdout: string }>;
    readonly inspectArgs?: readonly string[];
  },
) => Promise<number>;
export const prepareContainerContext: (
  root?: string,
  options?: {
    readonly discoverCliInputs?: (root: string) => Promise<readonly string[]>;
    readonly inputs?: readonly string[];
    readonly projectPiInstall?: (context: string) => Promise<unknown>;
  },
) => Promise<void>;
