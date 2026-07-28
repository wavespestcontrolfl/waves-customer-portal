/**
 * Helpers for surfacing technician/visit notes on the schedule + dispatch
 * day views. Two problems these solve (2026-07 service-dashboard alignment):
 *
 * - Raw `.slice(0, 200)` previews cut mid-word ("K-Flow 0-0-25 for pota")
 *   with no ellipsis → previewText truncates at a word boundary.
 * - Ops sessions write scheduling-audit trails into scheduled_services.notes
 *   ("recurring_align_2026_06: moved from … No SMS sent.") which then render
 *   inside the tech-facing Property Alerts block → stripSchedulerAuditText
 *   removes those segments and keeps genuine property notes.
 */

const PREVIEW_MAX = 200;

// Word-boundary preview with an ellipsis. Returns null for empty input so
// callers can `|| null` less.
function previewText(text, max = PREVIEW_MAX) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // No space in range (one giant token) — fall back to the hard cut.
  const head = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s,;:.—-]+$/, '')}…`;
}

// Scheduler-audit segments look like machine tags and SMS-suppression
// markers, e.g.:
//   "recurring_align_2026_06: moved from 2026-09-02 10:00:00 to … No SMS sent."
//   "route_density_2026_06: moved … for route density (lakewood_ranch; score +13.45). No SMS sent."
// Match conservatively: only sentences that carry a snake_case_YYYY_MM tag or
// an explicit "No SMS sent" marker are dropped; everything else passes through
// untouched. Returns the cleaned string, or null when nothing legible remains.
const AUDIT_TAG_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_\d{4}_\d{2}\s*:/;
const NO_SMS_RE = /\bno sms sent\b/i;

function stripSchedulerAuditText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (!AUDIT_TAG_RE.test(value) && !NO_SMS_RE.test(value)) return value;
  // Sentence-ish segments: split on newlines and on periods followed by
  // whitespace. Keeps decimals ("+13.45") and times inside one segment.
  const segments = value.split(/(?<=\.)\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const dropped = segments.map((s) => AUDIT_TAG_RE.test(s) || NO_SMS_RE.test(s));
  // An audit entry reads "<what moved / what changed>. No SMS sent." — the
  // marker sentence retroactively marks its untagged predecessor as audit
  // text too (tagged predecessors are already dropped on their own).
  for (let i = 0; i < segments.length; i += 1) {
    if (NO_SMS_RE.test(segments[i]) && i > 0 && !dropped[i - 1]) dropped[i - 1] = true;
  }
  const kept = segments.filter((_, i) => !dropped[i]).join(' ').trim();
  return kept || null;
}

module.exports = { previewText, stripSchedulerAuditText, PREVIEW_MAX };
