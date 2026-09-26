export type LocalDraft = { text: string; revision: number; dirty: boolean };

// Only edits that have not been acknowledged by the account server may
// override a fresh server draft. A previously saved cache has no authority.
export function chooseDraft(serverText: string, local?: LocalDraft): LocalDraft {
  return local?.dirty ? local : { text: serverText, revision: local?.revision || 0, dirty: false };
}

export function editDraft(previous: LocalDraft | undefined, text: string): LocalDraft {
  return { text, revision: (previous?.revision || 0) + 1, dirty: true };
}

// A late acknowledgement for A cannot clear a later edit B, even if the user
// typed the same text again after A was sent.
export function acknowledgeDraft(current: LocalDraft | undefined, saved: LocalDraft): LocalDraft | undefined {
  return current?.revision === saved.revision ? { ...current, dirty: false } : current;
}

export function draftReadCanRestore(start: { epoch: number; dirty: boolean }, current: { epoch: number; dirty: boolean }): boolean {
  return !start.dirty && !current.dirty && start.epoch === current.epoch;
}
