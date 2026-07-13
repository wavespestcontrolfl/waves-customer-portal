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
 * That shape is the intent signal: notes carrying BOTH section headers, one
 * paragraph each, are the drafted customer report, not free-form internal
 * notes, so the copy can take the report's summary text slot (typed Today's
 * Result body, recurring Visit Summary / Pest V2 hero). Anything else parses
 * to null and every consumer keeps its deterministic template — AI is never
 * in the critical path.
 *
 * Free text around the report is NOT reviewed customer copy: a prefix above
 * WHAT WE DID or any extra paragraph inside/after a section (a tech's
 * appended access-code / billing / office note) rejects the whole parse
 * (Codex P2 #2709) — the generated shape is exactly one paragraph per
 * section, so in-place sentence edits still pass.
 *
 * Banned-copy policy: the generate endpoint rejects unsafe output at
 * generation, but the tech can edit the text afterward, so the parse
 * re-screens with the shared BANNED_CUSTOMER_COPY list AND the summary
 * pipeline's validateCustomerCopy forbidden-language list (bare
 * "infestation", "toxic", "safe", … — Codex P2 #2709: this body lands on
 * the same public summary slot those validators protect). Violations return
 * `body: null` with the matched terms so callers can log and fall back —
 * a completion is never blocked on this copy.
 */

const { findBannedCustomerCopy } = require('./activity-indicators');
const { validateCustomerCopy } = require('./premium-experience');

// Longest legitimate generate-report output is ~140 words (≈1,000 chars);
// anything far beyond that is not the drafted report (a paste, a runaway
// edit) and must not become an unbounded customer summary.
const MAX_REPORT_CHARS = 1600;

const WHAT_WE_DID_HEADER = /^\s*WHAT WE DID:?\s*$/;
const WHAT_WE_FOUND_HEADER = /^\s*WHAT WE FOUND:?\s*$/;

// Blank-line-delimited paragraphs, each collapsed to single-spaced text.
// Soft line wraps inside a paragraph join; only a blank line splits.
function paragraphsFrom(lines) {
  const out = [];
  let current = [];
  for (const line of lines) {
    if (String(line).trim() === '') {
      if (current.length) {
        out.push(current.join(' ').replace(/\s+/g, ' ').trim());
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current.join(' ').replace(/\s+/g, ' ').trim());
  return out;
}

/**
 * Parse the two-section AI report shape out of completion notes.
 * Returns null when the notes are not the drafted report (missing header,
 * out-of-order headers, leading free text, section count ≠ 1 paragraph,
 * empty section, over-length). On a shape match returns
 * { whatWeDid, whatWeFound, body, violations }: `body` is the
 * customer-ready single paragraph, nulled when a banned-copy screen matched
 * (violations then lists the offending terms).
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
  if (paragraphsFrom(lines.slice(0, didIndex)).length) return null;

  // The generated shape is exactly ONE paragraph per section. A second
  // paragraph anywhere is unreviewed free text (most commonly an internal
  // note appended after WHAT WE FOUND) — reject the whole parse rather than
  // publish it.
  const didParagraphs = paragraphsFrom(lines.slice(didIndex + 1, foundIndex));
  const foundParagraphs = paragraphsFrom(lines.slice(foundIndex + 1));
  if (didParagraphs.length !== 1 || foundParagraphs.length !== 1) return null;
  const [whatWeDid] = didParagraphs;
  const [whatWeFound] = foundParagraphs;

  const body = `${whatWeDid} ${whatWeFound}`.trim();
  const violations = findBannedCustomerCopy(body);
  // Same forbidden-language standard as the summary pipeline's validators
  // (premium-experience / visit-summary-narrative) — this body renders in
  // the identical customer slot.
  if (!validateCustomerCopy(body)) violations.push('forbidden_language');
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
