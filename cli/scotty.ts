#!/usr/bin/env bun

export { EXIT, VERSION } from "./src/core";
export { type CliDependencies } from "./src/dependencies";
export { main } from "./src/main";

import { main } from "./src/main";

if (import.meta.main) process.exitCode = await main();
