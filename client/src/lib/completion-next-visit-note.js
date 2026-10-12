// client/src/lib/completion-next-visit-note.js
//
// The tech's note about the NEXT scheduled visit ("Needs adjustment?" under the next-visit card), as the
// completion body carries it. The server stores it on that visit's staff note (services/next-visit-note.js).
// One helper for the full form (pages/admin/SchedulePage.jsx) and the Fast Complete Wrap-up
// (lib/fast-complete-wrap-up.js), so the two post the same keys.

// The box's cap: the server enforces the same 300 characters.
export const NEXT_VISIT_NOTE_MAX = 300;

// Posted only once a note is typed: the trimmed note, and the id of the visit the card showed.
export function nextVisitNoteFields({ nextVisitNote, nextVisit }) {
  const note = String(nextVisitNote || '').trim();
  if (!note) return {};
  return { nextVisitAdjustmentNote: note, ...(nextVisit?.id ? { nextVisitId: nextVisit.id } : {}) };
}
