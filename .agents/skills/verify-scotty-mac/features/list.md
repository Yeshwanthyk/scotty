# Session list

The sidebar lists sessions grouped by day, filters by chip, and updates by push without a reload.

## Behaviors

- **L1** Rows show title, repository, age and a status mark (spinner working, dot failed or waiting).
- **L2** Groups Today, This week, Older; stopped sessions fold behind "Stopped N".
- **L3** Chips All, Mine, Automations, Running filter the list.
- **L4** A change on the server (a steer elsewhere, a new session) moves the row without a reload.

## User entry points

- The sidebar; ⌘\ hides and shows it.

## Drive

```sh
ax tree | grep -E 'group:|row:|stopped-toggle'            # L1, L2
ax press stopped-toggle && ax wait row:d0cc0de5000000000000000000000001   # L2
ax press sidebar-filter && ax pick Running && ax tree | grep -E 'row:|chip:'   # L3: only working sessions, under a Running chip
ax press chip:Running && ax gone chip:Running              # L3: the chip clears the filter
curl -s -X POST "$SEED_URL/api/sessions/$SESSION/steer" -H 'content-type: application/json' \
  -d '{"text":"from curl","turn":"t-x"}'                   # L4: the row jumps to the top as Working
```

## Proof

Screenshots before and after each filter, and after the curl steer (the row moved with no app input).

## Gotchas

- A covered window draws nothing (SKILL.md); run `ax covered` if the list looks stale.
- The steer body needs `turn`; check `ui/seed/api.ts` `SteerBody` if the seed answers 400.
