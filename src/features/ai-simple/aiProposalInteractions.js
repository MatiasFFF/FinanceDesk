export function hasProposalReviewChanges({ accountName = "", accountNumber = "", notes = {}, editorDirty = false }, completed = {}) {
  return editorDirty || (!completed.account && (!!accountName.trim() || !!accountNumber.trim()))
    || Object.entries(notes).some(([id, note]) => id !== completed.proposalId && !!note.trim());
}

// A successful action only consumes its own fields. Other notes or the account
// form must keep this dialog mounted until the user saves or discards them.
export function canCloseCompletedReview(proposals, draft, completed) {
  return !proposals.some((proposal) => proposal.status === "pending") && !hasProposalReviewChanges(draft, completed);
}

export function moveRevisedProposalNote(notes, previousId, nextId) {
  if (previousId === nextId || !Object.hasOwn(notes, previousId)) return notes;
  const { [previousId]: note, ...next } = notes;
  const existing = next[nextId];
  if (note) next[nextId] = existing && existing !== note ? `${existing}\n${note}` : note;
  return next;
}
