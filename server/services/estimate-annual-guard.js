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
//
// Codex round 2 on #4608: two more P1s on that same mechanism.
//   1. The long-link token regex used a looser charset than the canonical
//      public gate and trimmed a trailing `-`, so a real token containing
//      `_` or ending in `-` would be truncated, resolve no row, and let a
//      withheld send through unnoticed. Fixed by mirroring
//      routes/estimate-public.js's ESTIMATE_TOKEN_RE exactly (see
//      LONG_LINK_TOKEN_RE below) and never trimming long tokens.
//   2. The customer's ONE estimate link renders every link-visible member
//      of the estimate_group_id, not just the one id a send names — a
//      withheld sibling was invisible to this guard. Fixed inside
//      annualHandoffGuard by expanding the resolved ids to their groups'
//      link-visible members (see the group-expansion block below), reusing
//      pricing-authority-gate.js's applyLinkVisibleSiblingScope — the SAME
//      predicate admin-estimates.js's own grouped-send logic already uses
//      for "what does this link actually show" — rather than inventing a
//      second, possibly-looser definition of visibility.

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

// Public long link: portal.wavespestcontrol.com/estimate/<token>. Codex
// round 2 on #4608 (P1): the token charset here MUST be the canonical
// public gate's alphabet, not a looser guess — routes/estimate-public.js's
// ESTIMATE_TOKEN_RE (`^[A-Za-z0-9_-]{15,64}$`, the router.param('token')
// format gate every /:token route in that file shares) is mirrored exactly
// (both charset — `_` IS valid token content, not punctuation — and the
// 15-64 length bound), and NOTHING is trimmed off a matched long token:
// both `_` and a trailing `-` are valid content a real token can end in, so
// stripping either would truncate a real token into one that resolves no
// row and silently let a withheld send through. A path separator,
// whitespace, or any character outside the class still ends the match
// (`?`, `#`, `)`, `.`, `,`, `"` etc. are all outside the charset), which is
// what "strip query strings" comes down to. Over-matching (unreachable now
// that the charset is exact) would only cost one wasted lookup; there is no
// over-broad-match risk in a guard that only ever narrows a send.
const LONG_LINK_TOKEN_RE = /\/estimate\/([A-Za-z0-9_-]{15,64})/g;
// Short link: portal.wavespestcontrol.com/l/<code> (services/short-url.js
// baseUrl() + '/l/' + code). Codes are its own lowercase ALPHABET (never
// `_`, never ambiguous chars), optionally dash-prefixed for readable
// invoice-style codes — same permissive stance as before. Unlike a long
// token, a real code never ends in `-` by construction (generateCode's
// alphabet has no dash, and sanitizeCodePart strips a prefix's OWN trailing
// dashes before joining), so trimming one picked up from adjacent prose
// punctuation is safe here and stays in extractMatches below.
const SHORT_LINK_CODE_RE = /\/l\/([A-Za-z0-9-]{4,80})/g;

// Every regex match across every text, deduped. `trimTrailingDash` (short
// codes only — see SHORT_LINK_CODE_RE above) strips a stray `-` picked up
// next to punctuation; long tokens never trim, since `-` is valid token
// content there. Purely synchronous (no await between reset and drain) so
// the shared module-level regex objects' lastIndex is never observed
// mid-scan by a concurrent call.
function extractMatches(texts, re, { trimTrailingDash = false } = {}) {
  const out = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const token = trimTrailingDash ? m[1].replace(/-+$/, '') : m[1];
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
  const shortCodes = extractMatches(list, SHORT_LINK_CODE_RE, { trimTrailingDash: true });
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

// Codex round 2 on #4608 (P1): the customer's ONE estimate link renders
// every link-visible member of estimate_group_id beside the anchor, so a
// send about the anchor alone still hands out a withheld sibling's link
// too. Expands `rows` (already-loaded base rows — explicit ids ∪
// content-derived ids, each already verdicted by the caller) to every
// OTHER link-visible member of every group among them, in exactly ONE
// query regardless of how many distinct groups are involved (whereIn).
// Reuses pricing-authority-gate.js's applyLinkVisibleSiblingScope — the
// EXACT SQL predicate admin-estimates.js's own grouped-send/link-visible
// logic already runs (status live-and-unexpired OR terminal, unarchived,
// no linkage-invalidation marker) — never a hand-rolled, possibly-looser
// rule: over-inclusion would judge a never-sent draft sibling as withheld
// and wrongly block the anchor's send; under-inclusion leaves the hole
// this fix exists to close.
async function loadLinkVisibleGroupSiblings(db, rows, excludeIds) {
  const groupIds = [...new Set(rows.map((row) => row.estimate_group_id).filter(Boolean))];
  if (!groupIds.length) return [];
  const { applyLinkVisibleSiblingScope } = require('./pricing-authority-gate');
  const query = db('estimates')
    .whereIn('estimate_group_id', groupIds)
    .whereNotIn('id', excludeIds);
  return applyLinkVisibleSiblingScope(query).select(...ROW_COLUMNS);
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
// actual handoff. Any single withheld id — the base ids OR a link-visible
// group sibling of one of them — blocks the whole send: a grouped/multi-id
// send shares one provider call, so one bad sibling must stop it.
// Loader/derivation errors are not caught here — they propagate to the
// caller, which must treat a guard failure as a send failure, never as an
// allowed send.
function annualHandoffGuard({ db, estimateIds, texts }) {
  const explicitIds = (Array.isArray(estimateIds) ? estimateIds : [estimateIds]).filter((id) => id != null);
  return async () => {
    const contentIds = await estimateIdsFromContent(db, texts);
    const baseIds = [...new Set([...explicitIds, ...contentIds])];

    const baseRows = [];
    for (const estimateId of baseIds) {
      const row = await loadAnnualOfferRow(db, estimateId);
      const verdict = annualOfferVerdict(row);
      if (verdict.withheld) return { blocked: true, reason: verdict.reason, estimateId };
      if (row) baseRows.push(row);
    }

    const siblingRows = await loadLinkVisibleGroupSiblings(db, baseRows, baseIds);
    for (const row of siblingRows) {
      const verdict = annualOfferVerdict(row);
      if (verdict.withheld) return { blocked: true, reason: verdict.reason, estimateId: row.id };
    }

    return { blocked: false, reason: null, estimateId: null };
  };
}

module.exports = {
  loadAnnualOfferRow,
  annualOfferVerdict,
  estimateIdsFromContent,
  annualHandoffGuard,
  LONG_LINK_TOKEN_RE,
};
