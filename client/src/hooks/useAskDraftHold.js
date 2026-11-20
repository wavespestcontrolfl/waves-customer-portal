import { useEffect } from 'react';
import { registerReloadHold } from '../lib/reloadHolds';

// Ask Waves composers that hold an unsent question or photo, a picked photo
// still converting included. Each keeps its draft only in React state, so a
// reload of an out-of-date tab would drop it (lib/reloadHolds.js). One entry
// per composer: the hold ends when the last draft is sent, cleared or
// unmounted.
const drafts = new Set();
registerReloadHold('ask-draft', () => drafts.size > 0);

export default function useAskDraftHold(prompt, photos = 0, converting = false) {
  const held = String(prompt ?? '').trim() !== '' || photos > 0 || converting;
  useEffect(() => {
    if (!held) return undefined;
    const draft = {};
    drafts.add(draft);
    return () => {
      drafts.delete(draft);
    };
  }, [held]);
}
