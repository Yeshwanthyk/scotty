import { Controller } from "./controller.js";
import { serve } from "./socket.js";

function main(): void {
  const controller = new Controller();
  controller.bind(serve((message) => controller.receive(message)));
}
main();
