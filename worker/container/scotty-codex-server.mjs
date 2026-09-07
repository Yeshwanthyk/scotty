#!/usr/bin/env node
import { runServer } from "./scotty-codex-server.mjs";

runServer(process.argv.slice(2));
