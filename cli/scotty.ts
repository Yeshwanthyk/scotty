#!/usr/bin/env bun

export { EXIT } from "./src/core";
export { type CliDependencies } from "./src/dependencies";
export { main } from "./src/main";
export { EMBEDDED_SKILL } from "./src/pure";
export { STANDARD_TOOLSET, type StandardToolset } from "./src/schemas";

import { main } from "./src/main";

if (import.meta.main) process.exitCode = await main();
