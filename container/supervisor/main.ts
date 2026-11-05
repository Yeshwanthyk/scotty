import { Controller } from "./controller.js";
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
void main();
