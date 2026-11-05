import { Controller } from "./controller.js";
import { exit } from "./runtime.js";
import { serve } from "./socket.js";

async function main(): Promise<void> {
  const controller = new Controller();
  controller.bind(
    await serve((message) => controller.receive(message), {
      save: (gen) => controller.save(gen),
      load: (tar) => controller.load(tar),
      skills: (commit, tarball) => controller.skills(commit, tarball),
      shutdown: controller.shutdown(),
    }),
  );
}
// A boot that can't load the key or read the disk exits, so the place sees the container stop.
main().catch((error: unknown) => {
  console.error("supervisor boot failed:", error instanceof Error ? error.message : String(error));
  exit(1);
});
