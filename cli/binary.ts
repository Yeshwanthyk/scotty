import pack from "../dist/release.pack" with { type: "file" };
import { useRelease } from "./release.ts";

useRelease(pack);
await import("./main.ts");
