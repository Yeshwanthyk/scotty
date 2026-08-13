#!/usr/bin/env bun

export { EXIT, VERSION } from "./src/core";
export { type CliDependencies } from "./src/dependencies";
export { main } from "./src/main";
export { STANDARD_TOOLSET, type StandardToolset } from "./src/schemas";

import { main } from "./src/main";

if (import.meta.main) process.exitCode = await main();
