import { Option, Schema } from "effect";

// A login shell in the repository under a PTY, one per terminal socket. Bytes go both ways as
// binary frames; a text frame `{"type":"resize","cols","rows"}` resizes. The socket closes when
// the shell exits. The environment is the supervisor's: the ChatGPT token is only in Codex's
// config.toml, never in the environment.
interface Pty {
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}
interface Shell {
  readonly terminal: Pty | undefined;
  readonly exited: Promise<number>;
  kill(): void;
}
declare const Bun: {
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      terminal: { cols: number; rows: number; data(pty: Pty, data: Uint8Array): void };
    },
  ): Shell;
};
declare const process: { env: Record<string, string | undefined> };

interface TerminalPeer {
  send(data: Uint8Array): void;
  close(): void;
}

const dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));
const Size = Schema.Struct({ cols: dimension, rows: dimension });
export type Size = typeof Size.Type;
export const decodeSize = Schema.decodeUnknownOption(Size);
const decodeResize = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("resize"), ...Size.fields })),
);

const shells = new WeakMap<TerminalPeer, Shell>();
const repo = () => `${process.env.SCOTTY_WORKSPACE_ROOT || "/workspace"}/repo`;

export function openTerminal(peer: TerminalPeer, size: Size): void {
  try {
    const shell = Bun.spawn(["bash", "-l"], {
      cwd: repo(),
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        ...size,
        data: (_pty, data) => {
          try {
            peer.send(data);
          } catch {
            // The socket closed; its close handler ends the shell.
          }
        },
      },
    });
    shells.set(peer, shell);
    open++;
    void shell.exited.then(() => peer.close());
  } catch {
    peer.close();
  }
}

export function terminalInput(peer: TerminalPeer, data: string | Uint8Array): void {
  const pty = shells.get(peer)?.terminal;
  if (pty === undefined) return;
  if (typeof data !== "string") {
    pty.write(data);
    return;
  }
  const resize = Option.getOrUndefined(decodeResize(data));
  if (resize !== undefined) pty.resize(resize.cols, resize.rows);
}

let open = 0;
export const openTerminals = (): number => open;

export function closeTerminal(peer: TerminalPeer): void {
  const shell = shells.get(peer);
  if (shell !== undefined) open--;
  shells.delete(peer);
  shell?.terminal?.close();
  shell?.kill();
}
