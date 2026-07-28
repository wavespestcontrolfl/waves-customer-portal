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
// Only a STANDALONE "No SMS sent." sentence is an audit marker. Genuine
// prose that merely contains the phrase ("Customer has no mobile, so no
// SMS sent; call on arrival.") must pass through untouched.
const NO_SMS_STANDALONE_RE = /^no sms sent[.!]?$/i;
// A standalone marker only consumes its predecessor when the predecessor
// itself reads like a KNOWN scheduler-entry shape: the ops "Clarified …
// service line: …" narration, or machine snake_case tokens. Ordinary staff
// prose — even when it starts with a verb like "Updated" ("Updated gate
// code to 4412. No SMS sent.") — must survive; when in doubt, keep the note.
const AUDIT_PREDECESSOR_RE = /^clarified\b.*\bservice line\b/i;
const SNAKE_TOKEN_RE = /\b[a-z0-9]+_[a-z0-9_]+\b/;

function stripSchedulerAuditText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  // Sentence-ish segments: split on newlines and on periods followed by
  // whitespace. Keeps decimals ("+13.45") and times inside one segment.
  const segments = value.split(/(?<=\.)\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const hasAuditContent = segments.some(
    (s) => AUDIT_TAG_RE.test(s) || NO_SMS_STANDALONE_RE.test(s),
  );
  if (!hasAuditContent) return value;
  const kept = [];
  // An audit entry reads "<what moved / what changed>. No SMS sent." — the
  // marker sentence retroactively consumes its predecessor, but only when
  // that predecessor also reads like audit narration (tagged predecessors
  // were already handled on their own).
  let prevWasAudit = false;
  for (const segment of segments) {
    if (NO_SMS_STANDALONE_RE.test(segment)) {
      if (!prevWasAudit && kept.length) {
        const prev = kept[kept.length - 1];
        if (AUDIT_PREDECESSOR_RE.test(prev) || SNAKE_TOKEN_RE.test(prev)) kept.pop();
      }
      prevWasAudit = true;
      continue;
    }
    const tag = segment.match(AUDIT_TAG_RE);
    if (tag) {
      // A real note can share the segment with an appended audit entry
      // ("Gate code 4412; recurring_align_2026_06: moved …") — keep the
      // text before the tag, drop the tag onward.
      const prefix = segment.slice(0, tag.index).replace(/[\s;,:—-]+$/, '').trim();
      if (prefix) kept.push(prefix);
      prevWasAudit = true;
      continue;
    }
    kept.push(segment);
    prevWasAudit = false;
  }
  const out = kept.join(' ').trim();
  return out || null;
}

module.exports = { previewText, stripSchedulerAuditText, PREVIEW_MAX };
