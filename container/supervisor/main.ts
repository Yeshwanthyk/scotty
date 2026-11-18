import { Controller } from "./controller.js";
import { exit } from "./runtime.js";
import { serve } from "./socket.js";

const main: () => Promise<void> = async function main() {
  const controller = new Controller();
  controller.bind(
    await serve((message) => controller.receive(message), {
      save: (gen) => controller.save(gen),
      load: (tar) => controller.load(tar),
      skills: (commit, tarball) => controller.skills(commit, tarball),
      shutdown: controller.shutdown(),
    }),
  );
};
main().catch((error: unknown) => {
  console.error("supervisor boot failed:", error instanceof Error ? error.message : String(error));
  exit(1);
});
