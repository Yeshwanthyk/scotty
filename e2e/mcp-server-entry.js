import { env, DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge } from "alchemy/Cloudflare/Bridge";
import entrypoint from "./mcp-server.ts";
const meta = { entrypoint, stack: { name: "scotty", stage: env.ALCHEMY_STAGE } };
export default makeWorkerBridge(WorkerEntrypoint, meta);
const bridge = makeDurableObjectBridge(DurableObject, meta);
export class McpTestObject extends bridge("McpTestObject") {}
