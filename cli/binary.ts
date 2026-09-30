// The compiled CLI's entry: the release it deploys is built into the binary.
import pack from "../dist/release.pack" with { type: "file" };
import { useRelease } from "./release.ts";

useRelease(pack);
await import("./main.ts");
