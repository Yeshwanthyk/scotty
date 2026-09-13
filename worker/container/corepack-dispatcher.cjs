#!/usr/bin/env node
// Corepack 0.35 uses Node's bundled Undici 7, which crashes if a downloaded
// response is paused when its socket closes (nodejs/undici#5360). Keep the
// patched dispatcher inside Corepack; ordinary Node applications stay native.
const { basename } = require("node:path");
const {
  Agent,
  EnvHttpProxyAgent,
  setGlobalDispatcher,
} = require("/usr/local/lib/node_modules/undici");

const command = basename(process.argv[1] ?? "");
if (!new Set(["corepack", "pnpm", "pnpx", "yarn", "yarnpkg"]).has(command)) {
  throw new Error("Unsupported Corepack command");
}

setGlobalDispatcher(process.env.NODE_USE_ENV_PROXY === "1" ? new EnvHttpProxyAgent() : new Agent());
require(`/usr/local/lib/node_modules/corepack/dist/${command}.js`);
