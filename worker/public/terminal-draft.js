export function createComposerDrafts(entryForSession) {
  const sessions = new Map();

  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        draft: entryForSession(sessionId).draft,
        nextSequence: 0,
        recovered: new Map(),
      };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const set = (sessionId, draft) => {
    const entry = entryForSession(sessionId);
    const state = stateFor(sessionId);
    if (entry.draft === draft) return entry.draft;
    entry.draft = draft;
    state.draft = draft;
    state.recovered.clear();
    return entry.draft;
  };

  return {
    set,

    begin(sessionId, draft) {
      set(sessionId, draft);
      const state = stateFor(sessionId);
      const submission = {
        sessionId,
        draft,
        sequence: state.nextSequence,
      };
      state.nextSequence += 1;
      state.draft = "";
      state.recovered.clear();
      entryForSession(sessionId).draft = "";
      return submission;
    },

    settle(submission, status) {
      if (status === "accepted") return false;
      const state = stateFor(submission.sessionId);
      const entry = entryForSession(submission.sessionId);
      const previous = entry.draft;
      state.recovered.set(submission.sequence, submission.draft);
      entry.draft = [
        ...[...state.recovered.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, draft]) => draft),
        state.draft,
      ]
        .filter(Boolean)
        .join("\n\n");
      return entry.draft !== previous;
    },
  };
}
