import { FitAddon, Terminal, init } from "ghostty-web";

export async function attachGhosttyContract(
  host: HTMLElement,
  socket: Pick<WebSocket, "send">,
): Promise<Terminal> {
  await init();

  const terminal = new Terminal({
    cols: 80,
    rows: 24,
  });
  const fit = new FitAddon();

  terminal.loadAddon(fit);
  terminal.open(host);
  terminal.onData((data) => socket.send(data));
  terminal.write(new Uint8Array([0x1b, 0x5b, 0x32, 0x4a]));
  fit.fit();

  return terminal;
}
