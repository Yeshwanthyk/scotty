import { Controller } from "./controller.js";
import { serve } from "./socket.js";

const main: () => void = function main() {
  const controller = new Controller();
  controller.bind(
    serve((message) => controller.receive(message), {
      save: (gen) => controller.save(gen),
      load: (tar) => controller.load(tar),
      skills: (commit, tarball) => controller.skills(commit, tarball),
    }),
  );
};
main();
