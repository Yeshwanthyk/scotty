import { Controller } from "./controller.js";
import { serve } from "./socket.js";

function main(): void {
  const controller = new Controller();
  controller.bind(
    serve((message) => controller.receive(message), {
      save: (gen) => controller.save(gen),
      load: (tar) => controller.load(tar),
      skill: (name, zip) => controller.skill(name, zip),
    }),
  );
}
main();
