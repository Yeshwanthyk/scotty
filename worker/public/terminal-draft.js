export function createComposerDrafts(entryForSession) {
  const revisions = new Map();

  const set = (sessionId, draft) => {
    const entry = entryForSession(sessionId);
    if (entry.draft === draft) return entry.draft;
    entry.draft = draft;
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
    return entry.draft;
  };

  return {
    set,

    begin(sessionId, draft) {
      set(sessionId, draft);
      const submission = {
        sessionId,
        draft,
        revision: revisions.get(sessionId) ?? 0,
      };
      entryForSession(sessionId).draft = "";
      return submission;
    },

    settle(submission, status) {
      if (status === "accepted" || revisions.get(submission.sessionId) !== submission.revision)
        return false;
      const entry = entryForSession(submission.sessionId);
      entry.draft = submission.draft;
      revisions.set(submission.sessionId, submission.revision + 1);
      return true;
    },
  };
}
