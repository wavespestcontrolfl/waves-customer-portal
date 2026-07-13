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
 * That shape is the intent signal: notes carrying BOTH section headers, each
 * followed by exactly ONE line of prose, are the drafted customer report,
 * not free-form internal notes, so the copy can take the report's summary
 * text slot (typed Today's Result body, recurring Visit Summary / Pest V2
 * hero). Anything else parses to null and every consumer keeps its
 * deterministic template — AI is never in the critical path.
 *
 * Free text around the report is NOT reviewed customer copy: a prefix above
 * WHAT WE DID, or ANY extra line inside/after a section, rejects the whole
 * parse (Codex P1/P2 #2709). The endpoint emits each section as a single
 * line, and a textarea only inserts a real newline when the tech presses
 * Enter — so an appended access-code / billing / office note (with or
 * without a blank line) is always a second line and always rejects, while
 * in-place sentence edits still pass.
 *
 * Banned-copy policy: the generate endpoint rejects unsafe output at
 * generation, but the tech can edit the text afterward, so the parse
 * re-screens with every guard the summary slot already enforces elsewhere:
 * the shared BANNED_CUSTOMER_COPY list, premium-experience's
 * validateCustomerCopy, and the visit-summary narrative's EXTRA_FORBIDDEN
 * vocabulary (bare/plural "infestation(s)", "safe", "solved", … — Codex P1
 * #2709). Violations return `body: null` with the matched terms so callers
 * can log and fall back — a completion is never blocked on this copy.
 */

const crypto = require('crypto');
const { findBannedCustomerCopy } = require('./activity-indicators');
const { validateCustomerCopy } = require('./premium-experience');
const { EXTRA_FORBIDDEN } = require('./visit-summary-narrative');

// Longest legitimate generate-report output is ~140 words (≈1,000 chars);
// anything far beyond that is not the drafted report (a paste, a runaway
// edit) and must not become an unbounded customer summary.
const MAX_REPORT_CHARS = 1600;

const WHAT_WE_DID_HEADER = /^\s*WHAT WE DID:?\s*$/;
const WHAT_WE_FOUND_HEADER = /^\s*WHAT WE FOUND:?\s*$/;

function contentLines(lines) {
  return lines
    .map((line) => String(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Parse the two-section AI report shape out of completion notes.
 * Returns null when the notes are not the drafted report (missing header,
 * out-of-order headers, leading free text, any section ≠ exactly one line,
 * over-length). On a shape match returns
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
  if (contentLines(lines.slice(0, didIndex)).length) return null;

  // The generated shape is exactly ONE prose line per section. Any second
  // line — blank-separated paragraph or an internal note typed directly on
  // the next line — is unreviewed free text and rejects the whole parse
  // rather than being joined into the customer copy.
  const didLines = contentLines(lines.slice(didIndex + 1, foundIndex));
  const foundLines = contentLines(lines.slice(foundIndex + 1));
  if (didLines.length !== 1 || foundLines.length !== 1) return null;
  const [whatWeDid] = didLines;
  const [whatWeFound] = foundLines;

  const body = `${whatWeDid} ${whatWeFound}`.trim();
  // Union of every screen the summary slot enforces elsewhere: the shared
  // snapshot ban list, premium-experience's forbidden patterns, and the
  // narrative's extra vocabulary (plural "infestations", "safe", "solved").
  const violations = [
    ...findBannedCustomerCopy(body),
    ...EXTRA_FORBIDDEN.map((rx) => body.match(rx)?.[0] || null).filter(Boolean),
  ];
  if (!violations.length && !validateCustomerCopy(body)) violations.push('forbidden_language');
  return {
    whatWeDid,
    whatWeFound,
    body: violations.length ? null : body,
    violations,
  };
}

/**
 * PDF cache-key component. Stored report PDFs are keyed on the Pest
 * Pressure visibility signature only, so a summary now driven by the
 * technician report needs its own key component — otherwise a recurring
 * report that already has a cached PDF keeps serving the old generic
 * summary after this feature lands (Codex P2 #2709).
 *
 * Returns '' when the summary is recap/template-driven (keys unchanged, so
 * every existing cached PDF stays a valid hit) and a content-hashed suffix
 * when the technician report drives the rendered summary. Mirrors
 * report-data's summary-source decision: non-typed reports use the parsed
 * copy directly; typed reports only when the frozen snapshot's Today's
 * Result body came from the technician report.
 */
function summaryCopySignature(service = {}) {
  let snapshot = null;
  try {
    const data = typeof service.service_data === 'string'
      ? JSON.parse(service.service_data)
      : service.service_data;
    snapshot = data && typeof data === 'object' && !Array.isArray(data)
      && data.typedReportSnapshot && typeof data.typedReportSnapshot === 'object'
      && data.typedReportSnapshot.type
      ? data.typedReportSnapshot
      : null;
  } catch {
    snapshot = null;
  }
  const parsed = technicianReportCustomerCopy(service.technician_notes);
  const drivesSummary = !!parsed?.body
    && (!snapshot || snapshot.todaysResult?.bodySource === 'technician_report');
  if (!drivesSummary) return '';
  return `-tr${crypto.createHash('sha256').update(parsed.body).digest('hex').slice(0, 8)}`;
}

module.exports = {
  technicianReportCustomerCopy,
  summaryCopySignature,
  MAX_REPORT_CHARS,
};
