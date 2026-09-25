#!/usr/bin/env node
import { runServer } from "/opt/scotty-claude/scotty-claude-server.mjs";

runServer(process.argv.slice(2));
