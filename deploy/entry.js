// The Worker's entry as Alchemy generates it, untyped like its own, except that the stage comes from
// the Worker's own environment, so one bundle serves every stage.
import { env, DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge } from "alchemy/Cloudflare/Bridge";
import entrypoint from "../src/worker.ts";

const meta = { entrypoint, stack: { name: "scotty", stage: env.ALCHEMY_STAGE } };
export default makeWorkerBridge(WorkerEntrypoint, meta);
const DurableObjectBridge = makeDurableObjectBridge(DurableObject, meta);
export class CredsObject extends DurableObjectBridge("CredsObject") {}
export class SessionObject extends DurableObjectBridge("SessionObject") {}
