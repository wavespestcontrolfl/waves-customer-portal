// client/src/lib/lawn-sod-sheet.js
//
// The lawn Fast Complete sheet's view of the new-sod holds (GATE_LAWN_NEW_SOD_NOTE). The server
// decides every rule and every word (server/services/lawn-sod-sheet.js on top of lawn-sod-holds.js):
// the context's `newSod` carries the banner lines and `lines`, a map by lower-case product id of
// what the holds say about that product: `{ held: true, reason }` (kept off the sheet; the
// technician can still add it by hand) or `{ held: false, note }` (a part-of-lawn skip note).
// These helpers only read that object. Nothing here restates a hold rule.

const lowerId = (id) => String(id ?? '').toLowerCase();

/**
 * The context's `newSod`, or null (an older server, the gate off, or no hold today). A failed sod
 * read arrives as `{ unavailable: true, message }`.
 */
export function newSodOf(data) {
  const sod = data?.newSod;
  if (!sod || typeof sod !== 'object' || sod.v !== 1) return null;
  if (sod.unavailable === true) return typeof sod.message === 'string' && sod.message ? { v: 1, unavailable: true, message: sod.message } : null;
  if (typeof sod.headline !== 'string' || !sod.headline) return null;
  const lines = sod.lines && typeof sod.lines === 'object' && !Array.isArray(sod.lines) ? sod.lines : {};
  return { ...sod, lines };
}

/** What the holds say about one product: `{ held, reason }`, `{ held: false, note }` or null. */
export function sodLineOf(newSod, productId) {
  if (!newSod || newSod.unavailable) return null;
  return newSod.lines[lowerId(productId)] || null;
}

/** True when the holds keep this product off the sheet. */
export const sodHeld = (newSod, productId) => sodLineOf(newSod, productId)?.held === true;

/**
 * The note under a product that IS on the sheet: a held product the technician added by hand is
 * warned, never blocked; a part-of-lawn skip note rides the line.
 */
export function sodRowNote(newSod, productId) {
  const line = sodLineOf(newSod, productId);
  if (!line) return null;
  return line.held ? `${line.reason} You added it by hand.` : line.note;
}

/** The planned items split into the ones the sheet starts with and the ones the holds keep off it. */
export function splitHeldPlanned(planned, newSod) {
  const start = [];
  const held = [];
  for (const item of planned || []) (sodHeld(newSod, item.productId) ? held : start).push(item);
  return { start, held };
}
