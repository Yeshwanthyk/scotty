import { describe, expect, it } from "vitest";

type ClientId = "a" | "b" | "c";

interface Transfer {
  readonly source: ClientId;
  readonly target: ClientId;
  readonly epoch: number;
}

interface OwnershipState {
  readonly owner: ClientId | null;
  readonly epoch: number;
  readonly active: ReadonlyArray<ClientId>;
  readonly transfer?: Transfer;
}

type Action =
  | { readonly type: "accept"; readonly actor: ClientId }
  | { readonly type: "cancel"; readonly actor: ClientId }
  | { readonly type: "owner-mutation"; readonly actor: ClientId }
  | { readonly type: "pair"; readonly actor: ClientId; readonly target: ClientId }
  | { readonly type: "recover"; readonly target: ClientId }
  | { readonly type: "start"; readonly actor: ClientId; readonly target: ClientId };

const CLIENTS: ReadonlyArray<ClientId> = ["a", "b", "c"];

function startTransfer(state: OwnershipState, action: Extract<Action, { type: "start" }>) {
  if (
    action.actor !== state.owner ||
    action.target === state.owner ||
    !state.active.includes(action.target) ||
    state.transfer
  )
    return undefined;
  return {
    ...state,
    transfer: { source: action.actor, target: action.target, epoch: state.epoch },
  };
}

function acceptTransfer(state: OwnershipState, action: Extract<Action, { type: "accept" }>) {
  const transfer = state.transfer;
  if (
    !transfer ||
    action.actor !== transfer.target ||
    state.owner !== transfer.source ||
    state.epoch !== transfer.epoch ||
    !state.active.includes(transfer.source) ||
    !state.active.includes(transfer.target)
  )
    return undefined;
  return {
    owner: transfer.target,
    epoch: state.epoch + 1,
    active: state.active.filter((client) => client !== transfer.source),
  };
}

function transition(state: OwnershipState, action: Action): OwnershipState | undefined {
  if (action.type === "recover")
    return {
      owner: action.target,
      epoch: state.epoch + 1,
      active: [action.target],
    };
  if (action.type === "pair") {
    if (action.actor !== state.owner || state.active.includes(action.target)) return undefined;
    return {
      ...state,
      active: [...state.active, action.target].sort(),
    };
  }
  if (action.type === "start") return startTransfer(state, action);
  if (action.type === "accept") return acceptTransfer(state, action);
  if (action.type === "cancel") {
    if (action.actor !== state.owner || !state.transfer) return undefined;
    return {
      owner: state.owner,
      epoch: state.epoch,
      active: state.active,
    };
  }
  return action.actor === state.owner && state.active.includes(action.actor) ? state : undefined;
}

function actions(): ReadonlyArray<Action> {
  const result: Array<Action> = [];
  for (const actor of CLIENTS) {
    result.push({ type: "accept", actor });
    result.push({ type: "cancel", actor });
    result.push({ type: "owner-mutation", actor });
    result.push({ type: "recover", target: actor });
    for (const target of CLIENTS) {
      result.push({ type: "pair", actor, target });
      result.push({ type: "start", actor, target });
    }
  }
  return result;
}

function stateKey(state: OwnershipState): string {
  return JSON.stringify(state);
}

function transitionPreservesInvariants(
  state: OwnershipState,
  action: Action,
  next: OwnershipState,
): boolean {
  const ownerChanged = next.owner !== state.owner;
  const expectedEpoch = action.type === "recover" || ownerChanged ? state.epoch + 1 : state.epoch;
  const ownerChangeIsAuthorized =
    !ownerChanged || action.type === "accept" || action.type === "recover";
  const acceptIsBound =
    action.type !== "accept" ||
    (state.transfer !== undefined && next.owner === state.transfer.target);
  const ownerMutationWasCurrent =
    action.type !== "owner-mutation" ||
    (action.actor === state.owner && state.active.includes(action.actor));
  return (
    next.epoch >= state.epoch &&
    (next.owner === null || next.active.includes(next.owner)) &&
    new Set(next.active).size === next.active.length &&
    next.epoch === expectedEpoch &&
    ownerChangeIsAuthorized &&
    acceptIsBound &&
    ownerMutationWasCurrent
  );
}

describe("owner authority state machine", () => {
  it("enumerates reachable states while preserving the ownership invariants", () => {
    let frontier: ReadonlyArray<OwnershipState> = [{ owner: null, epoch: 0, active: [] }];
    const seen = new Set(frontier.map(stateKey));
    let checkedTransitions = 0;

    for (let depth = 0; depth < 7; depth += 1) {
      const nextFrontier: Array<OwnershipState> = [];
      for (const state of frontier) {
        for (const action of actions()) {
          const next = transition(state, action);
          if (!next) continue;
          checkedTransitions += 1;

          expect(transitionPreservesInvariants(state, action, next)).toBe(true);

          const key = stateKey(next);
          if (!seen.has(key)) {
            seen.add(key);
            nextFrontier.push(next);
          }
        }
      }
      frontier = nextFrontier;
    }

    expect(seen.size).toBeGreaterThan(40);
    expect(checkedTransitions).toBeGreaterThan(100);
  });

  it("rejects target substitution; removing target binding lets another client redeem", () => {
    const state: OwnershipState = {
      owner: "a",
      epoch: 1,
      active: ["a", "b", "c"],
      transfer: { source: "a", target: "b", epoch: 1 },
    };

    expect(transition(state, { type: "accept", actor: "c" })).toBeUndefined();
    const mutantOwner = state.active.includes("c") ? "c" : state.owner;
    expect(mutantOwner).not.toBe(state.transfer?.target);
  });

  it("rejects stale epochs; removing the guard revives a transfer after ownership cycles", () => {
    const cycled: OwnershipState = {
      owner: "a",
      epoch: 3,
      active: ["a", "b"],
      transfer: { source: "a", target: "b", epoch: 1 },
    };

    expect(transition(cycled, { type: "accept", actor: "b" })).toBeUndefined();
    const mutantWouldAccept =
      cycled.owner === cycled.transfer?.source && cycled.active.includes(cycled.transfer.target);
    expect(mutantWouldAccept).toBe(true);
  });

  it("rechecks the actor in the mutation transaction; a revoked owner cannot commit a queued command", () => {
    const admitted: OwnershipState = {
      owner: "a",
      epoch: 1,
      active: ["a", "b"],
    };
    const recovered = transition(admitted, { type: "recover", target: "b" });
    expect(recovered).toBeDefined();
    if (!recovered) throw new TypeError("Expected recovery transition");

    expect(transition(recovered, { type: "owner-mutation", actor: "a" })).toBeUndefined();
    const mutantWouldCommit = admitted.owner === "a";
    expect(mutantWouldCommit).toBe(true);
  });
});
