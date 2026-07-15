#!/usr/bin/env bun

import { runCli } from "./main";

process.exitCode = await runCli(process.argv.slice(2));
