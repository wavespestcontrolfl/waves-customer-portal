/**
 * Technician AI-report copy — the bridge between the completion form's
 * "Generate AI report" output and the customer-facing report summary.
 *
 * The generate-report endpoint (admin-schedule.js) drafts customer-facing
 * prose in a fixed two-section shape that the technician reviews (and may
 * edit) in the notes box before completing:
 *
 *   WHAT WE DID
 *
 *   [2-3 sentences]
 *
 *   WHAT WE FOUND
 *
 *   [2-3 sentences]
 *
 * That shape is the intent signal: notes carrying BOTH section headers are
 * the drafted customer report, not free-form internal notes, so the copy can
 * take the report's summary text slot (typed Today's Result body, recurring
 * Visit Summary / Pest V2 hero). Notes without the shape parse to null and
 * every consumer keeps its deterministic template — AI is never in the
 * critical path.
 *
 * Banned-copy policy: the generate endpoint rejects unsafe output at
 * generation, but the tech can edit the text afterward, so the parse
 * re-screens with the shared BANNED_CUSTOMER_COPY list. Violations return
 * `body: null` with the matched terms so callers can log and fall back —
 * a completion is never blocked on this copy.
 */

const { findBannedCustomerCopy } = require('./activity-indicators');

// Longest legitimate generate-report output is ~140 words (≈1,000 chars);
// anything far beyond that is not the drafted report (a paste, a runaway
// edit) and must not become an unbounded customer summary.
const MAX_REPORT_CHARS = 1600;

const WHAT_WE_DID_HEADER = /^\s*WHAT WE DID:?\s*$/;
const WHAT_WE_FOUND_HEADER = /^\s*WHAT WE FOUND:?\s*$/;

function collapseSection(lines) {
  return lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the two-section AI report shape out of completion notes.
 * Returns null when the notes are not the drafted report (missing header,
 * out-of-order headers, leading free text, empty section, over-length).
 * On a shape match returns { whatWeDid, whatWeFound, body, violations }:
 * `body` is the customer-ready single paragraph, nulled when the banned-copy
 * screen matched (violations then lists the offending terms).
 */
function technicianReportCustomerCopy(notes) {
  const text = String(notes || '');
  if (!text.trim() || text.length > MAX_REPORT_CHARS) return null;

  const lines = text.split(/\r?\n/);
  const didIndex = lines.findIndex((line) => WHAT_WE_DID_HEADER.test(line));
  const foundIndex = lines.findIndex((line) => WHAT_WE_FOUND_HEADER.test(line));
  if (didIndex === -1 || foundIndex === -1 || foundIndex <= didIndex) return null;

  // Any free text ABOVE the report is not reviewed customer copy (the draft
  // replaces the notes wholesale, so a clean draft has nothing there) — a
  // prefixed internal note must not drag the whole blob onto the report.
  const prefix = collapseSection(lines.slice(0, didIndex));
  if (prefix) return null;

  const whatWeDid = collapseSection(lines.slice(didIndex + 1, foundIndex));
  const whatWeFound = collapseSection(lines.slice(foundIndex + 1));
  if (!whatWeDid || !whatWeFound) return null;

  const body = `${whatWeDid} ${whatWeFound}`.trim();
  const violations = findBannedCustomerCopy(body);
  return {
    whatWeDid,
    whatWeFound,
    body: violations.length ? null : body,
    violations,
  };
}

module.exports = {
  technicianReportCustomerCopy,
  MAX_REPORT_CHARS,
};
