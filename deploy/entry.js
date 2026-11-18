import { env, DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge } from "alchemy/Cloudflare/Bridge";
import entrypoint from "../src/worker.ts";

const meta = { entrypoint, stack: { name: "scotty", stage: env.ALCHEMY_STAGE } };
export default makeWorkerBridge(WorkerEntrypoint, meta);
const DurableObjectBridge = makeDurableObjectBridge(DurableObject, meta);
export class CredsObject extends DurableObjectBridge("CredsObject") {}
export class SessionObject extends DurableObjectBridge("SessionObject") {}
