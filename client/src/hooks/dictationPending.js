import { useSyncExternalStore } from "react";

// Which dictation mics hold words that have not arrived yet: a clip being
// recorded or transcribed (server dictation, GATE_SERVER_DICTATION). The words
// land after the mic stops, so an action that reads the field (Send, Ask,
// Generate) must wait for them or it goes out without what was just said. Each
// DictationButton reports here; `useDictationPending()` is true while any does.
// Browser speech never reports: pressing another button already ends it and
// takes what it heard (useSpeechDictation).
const pendingIds = new Set();
const listeners = new Set();

export function setDictationPending(id, pending) {
  const had = pendingIds.has(id);
  if (pending === had) return;
  if (pending) pendingIds.add(id);
  else pendingIds.delete(id);
  listeners.forEach((fn) => fn());
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => pendingIds.size > 0;

export default function useDictationPending() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
