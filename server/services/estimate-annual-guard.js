'use strict';

// Chokepoint rule (delivery-guards slice, re-cut of #4569): no estimate
// sender rechecks annual-offer eligibility itself; every sender passes
// estimateId(s) through to the send library instead, and the two send
// chokepoints (send-customer-message.js, email-template-library.js) are the
// only places that call this guard. #4569 added the same recheck at each
// sender one at a time and never converged (16 open findings across five
// rounds) because the guard lived in the callers. One guard, two callers.
//
// Codex round 1 on #4608 (P1): keying the guard ONLY on a caller-supplied
// estimateId made it opt-in — three senders (a composer manual SMS, the
// service-details email/SMS on estimate-public.js) never passed one and
// sailed straight past it. The structural fix: derive the estimate
// identity from the message's own CONTENT at the handoff (the public
// estimate link and the short link that usually carries it instead), and
// treat an explicit id as an addition to that, never the only source.

const { annualPlanPublicReplayBlocked } = require('./estimate-offer-version');

// Every column annualPlanOfferFingerprint/annualPlanPublicReplayBlocked read
// (estimate-offer-version.js), plus the id/status/expires_at/estimate_data
// the verdict and callers need. Keep this list in sync with that module's
// fingerprint field list — a column missing here reads as `undefined` on the
// row, which silently narrows the fingerprint rather than erroring.
const FINGERPRINT_COLUMNS = [
  'customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone',
  'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total',
  'show_one_time_option', 'bill_by_invoice', 'waveguard_tier', 'service_interest', 'category', 'source',
];

const ROW_COLUMNS = ['id', 'status', 'expires_at', 'estimate_data', ...FINGERPRINT_COLUMNS];

// The ONE loader every chokepoint (and any future caller) reads the row
// through. `db` may be a knex instance or an open transaction; pass the
// caller's trx to read inside its lock, or nothing for a fresh connection
// read. `forUpdate` locks the row for a caller that is about to mutate it in
// the same transaction (estimate-auto-renew.js's renewal UPDATE); every
// chokepoint recheck itself asks for a fresh, unlocked read instead.
async function loadAnnualOfferRow(db, estimateId, { forUpdate = false } = {}) {
  let query = db('estimates').where({ id: estimateId });
  if (forUpdate) query = query.forUpdate();
  return query.first(...ROW_COLUMNS);
}

// A missing/unknown estimate is not this guard's job to fail on — the
// caller's own required-row checks own that. Only a row that actually
// selects the annual plan and fails annualPlanPublicReplayBlocked's gate/
// fingerprint test is withheld.
function annualOfferVerdict(row) {
  if (!row) return { withheld: false, reason: null };
  const withheld = annualPlanPublicReplayBlocked(row);
  return { withheld, reason: withheld ? 'annual_offer_withheld' : null };
}

// Public long link: portal.wavespestcontrol.com/estimate/<token>. Token
// charset mirrors the public estimate routes' own format gate (uncapped
// codex audit, routes/estimate-public.js BOND_TOKEN_RE: 64-hex OR a
// slug-shaped legacy admin token) — permissive on purpose. A path
// separator, whitespace, or any character outside the class ends the match,
// which is what "strip query strings and trailing punctuation" comes down
// to (`?`, `#`, `)`, `.`, `,`, `"` etc. are all outside the charset). A
// stray trailing `-` picked up next to punctuation is trimmed explicitly
// below. Over-matching costs one wasted `estimates` lookup that finds
// nothing; under-matching just means this content-derived path misses an
// id (the explicit-id path is unaffected either way) — there is no
// over-broad-match risk in a guard that only ever narrows a send.
const LONG_LINK_TOKEN_RE = /\/estimate\/([A-Za-z0-9-]{3,80})/g;
// Short link: portal.wavespestcontrol.com/l/<code> (services/short-url.js
// baseUrl() + '/l/' + code). Codes are its own lowercase ALPHABET, optionally
// dash-prefixed for readable invoice-style codes — same permissive stance.
const SHORT_LINK_CODE_RE = /\/l\/([A-Za-z0-9-]{4,80})/g;

// Every regex match across every text, trailing dashes trimmed, deduped.
// Purely synchronous (no await between reset and drain) so the shared
// module-level regex objects' lastIndex is never observed mid-scan by a
// concurrent call.
function extractMatches(texts, re) {
  const out = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const token = m[1].replace(/-+$/, '');
      if (token) out.add(token);
    }
  }
  return out;
}

// Resolve every estimate a send's CONTENT points to. `texts` is an array of
// strings (entries may be undefined/null/non-string — skipped). At most two
// queries total: one for any short codes found (short_codes), one for every
// long token collected either directly from the texts OR from a resolved
// short code's own target_url (a short code whose target is itself a long
// estimate link — the composer/most senders mint a short code that points
// STRAIGHT at the estimate as its target, so entity_type/entity_id already
// answers those without a second lookup; only a short code minted for some
// other purpose whose target happens to embed an estimate link needs the
// target_url re-scan). Zero queries when nothing in the text looks like an
// estimate link at all.
async function estimateIdsFromContent(db, texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  const longTokens = extractMatches(list, LONG_LINK_TOKEN_RE);
  const shortCodes = extractMatches(list, SHORT_LINK_CODE_RE);
  if (!longTokens.size && !shortCodes.size) return [];

  const ids = new Set();
  if (shortCodes.size) {
    const codeRows = await db('short_codes')
      .whereIn('code', [...shortCodes].map((code) => code.toLowerCase()))
      .select('code', 'target_url', 'entity_type', 'entity_id');
    for (const codeRow of codeRows) {
      if (codeRow.entity_type === 'estimates' && codeRow.entity_id) {
        ids.add(codeRow.entity_id);
      } else if (codeRow.target_url) {
        for (const token of extractMatches([codeRow.target_url], LONG_LINK_TOKEN_RE)) longTokens.add(token);
      }
    }
  }
  if (longTokens.size) {
    const tokenRows = await db('estimates').whereIn('token', [...longTokens]).select('id');
    for (const tokenRow of tokenRows) ids.add(tokenRow.id);
  }
  return [...ids];
}

// The chokepoint entry point: build once per send with the ids/texts the
// send carries, call immediately before the provider handoff. `estimateIds`
// is an addition, never the only source — `texts` (the final rendered
// body/html the customer is actually about to receive) is unioned with it
// INSIDE the returned function, so the derivation runs at the handoff on
// the FINAL content, not on whatever was passed when this closure was
// built. Rereads every id fresh (no lock — a chokepoint recheck must never
// contend with a sender's own transaction) so a fingerprint change or gate
// flip that lands after the caller queued the send is still caught at the
// actual handoff. Any single withheld id blocks the whole send: a
// grouped/multi-id send shares one provider call, so one bad sibling must
// stop it. Loader/derivation errors are not caught here — they propagate to
// the caller, which must treat a guard failure as a send failure, never as
// an allowed send.
function annualHandoffGuard({ db, estimateIds, texts }) {
  const explicitIds = (Array.isArray(estimateIds) ? estimateIds : [estimateIds]).filter((id) => id != null);
  return async () => {
    const contentIds = await estimateIdsFromContent(db, texts);
    const ids = [...new Set([...explicitIds, ...contentIds])];
    for (const estimateId of ids) {
      const row = await loadAnnualOfferRow(db, estimateId);
      const verdict = annualOfferVerdict(row);
      if (verdict.withheld) return { blocked: true, reason: verdict.reason, estimateId };
    }
    return { blocked: false, reason: null, estimateId: null };
  };
}

module.exports = { loadAnnualOfferRow, annualOfferVerdict, estimateIdsFromContent, annualHandoffGuard };
