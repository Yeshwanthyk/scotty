#!/usr/bin/env node
// Kanban board for focused work sessions. Data: docs/board.json (override with BOARD_FILE).
// No dependencies; the HTML view is a static file with the board inlined.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const file = process.env.BOARD_FILE ?? join(root, "docs/board.json");
const htmlOut = process.env.BOARD_HTML ?? join(root, "work/board.html");
const run = process.env.BOARD_RUN ?? "npm run -s board --";

const LABELS = { backlog: "Backlog", next: "Next", doing: "In progress", done: "Done" };
const tty = process.stdout.isTTY;
const paint = (code) => (text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = paint("2");
const bold = paint("1");
const warn = paint("33");
const ok = paint("32");

const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = (board) => writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`);
const today = () => new Date().toISOString().slice(0, 10);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const find = (board, id) => {
  const card = board.cards.find((c) => c.id.toLowerCase() === String(id ?? "").toLowerCase());
  return card ?? fail(`No card ${id ?? "(missing id)"}. Try: ${run} ls`);
};

const blockers = (board, card) =>
  card.deps.filter((dep) => board.cards.find((c) => c.id === dep)?.column !== "done");

const flag = (args, name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const [, value] = args.splice(index, 2);
  return value ?? fail(`${name} needs a value`);
};

const line = (board, card) => {
  const blocked = blockers(board, card);
  const tags = [
    card.contract ? warn("⚠") : " ",
    blocked.length > 0 && card.column !== "done" ? dim(`blocked by ${blocked.join(",")}`) : "",
    card.log.length > 0 ? dim(`${card.log.length} log`) : "",
    card.pr ? dim(`#${card.pr}`) : "",
  ].filter(Boolean);
  return `  ${bold(card.id.padEnd(6))} ${tags[0]} ${card.title} ${tags.slice(1).join(" ")}`.trimEnd();
};

const list = (board, filter) => {
  const wanted = filter?.toLowerCase();
  const columns = board.columns.filter((col) => !wanted || !LABELS[wanted] || col === wanted);
  for (const col of columns) {
    const cards = board.cards.filter(
      (c) =>
        c.column === col && (!wanted || LABELS[wanted] || c.id.toLowerCase().startsWith(wanted)),
    );
    if (cards.length === 0) continue;
    console.log(`\n${bold(LABELS[col])} ${dim(`(${cards.length})`)}`);
    for (const card of cards) console.log(line(board, card));
  }
  console.log();
};

const show = (board, card) => {
  const blocked = blockers(board, card);
  console.log(`\n${bold(`${card.id}  ${card.title}`)}`);
  console.log(
    dim(
      [
        LABELS[card.column],
        card.contract ? "contract change: confirm before coding" : "",
        card.deps.length > 0 ? `deps ${card.deps.join(", ")}` : "",
        blocked.length > 0 ? `blocked by ${blocked.join(", ")}` : "",
        card.pr ? `PR #${card.pr}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  console.log(`\n${card.body}\n`);
  if (card.log.length > 0) {
    console.log(bold("Handoff log"));
    for (const entry of card.log) console.log(`  ${dim(entry.at)}  ${entry.note}`);
    console.log();
  }
};

export const prompt = (board, card) => {
  const status = card.deps.map((dep) => {
    const other = board.cards.find((c) => c.id === dep);
    return `${dep} (${other ? LABELS[other.column] : "missing"})`;
  });
  const blocked = blockers(board, card);
  const last = card.log.slice(-3);
  return [
    `Work card ${card.id} on the ${board.name} board: ${card.title}`,
    "",
    "Setup",
    "1. Read AGENTS.md, then docs/reliability.md (rules, recurring mistakes, piece map).",
    `2. Run \`${run} show ${card.id}\` and read the card and its handoff log.`,
    `3. Run \`${run} start ${card.id}\` to move it to In progress.`,
    ...(status.length > 0 ? ["", `Dependencies: ${status.join(", ")}.`] : []),
    ...(blocked.length > 0
      ? [`Not done yet: ${blocked.join(", ")}. Tell me before starting and wait for my answer.`]
      : []),
    ...(card.contract
      ? [
          "",
          "This card changes a public contract, persisted state or core lifecycle. Present the design and get my approval before writing code.",
        ]
      : []),
    ...(last.length > 0
      ? ["", "Recent handoff notes:", ...last.map((e) => `- ${e.at}: ${e.note}`)]
      : []),
    "",
    "While working",
    "- Re-verify every cited path:line against current main first; line numbers drift.",
    "- Root fix only, no backward compatibility. Delete what the fix makes obsolete, including unit tests the new e2e supersedes.",
    "- Follow the Effect v4 rc.112 patterns in vendor/effect and .agents/skills.",
    "- The card's Proof is an e2e or deployed test. Keep unit tests only for pure branchy logic or security/parsing boundaries.",
    "- Every test you add or touch must catch a regression that no other CI test catches (docs/reliability.md, Rules). Delete the rest, citing the covering CI test as file:line.",
    "- Fix types at the root, including narrow production signature changes. A new suppression, cast helper, `unknown → T` function or behavior-changing fallback is a failure: report it instead of working around it.",
    "- If you delegate, verify before accepting: grep the diff for new suppressions and casts, read every production hunk, and run the full `npm run test:all` yourself.",
    `- Findings outside this card go on the board, not into this change: \`${run} add <ID> "<title>"\`.`,
    "",
    "Before you stop, even mid-way",
    `- \`${run} log ${card.id} "<done so far; next step; open questions; branch or PR>"\``,
    `- After merge: \`${run} done ${card.id} --pr <number>\``,
  ].join("\n");
};

const render = (board) => {
  const template = readFileSync(join(here, "board.html"), "utf8");
  const data = {
    ...board,
    run,
    renderedAt: new Date().toISOString(),
    prompts: Object.fromEntries(board.cards.map((c) => [c.id, prompt(board, c)])),
  };
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  mkdirSync(dirname(htmlOut), { recursive: true });
  writeFileSync(
    htmlOut,
    template.replace("__BOARD_DATA__", () => json),
  );
  return htmlOut;
};

const HELP = `board: kanban for focused sessions (data: ${file})

  ls [column|prefix]         list cards (columns: backlog next doing done; prefix: R, D-0…)
  next                       cards in Next whose deps are done
  show <id>                  card body, deps and handoff log
  prompt <id>                print the prompt that starts a session on <id>
  start <id>                 move to In progress and log it
  log <id> <note…>           append a dated handoff note
  move <id> <column> [--at N]  move card (optionally to position N within the column)
  done <id> [--pr N]         move to Done
  add <id> <title…> [--col C] [--dep ID] [--contract]
  html [--open]              render ${htmlOut}
`;

const commit = (board, fn) => {
  fn();
  save(board);
  render(board);
};

const COMMANDS = {
  ls: (board, [filter]) => list(board, filter),
  next: (board) => {
    const ready = board.cards.filter((c) => c.column === "next" && blockers(board, c).length === 0);
    if (ready.length === 0) return console.log("Nothing ready in Next.");
    for (const card of ready) console.log(line(board, card));
  },
  show: (board, [id]) => show(board, find(board, id)),
  prompt: (board, [id]) => console.log(prompt(board, find(board, id))),
  start: (board, [id]) => {
    const card = find(board, id);
    commit(board, () => {
      card.column = "doing";
      card.log.push({ at: today(), note: "Started." });
    });
    const blocked = blockers(board, card);
    if (blocked.length > 0) console.log(warn(`Note: blocked by ${blocked.join(", ")}`));
    console.log(ok(`${card.id} → In progress`));
  },
  log: (board, [id, ...words]) => {
    const card = find(board, id);
    const note = words.join(" ").trim() || fail("Usage: log <id> <note…>");
    commit(board, () => card.log.push({ at: today(), note }));
    console.log(ok(`Logged on ${card.id}`));
  },
  move: (board, rest) => {
    const at = flag(rest, "--at");
    const [id, column] = rest;
    const card = find(board, id);
    if (!board.columns.includes(column)) fail(`Column must be one of: ${board.columns.join(", ")}`);
    commit(board, () => {
      card.column = column;
      board.cards.splice(board.cards.indexOf(card), 1);
      const peers = board.cards.filter((c) => c.column === column);
      const anchor = at === undefined ? undefined : peers[Number(at) - 1];
      board.cards.splice(anchor ? board.cards.indexOf(anchor) : board.cards.length, 0, card);
    });
    console.log(ok(`${card.id} → ${LABELS[column]}`));
  },
  done: (board, rest) => {
    const pr = flag(rest, "--pr");
    const card = find(board, rest[0]);
    commit(board, () => {
      card.column = "done";
      if (pr) card.pr = Number(pr);
      card.log.push({ at: today(), note: pr ? `Done in PR #${pr}.` : "Done." });
    });
    console.log(ok(`${card.id} → Done`));
  },
  add: (board, rest) => {
    const column = flag(rest, "--col") ?? "backlog";
    const dep = flag(rest, "--dep");
    const contract = rest.includes("--contract");
    const [id = "", ...words] = rest.filter((a) => a !== "--contract");
    if (!/^[A-Z]-\d+[a-z]?$/u.test(id)) fail("Id looks like R-16, C-11, D-17…");
    if (!board.columns.includes(column)) fail(`Column must be one of: ${board.columns.join(", ")}`);
    if (board.cards.some((c) => c.id === id)) fail(`${id} already exists`);
    const title = words.join(" ").trim() || fail("Usage: add <id> <title…>");
    const deps = dep ? dep.split(",") : [];
    const log = [{ at: today(), note: "Added." }];
    commit(board, () => board.cards.push({ id, title, column, contract, deps, body: "", log }));
    console.log(ok(`Added ${id}. Edit its body in ${file}.`));
  },
  html: (board, rest) => {
    const out = render(board);
    console.log(out);
    if (rest.includes("--open")) execFileSync("open", [out]);
  },
  help: () => console.log(HELP),
};
COMMANDS.handoff = COMMANDS.log;

const main = ([command = "ls", ...rest]) => {
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!handler) fail(HELP);
  handler(load(), rest);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
