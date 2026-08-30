/**
 * Estimate loss dispositions — the normalized "why did this estimate die"
 * vocabulary (estimator audit 2026-08-29, P0 "the loss taxonomy does not
 * explain dead estimates").
 *
 * Before this module the only loss signal was a free-text decline_reason on
 * the ~3% of losses staff marked by hand; the 6am expiry sweep flipped the
 * other ~97% to `expired` with no reason at all, so win/loss analytics could
 * count the loss but never explain it. Now every terminal-loss path stamps
 * `estimates.disposition`:
 *
 *   system-stamped (no human input):
 *     expired_unviewed      sweep expired it and the customer NEVER opened it
 *     expired_viewed        sweep expired it after at least one real open
 *     archived_unresolved   staff archived a live sent/viewed row w/o a reason
 *     converted_other_path  converted-customer sweep archived it — the
 *                           customer bought some other way (a win, not a loss)
 *   staff-stamped (decline modal / pipeline action):
 *     declined_price, declined_competitor (+competitor name/price),
 *     declined_timing, not_needed, diy, invalid_lead, no_response,
 *     declined_other (free text lands in disposition_note)
 *
 * `status` stays the lifecycle (sent/viewed/expired/declined/…); disposition
 * is the analytics classification layered on it. The legacy decline_reason
 * column keeps receiving the human label so existing badges don't change.
 */

const DISPOSITIONS = [
  // group: how analytics buckets it. 'lost' counts against win rate,
  // 'dead' is removed from the denominator (never real demand), 'won_elsewhere'
  // is excluded from loss rates (customer converted through another path).
  { code: 'expired_unviewed', label: 'Expired — never opened', group: 'lost', source: 'system' },
  { code: 'expired_viewed', label: 'Expired — opened, no decision', group: 'lost', source: 'system' },
  { code: 'archived_unresolved', label: 'Archived without a decision', group: 'lost', source: 'system' },
  { code: 'converted_other_path', label: 'Converted another way', group: 'won_elsewhere', source: 'system' },
  // Customer-authored: the public /:token/decline button (no reason is
  // collected there — the customer just says no).
  { code: 'declined_by_customer', label: 'Customer declined online', group: 'lost', source: 'customer' },
  { code: 'declined_price', label: 'Too expensive', group: 'lost', source: 'staff' },
  { code: 'declined_competitor', label: 'Went with competitor', group: 'lost', source: 'staff' },
  { code: 'declined_timing', label: 'Not ready / timing', group: 'lost', source: 'staff' },
  { code: 'not_needed', label: 'Service not needed', group: 'lost', source: 'staff' },
  { code: 'diy', label: 'Doing it themselves', group: 'lost', source: 'staff' },
  { code: 'no_response', label: 'No response', group: 'lost', source: 'staff' },
  { code: 'invalid_lead', label: 'Invalid / out of area / duplicate', group: 'dead', source: 'staff' },
  { code: 'declined_other', label: 'Other', group: 'lost', source: 'staff' },
];

const DISPOSITION_BY_CODE = new Map(DISPOSITIONS.map((d) => [d.code, d]));
const STAFF_DISPOSITION_CODES = DISPOSITIONS.filter((d) => d.source === 'staff').map((d) => d.code);

// Legacy decline_reason labels (the five radio options every decline modal
// has written since the pipeline shipped) → normalized code. Matching is
// case/whitespace-insensitive so hand-typed variants from the pipeline's
// free-text decline still land somewhere useful.
const LEGACY_LABEL_TO_CODE = new Map([
  ['too expensive', 'declined_price'],
  ['price', 'declined_price'],
  ['went with competitor', 'declined_competitor'],
  ['competitor', 'declined_competitor'],
  // The pipeline's free-text decline suggests "chose another provider" —
  // recognize that wording (and close variants) so its competitor losses
  // don't fall into declined_other (codex pre-push P1).
  ['another provider', 'declined_competitor'],
  ['other provider', 'declined_competitor'],
  ['another company', 'declined_competitor'],
  ['other company', 'declined_competitor'],
  ['someone else', 'declined_competitor'],
  ['not ready', 'declined_timing'],
  ['timing', 'declined_timing'],
  ['service not needed', 'not_needed'],
  ['not needed', 'not_needed'],
  ['no response', 'no_response'],
  ['diy', 'diy'],
  ['invalid', 'invalid_lead'],
  ['out of area', 'invalid_lead'],
  ['duplicate', 'invalid_lead'],
]);

function normalizeLabel(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isDispositionCode(code) {
  return typeof code === 'string' && DISPOSITION_BY_CODE.has(code);
}

function isStaffDispositionCode(code) {
  return isDispositionCode(code) && DISPOSITION_BY_CODE.get(code).source === 'staff';
}

function dispositionGroup(code) {
  return DISPOSITION_BY_CODE.get(code)?.group || null;
}

function dispositionLabel(code) {
  return DISPOSITION_BY_CODE.get(code)?.label || null;
}

/**
 * Map a legacy free-text decline reason to a code. Exact label matches win;
 * otherwise a contained keyword; otherwise declined_other (the text itself
 * is preserved by the caller in disposition_note).
 */
function dispositionFromDeclineReason(text) {
  const norm = normalizeLabel(text);
  if (!norm) return null;
  if (LEGACY_LABEL_TO_CODE.has(norm)) return LEGACY_LABEL_TO_CODE.get(norm);
  for (const [needle, code] of LEGACY_LABEL_TO_CODE) {
    if (norm.includes(needle)) return code;
  }
  return 'declined_other';
}

/**
 * Which disposition an EXPIRING row gets, from the pre-flip row. "Viewed"
 * means at least one real customer open: the public estimate page counts
 * views into view_count / last_viewed_at (bot UAs and admin IPs filtered
 * upstream) and flips sent→viewed. Any of those signals = opened.
 */
function expiredDispositionFor(row) {
  const views = Number(row?.view_count) || 0;
  const opened = views > 0
    || !!row?.last_viewed_at
    || !!row?.viewed_at
    || row?.status === 'viewed';
  return opened ? 'expired_viewed' : 'expired_unviewed';
}

// SQL twin of expiredDispositionFor for set-based sweeps (evaluated against
// the pre-update row, which is Postgres' semantics for SET expressions).
// COALESCE keeps any disposition a staff member already stamped.
const EXPIRED_DISPOSITION_SQL = `COALESCE(disposition, CASE
  WHEN COALESCE(view_count, 0) > 0 OR last_viewed_at IS NOT NULL OR viewed_at IS NOT NULL OR status = 'viewed'
  THEN 'expired_viewed' ELSE 'expired_unviewed' END)`;

function positiveMoneyOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  const rounded = Math.round(n * 100) / 100;
  // competitor_price is decimal(10,2) — anything beyond its range would
  // turn a validation problem into a Postgres numeric-overflow 500
  // (codex pre-push P1). No competitor price is remotely near this.
  if (rounded > 99999999.99) return null;
  return rounded;
}

/**
 * Validate + normalize the staff-decline payload from the admin PATCH.
 * Accepts either a normalized `disposition` code or a legacy `declineReason`
 * label (older clients / the pipeline's free-text action). Returns the
 * column updates to merge, or { error } for a 400.
 */
function staffDispositionUpdates(body = {}) {
  let code = body.disposition;
  if (code !== undefined && code !== null && code !== '') {
    if (!isStaffDispositionCode(code)) {
      return { error: `Invalid disposition '${String(code)}'. Must be one of: ${STAFF_DISPOSITION_CODES.join(', ')}.` };
    }
  } else {
    code = dispositionFromDeclineReason(body.declineReason);
  }
  if (!code) return { error: 'A decline reason is required.' };

  const note = typeof body.dispositionNote === 'string' ? body.dispositionNote.trim().slice(0, 2000) : '';
  const legacyText = typeof body.declineReason === 'string' ? body.declineReason.trim() : '';
  // "Other" without any explanation is exactly the unexplained loss this
  // taxonomy exists to end (GH codex P2 x2). An EXPLICIT normalized
  // submission always requires the note — the shared payload builder sends
  // declineReason:"Other" as a fixed label, never an explanation. Only the
  // legacy free-text path (no code supplied) can satisfy it with the text
  // that mapped here.
  const explicitCode = body.disposition !== undefined && body.disposition !== null && body.disposition !== '';
  if (code === 'declined_other' && !note && (explicitCode || !legacyText)) {
    return { error: "A short note is required when the reason is 'Other'." };
  }
  const updates = {
    disposition: code,
    disposition_source: 'staff',
    disposition_at: new Date(),
    // Free text lands in the note when the label wasn't one of the fixed
    // options — otherwise the note is whatever staff typed (may be empty).
    disposition_note: note || (code === 'declined_other' && !explicitCode && legacyText ? legacyText : null),
    competitor_name: null,
    competitor_price: null,
  };
  if (code === 'declined_competitor') {
    const name = typeof body.competitorName === 'string' ? body.competitorName.trim().slice(0, 120) : '';
    updates.competitor_name = name || null;
    const priceSupplied = body.competitorPrice !== undefined && body.competitorPrice !== null
      && String(body.competitorPrice).trim() !== '';
    const price = positiveMoneyOrNull(body.competitorPrice);
    // A supplied-but-unusable price must fail loudly, not vanish behind a
    // successful save (codex pre-push P1).
    if (priceSupplied && price === null) {
      return { error: 'Competitor price must be a dollar amount between 0 and 99,999,999.99.' };
    }
    updates.competitor_price = price;
  }
  // Keep the legacy human label populated for every existing badge/list
  // reader; when only a code came in, derive the label from it.
  updates.decline_reason = (legacyText || dispositionLabel(code) || code).slice(0, 100);
  return { updates };
}

module.exports = {
  DISPOSITIONS,
  STAFF_DISPOSITION_CODES,
  EXPIRED_DISPOSITION_SQL,
  isDispositionCode,
  isStaffDispositionCode,
  dispositionGroup,
  dispositionLabel,
  dispositionFromDeclineReason,
  expiredDispositionFor,
  staffDispositionUpdates,
};
