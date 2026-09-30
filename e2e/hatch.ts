import { connect } from "node:tls";
import { Effect, Schema } from "effect";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  target,
  View,
} from "../cli/client.js";
import { Log, waiter } from "./lib/wait.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { fixtureRepo } from "../protocol/supervisor.js";

const Hatch = Schema.Struct({ url: Schema.String });
const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("hatch", message, "scotty doctor"));

// A Node server with no dependencies: GET answers the marker and the Host it received; /ws
// echoes one short masked text frame.
const server = (marker: string) => `import http from "node:http";
import { createHash } from "node:crypto";
const server = http.createServer((q, s) => s.end("${marker} " + q.headers.host));
server.on("upgrade", (q, sock) => {
  const key = createHash("sha1").update(q.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + key + "\\r\\n\\r\\n");
  sock.on("data", (b) => {
    const n = b[1] & 127, mask = b.subarray(2, 6), data = b.subarray(6, 6 + n).map((x, i) => x ^ mask[i % 4]);
    if ((b[0] & 15) === 1) sock.write(Buffer.concat([Buffer.from([0x81, n]), data]));
  });
});
server.listen(8080, "0.0.0.0");
`;

const get = (url: string, token?: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        redirect: "manual",
        headers: token === undefined ? {} : { "cf-access-token": token },
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.text() };
    },
    catch: () => failure("network", `GET ${url} failed`, "scotty doctor"),
  });

// Sends one masked text frame through a raw TLS upgrade and resolves with what came back.
const echo = (url: string, token: string, text: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const { hostname } = new URL(url);
        const socket = connect({ host: hostname, port: 443, servername: hostname }, () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: ${hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              `Sec-WebSocket-Key: ${btoa("scotty-hatch-e2e")}\r\nSec-WebSocket-Version: 13\r\n` +
              `cf-access-token: ${token}\r\n\r\n`,
          );
        });
        let received = "";
        let sent = false;
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString("latin1");
          if (!sent && received.includes("\r\n\r\n")) {
            if (!received.startsWith("HTTP/1.1 101")) return reject(new Error(received));
            sent = true;
            const mask = [1, 2, 3, 4];
            const payload = [...new TextEncoder().encode(text)].map(
              (x, i) => x ^ (mask[i % 4] ?? 0),
            );
            socket.write(Uint8Array.from([0x81, 0x80 | payload.length, ...mask, ...payload]));
          }
          if (sent && received.includes(text)) {
            socket.destroy();
            resolve(text);
          }
        });
        socket.on("error", reject);
        setTimeout(() => {
          socket.destroy();
          reject(new Error("WebSocket echo timed out"));
        }, 15000);
      }),
    catch: () => failure("hatch", "WebSocket to /ws did not echo", "scotty doctor"),
  });

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const token = yield* access(url);
  const request = client({ url, token });
  const base = process.env.SCOTTY_HATCH_BASE ?? "";
  const marker = `HATCH-${crypto.randomUUID().slice(0, 8)}`;
  const script = btoa(server(marker));
  const start =
    `echo ${script} | base64 -d > /workspace/server.mjs && mkdir -p /workspace/.scotty/logs && ` +
    "setsid nohup node /workspace/server.mjs > /workspace/.scotty/logs/server.log 2>&1 < /dev/null &";
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: `e2e hatch (${agent})`,
      repo: fixtureRepo,
      ...sessionAgent,
      prompt: prompt(
        `Run exactly: \`${start}\`, then reply with only the word done.`,
        `run ${start}\nsay done`,
      ),
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  yield* poll(
    () => request(`${prefix}/log`, Log),
    (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "0"),
  );
  const reply = yield* request(`${prefix}/conversation`, Conversation);
  console.log(`Turn 0 replied: ${reply.turns[0]?.assistant ?? ""}`);

  // 2. The URL is the one the API gives; it serves the marker with a localhost Host, and echoes.
  const hatch = yield* request(`${prefix}/hatch/8080`, Hatch);
  const expected = `https://8080-${session.id}.${base}`;
  yield* check(hatch.url === expected, `hatch returned ${hatch.url}, expected ${expected}`);
  const page = yield* poll(
    () => get(`${hatch.url}/`, token),
    (value) => value.status === 200,
  );
  yield* check(page.body.includes(marker), `GET / did not return the marker: ${page.body}`);
  yield* check(page.body.includes("localhost:8080"), `Server saw Host ${page.body}`);
  yield* echo(hatch.url, token, `ping-${marker}`);
  console.log("Preview: marker served with Host localhost:8080; WebSocket echoed");

  // 3. Without the token, Access answers and the marker never shows.
  const anonymous = yield* get(`${hatch.url}/`);
  yield* check(
    anonymous.status !== 200 && !anonymous.body.includes(marker),
    `Unauthenticated GET returned ${anonymous.status}`,
  );
  console.log(`Unauthenticated: ${anonymous.status}`);

  // 4. The supervisor port is refused; an unknown session is not running.
  const supervisor = yield* get(`https://7000-${session.id}.${base}/`, token);
  yield* check(supervisor.status === 404, `Port 7000 returned ${supervisor.status}`);
  const unknown = yield* get(`https://8080-nosuchsession.${base}/`, token);
  yield* check(unknown.status === 502, `Unknown session returned ${unknown.status}`);
  console.log("Refused: 7000 is 404, an unknown session is 502");

  // 5. After stop, the URL is 502 and the API says not_running.
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  const stopped = yield* get(`${hatch.url}/`, token);
  yield* check(stopped.status === 502, `Stopped session returned ${stopped.status}`);
  const refused = yield* request(`${prefix}/hatch/8080`, Hatch).pipe(
    Effect.flip,
    Effect.catch(() => Effect.succeed(undefined)),
  );
  yield* check(refused?.code === "not_running", "hatch on a stopped session was not not_running");
  console.log("Stopped: 502 and not_running");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Hatch e2e failed");
  process.exitCode = 1;
});
