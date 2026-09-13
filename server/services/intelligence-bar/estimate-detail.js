// get_estimate_detail — what an estimate offered, read from the customer
// page's own projection.
//
// Before this reader the bar could see that estimate links went out
// (find_similar_estimates, the conversation thread) but not the amounts
// inside them: "what did we quote him per application?" ended with the
// operator being sent to the Estimates tab.
//
// HOW IT READS THE AMOUNTS (re-cut, #4345 rounds 1-5). The first cut
// re-projected the customer page's pricing shape by hand off
// estimates.estimate_data + buildPricingBundle: per-application figures,
// low-confidence bands, cadence combos, section selectors, one-time
// breakdown, withholding rules. Five review rounds found the same defect
// at ten different sites — a field the page withholds or renders
// differently that the hand projection re-exposed or re-derived (ranged
// cadences, price-locked rows, quote-required cadences, combined ranges,
// bundle-level quote-required, nested bond/station/interior prices,
// single-service ranges, add-ons, one-time-option availability). The
// counts never fell, because two independent projections of one offer
// cannot be kept in step by review.
//
// So this tool no longer projects anything. It calls
// estimate-public.composeEstimateDataPayload — the exact function that
// builds the JSON body of GET /:token/data, the payload the React estimate
// page renders — and passes the priced sections through VERBATIM. Bands,
// ladders, combos, selectors, breakdowns and their per-field withholding
// are all applied once, by the page's own composer, upstream of this file.
// If the page reshapes one of them, this tool follows the same day with no
// change here. There is no second copy to drift.
//
// WHERE THE PAYLOAD IS NOT THE PIXELS (codex round 6). The composer is the
// page's INPUT, not its render. Two disclosure decisions provably live in
// the client, not in the payload, and this file has to make them or it
// would report amounts no customer ever saw:
//   quote-required — finalizePricingBundle only STAMPS quoteRequired /
//                    reason / items; the numeric bundle is still spread
//                    into pricing. EstimateViewPage exits to the terminal
//                    card before rendering any pricing when canAccept is
//                    false, so a manager-approval / wide-low-confidence /
//                    custom-item quote shows no figure at all. One coarse
//                    gate keyed off the composer's OWN verdict, not a
//                    re-derivation of its per-field rules.
//   sibling totals — propertyGroup carries each sibling's STORED
//                    monthly/annual/one-time columns; those siblings are
//                    never individually composed, so their own
//                    quote-required state is unknown. PropertyGroupSwitcher
//                    renders no recurring aggregate at all and names a
//                    one-time total only when there is no monthly — the one
//                    figure it actually displays is the only one kept.
//
// What this file still owns, and why each one is not a re-projection:
//   membership   — reconcileFrozenMembershipSnapshot with strictMembership,
//                  the opt-in the public route does NOT take: the page may
//                  degrade to nonmember pricing when the live plan lookup
//                  fails, but a staff answer must not report ANY amount off
//                  an unverified frozen snapshot. Failure withholds the
//                  whole projection.
//   links        — the same 404 checks the public page runs
//                  (callSideBlockForEstimateData, isEstimateCustomerViewable,
//                  adminDraftPreviewEligible), reported as link_state so the
//                  operator knows whether the customer can still open it.
//                  The page's 404 is a customer-surface rule, not a
//                  staff-disclosure rule, so an expired estimate still
//                  reports its amounts to the bar.
//   accepted     — price-locked rows retain the selected quote basis.
//                  Recurring columns precede annual-prepay adjustments,
//                  so they are labeled as basis, never as the invoice total.
//   deposits     — estimate_deposits, which the page never shows.
// Record scope: estimate_id resolves to its customer through the
// task-context RECORDS map, customer_id is the customer selector itself.
const db = require('../../models/db');

const { portalUrl } = require('../../utils/portal-url');

const MAX_PER_CUSTOMER = 10;
const DEFAULT_PER_CUSTOMER = 3;
// The canonical portal-origin helper, not a literal: a preview/staging
// deployment resolves its own origin, so the link handed to staff opens the
// estimate on the environment they are actually looking at (pre-push audit
// P1 — the first cut hardcoded the production host).
const estimateLink = (token, query = '') => portalUrl(`/estimate/${encodeURIComponent(token)}${query}`);

function money(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// The public route pulls in the full estimate pipeline; the registry must
// not load it with the tool list.
const lazy = {
  publicRoute: () => require('../../routes/estimate-public'),
  claimSql: () => require('../../utils/estimate-claim-sql'),
};

// ── The page projection ──────────────────────────────────────────────
// Dropped from the payload before it reaches the bar, and NOTHING else:
//   askToken  — a live bearer credential for the ask endpoint. Never leaves
//               the page's own response.
//   token     — the estimate link secret; the openable link is already
//               reported as customer_link when the page would serve it.
//   intelligence / showYourWork — the page's generated narrative and
//               reasoning copy. No amounts, thousands of tokens of context.
//   satelliteUrl / licenseNumber — page chrome.
//   notes     — already reported as customer_notes at the top level.
// Everything else passes through untouched. The list is a DENYLIST on
// purpose: a priced section the page adds tomorrow arrives here on its own,
// which is the whole point of the re-cut.
const DROPPED_PAYLOAD_KEYS = new Set(['intelligence', 'showYourWork']);
const DROPPED_ESTIMATE_KEYS = new Set([
  'askToken', 'token', 'intelligence', 'satelliteUrl', 'licenseNumber', 'notes',
]);

// The one-time figure the switcher actually displays, for one sibling:
// PropertyGroupSwitcher shows "$X one-time" only when the sibling has a
// one-time total and NO monthly (EstimateViewPage.jsx priceLabel), and shows
// no recurring aggregate ever. The raw stored columns behind that decision
// are dropped: a sibling is never individually composed, so nothing here
// knows whether its own page would have withheld them.
function siblingEntry(sibling) {
  const { monthlyTotal, annualTotal: _annualTotal, onetimeTotal, token, ...rest } = sibling || {};
  const displayed = Number(onetimeTotal) > 0 && !(Number(monthlyTotal) > 0) ? Number(onetimeTotal) : null;
  return {
    ...rest,
    // Wrapped as a link, never the raw token — the same rule the primary
    // estimate's own block follows. A sibling token opens that property's
    // full estimate page to whoever holds it.
    // The current estimate's link is governed by the top-level link state.
    ...(token && !sibling.isCurrent ? { link: estimateLink(token) } : {}),
    displayed_one_time_total: displayed,
    // Enough for the operator to know a sibling is a plan without giving a
    // figure its own page may have withheld.
    has_recurring_plan: Number(monthlyTotal) > 0,
  };
}

// The exact price fields a RANGED node carries but the page never shows.
// `stampLowConfidenceRangeOnServices` / `withCombinedLowConfidenceRange`
// (estimate-public.js:22487, 22518) only ADD `lowConfidenceRangePct` +
// `lowConfidenceFraction` to a cadence — its exact `monthly`, `annual`,
// `perTreatment` and per-service treatment rows stay on the payload, and
// PriceCard converts the price to a "$X-$Y/mo, confirmed on site" band and
// drops the per-visit rows entirely while ranging (PriceCard.jsx:289-313).
// So the same rule as quote-required, at whatever depth the stamp appears:
// keyed off the server's OWN marker, one generic pass, no mirror of the
// client's band arithmetic. The stamp itself rides along, so the bar can say
// the price is a confirmed-on-site range and point at the page for the band.
const RANGED_METADATA_FIELDS = ['key', 'label', 'selection', 'lowConfidenceRangePct', 'lowConfidenceFraction', 'quoteRequired', 'quoteRequiredReason'];

function sanitizeRangedNode(node) {
  // Keep only cadence/range metadata. Base amounts, discount amounts and
  // nested treatment rows also reveal the hidden exact price.
  const out = {};
  for (const field of RANGED_METADATA_FIELDS) {
    if (Object.hasOwn(node, field)) out[field] = node[field];
  }
  out.ranged = 'low_confidence_confirmed_on_site';
  out.ranged_note = 'the page renders this as a "confirmed on site" range around a price it never shows exactly; open the estimate link for the band';
  return out;
}

// Depth-agnostic on purpose: a ranged cadence can sit on a top-level
// frequency, inside services[].frequencies[], or on the combined recurring
// card, and a future placement would otherwise leak again.
function sanitizeRanges(value) {
  if (Array.isArray(value)) return value.map(sanitizeRanges);
  if (!value || typeof value !== 'object') return value;
  const walked = {};
  for (const [k, v] of Object.entries(value)) walked[k] = sanitizeRanges(v);
  // quoteRequired cadences are already priceless on the page — PriceCard
  // zeroes the pct for them — so they need no stripping here.
  if (Number(walked.lowConfidenceRangePct) > 0 && walked.quoteRequired !== true) return sanitizeRangedNode(walked);
  return walked;
}

function stripPayload(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (DROPPED_PAYLOAD_KEYS.has(key)) continue;
    if (key === 'estimate' && value && typeof value === 'object') {
      const estimateBlock = {};
      for (const [k, v] of Object.entries(value)) {
        if (DROPPED_ESTIMATE_KEYS.has(k)) continue;
        estimateBlock[k] = v;
      }
      out.estimate = estimateBlock;
      continue;
    }
    out[key] = value;
  }
  if (Array.isArray(out.propertyGroup)) out.propertyGroup = out.propertyGroup.map(siblingEntry);
  if (out.pricing) {
    out.pricing = sanitizeRanges(out.pricing);
    // Retained by the server only to honor stale clients' accept requests;
    // the current customer page does not offer these floor-clamped tiers.
    delete out.pricing.hiddenLawnFrequencies;
    // The page renders the stamped service cards; its aggregate fallback
    // frequencies retain exact, unstamped prices in the same payload.
    if (out.pricing.combinedRecurring?.ranged) {
      for (const key of ['frequencies', 'serviceCadenceCombos']) {
        if (Array.isArray(out.pricing[key])) out.pricing[key] = out.pricing[key].map(sanitizeRangedNode);
      }
    }
  }
  // The page renders NO pricing for a quote-required bundle — the client
  // exits to the terminal card first — so neither does this tool. The
  // composer's own verdict decides it; the reason rides along because that
  // is the answer to "why is there no price yet". An authored proposal is
  // quote-required BY DESIGN and its page does show the proposal (that is
  // the billed quote), so `proposal` is untouched here.
  if (out.cta && out.cta.quoteRequired === true) {
    // The terminal card also precedes the payment controls. Their deposit
    // and no-show amounts are not part of the offer the customer sees.
    delete out.depositPolicy;
    delete out.cardHoldPolicy;
    if (out.estimate) delete out.estimate.membership;
    out.pricing = {
      withheld: 'quote_required',
      reason: out.cta.quoteRequiredReason || null,
      note: 'the customer page shows no amounts for this estimate — it exits to the quote-required card before rendering any pricing',
    };
  }
  return out;
}

// Group entries are composed without the durable call-side provenance gate.
// Verify each sibling's full persisted row before returning its identity or
// bearer link. A failed lookup withholds the group, not the verified estimate.
async function verifiedPropertyGroup(group) {
  if (!Array.isArray(group)) return group;
  try {
    const tokens = group.filter((sibling) => !sibling.isCurrent && sibling.token).map((sibling) => sibling.token);
    const rows = tokens.length ? await db('estimates').whereIn('token', tokens).select('*') : [];
    const byToken = new Map(rows.map((row) => [row.token, row]));
    const verified = [];
    for (const sibling of group) {
      if (sibling.isCurrent) {
        verified.push(sibling);
        continue;
      }
      const row = byToken.get(sibling.token);
      if (!row) continue;
      const links = await estimateLinks(row, lazy.publicRoute().parseEstimateDataSafe(row));
      if (links.link_state === 'customer_viewable') verified.push(sibling);
    }
    return verified;
  } catch {
    return null;
  }
}

// The page's own composer, run for this row. adminDraftPreview mirrors what
// a staff "Customer View" of an unpublished draft renders (the page serves
// drafts to verified staff only, and this tool is staff-only behind the
// intelligence-bar gate) — for every other row it is false, so the
// projection is byte-for-byte the customer's. isPdfRenderPass stays false:
// the document render is a different surface with a signed display pin.
async function pageProjection(row, linkState) {
  try {
    const payload = await lazy.publicRoute().composeEstimateDataPayload(row, {
      adminDraftPreview: linkState === 'staff_preview_only',
      isPdfRenderPass: false,
      docRenderPin: null,
    });
    if (!payload || typeof payload !== 'object') {
      return { page: null, page_unavailable: 'the estimate page composed no payload for this row' };
    }
    return { page: stripPayload({ ...payload, propertyGroup: await verifiedPropertyGroup(payload.propertyGroup) }) };
  } catch (err) {
    // The page itself would 500 for this row — say so rather than falling
    // back to the stored columns. This tool exists because those columns are
    // not the quote.
    return { page: null, page_unavailable: `the estimate page could not be composed: ${err.message}` };
  }
}

// ── Links ────────────────────────────────────────────────────────────
// Only where the public route would serve them: the durable call-side
// block and the customer-surface check first (both 404 on the public
// page), then the customer link when isEstimateCustomerViewable says so,
// the staff draft preview for an unpublished, unarchived row, nothing
// otherwise.
async function estimateLinks(row, data) {
  let blocked = false;
  try {
    const { estimateOffCustomerSurface, callSideBlockForEstimateData } = lazy.claimSql();
    blocked = estimateOffCustomerSurface(row) || !!(await callSideBlockForEstimateData(db, data));
  } catch {
    blocked = true; // fail closed: an unverifiable block is not a link
  }
  if (blocked) return { customer_link: null, staff_preview_link: null, link_state: 'blocked' };
  if (!row.token) return { customer_link: null, staff_preview_link: null, link_state: 'no_token' };
  const publicRoute = lazy.publicRoute();
  if (publicRoute.isEstimateCustomerViewable(row)) {
    return { customer_link: estimateLink(row.token), staff_preview_link: null, link_state: 'customer_viewable' };
  }
  if (publicRoute.adminDraftPreviewEligible(row, '1')) {
    return { customer_link: null, staff_preview_link: estimateLink(row.token, '?adminPreview=1'), link_state: 'staff_preview_only' };
  }
  return { customer_link: null, staff_preview_link: null, link_state: 'not_openable' };
}

// Same order as the public renderers: reconcile the frozen membership
// snapshot FIRST (it mutates the row's pricing data in memory for a lapsed
// member), then compose the page from the reconciled row.
//
// STRICT here and nowhere else. The reconciler's default live probe reads a
// failed customers lookup as "no plan" — right for the page, which then
// renders nonmember pricing and still sells. A staff answer has the opposite
// requirement: reporting a member discount that may no longer exist is worse
// than reporting nothing, so strictMembership turns that lookup failure into
// { ok: false } and the whole projection is withheld. (Round 5 caught the
// inverse of this shipped as a regression: strictness applied to the PUBLIC
// route, whose callers ignore the result.)
//
// Skipped for exactly the rows the real reconciler itself refuses to touch
// (accepted, or an explicit price_locked_at stamp) — see membershipFrozen.
// The reconciler's OWN frozen test, mirrored exactly (estimate-public.js
// reconcileFrozenMembershipSnapshot: `status === 'accepted' ||
// price_locked_at`). Used for both decisions that depend on it — whether to
// reconcile at all, and whether a stored total may be reported as committed —
// so the two can never disagree. The first cut used
// estimateIsPriceLocked here, which ALSO counts a plain 'declined' row: that
// row is one the real reconciler would happily reprice, so skipping the
// reconcile for it and then reporting its stored columns as "committed" was
// a figure nothing had verified (pre-push audit P1). A declined row is now
// reconciled like any other, and commits nothing — because it committed
// nothing.
// SIDE EFFECTS, since this is a registered READ tool (action-policy kind:
// "read", approval null) and the pre-push auditor asked: the reconciler
// persists NOTHING. It mutates the in-memory row, and clears that estimate's
// entry in the in-process pricing cache so the next page load recomputes —
// verified against estimate-public.js reconcileFrozenMembershipSnapshot,
// whose only non-local calls are invalidateSendSnapshotPricingBundle (on the
// parsed object) and clearEstimatePricingCache(id). No UPDATE, no INSERT.
// Its one DB read is the live plan lookup, once per row, at most
// MAX_PER_CUSTOMER rows per call. The reconcile runs BEFORE the provenance
// check on purpose — that is the public route's own order, and reading the
// row's linkage from a pre-reconcile copy was itself a review finding — and
// costs a blocked row nothing but that cache invalidation.
const membershipFrozen = (row) => String(row.status || '').trim().toLowerCase() === 'accepted' || !!row.price_locked_at;

async function reconcileMembership(row) {
  if (membershipFrozen(row)) return null;
  try {
    const result = await lazy.publicRoute().reconcileFrozenMembershipSnapshot(row, { strictMembership: true });
    if (result && result.ok === false) return `membership reconciliation failed: ${result.error || 'unknown error'}`;
    return null;
  } catch (err) {
    return `membership reconciliation failed: ${err.message}`;
  }
}

// Deposits: amount is the FACE value requested; card_surcharge is the extra
// cash collected on top of it and refunded_surcharge how much of that fee went
// back (null = no explicit record). Only the statuses that follow a
// successful capture record cash that was taken (estimate-deposits.js:
// received → credited / refunding → refunded); a 'pending' row is an
// abandoned Stripe intent kept for the deposit follow-up stage and 'failed'
// is a canceled one — nothing was collected for either (or for any unknown
// status), so collected is false and total_paid null.
const COLLECTED_DEPOSIT_STATUSES = new Set(['received', 'credited', 'refunding', 'refunded']);
function depositEntry(d) {
  const collected = COLLECTED_DEPOSIT_STATUSES.has(d.status);
  return {
    amount: money(d.amount), card_surcharge: money(d.card_surcharge), collected,
    total_paid: collected ? money(Number(d.amount || 0) + Number(d.card_surcharge || 0)) : null,
    credited: money(d.credited_amount), refunded: money(d.refunded_amount), refunded_surcharge: money(d.refunded_surcharge),
    status: d.status, received_at: d.received_at,
  };
}

// A call-side BLOCK suppresses the WHOLE record, not just its pricing
// (codex round 6 P1). That block means the row's provenance is in doubt —
// wrong-identity draft, changed linkage, a rejected or in-flight call — so
// the customer name, address, notes, deposits and any committed total may
// belong to someone else entirely. The public route answers a bare 404 for
// exactly this condition; a staff reader gets the block and nothing to
// misattribute.
function blockedRecord(row) {
  return {
    id: row.id,
    withheld: 'provenance_blocked',
    page: null,
    page_unavailable: 'withheld: an estimate or call-side hold prevents verifying this estimate — its contents or pricing may no longer match the customer',
    customer_link: null,
    staff_preview_link: null,
    link_state: 'blocked',
  };
}

// The stored accepted pricing, split by the lane the customer selected.
// Recurring columns are a quote basis, not the annual-prepay commitment:
// the accepted invoice separately applies prepay adjustments, tax and
// credits. The estimate does not persist a dependable billing-term marker.
// A mixed estimate keeps BOTH lanes' columns after acceptance —
// onetime_total still holds the one-time alternative on a recurring accept,
// monthly_total/annual_total still hold the recurring alternative on a
// one-time accept — so publishing all three as "what was committed" let the
// bar report an option the customer declined as part of the deal (codex
// round 7 P2). accepted_service_mode says which lane won; the loser rides
// along under `unselected_alternative`, named for what it is. A legacy
// accept with no stored mode (or a price_locked_at stamp with no accept at
// all) cannot be split, so it reports every column with the mode set to
// null — the honest "unknown".
function committedTotals(row) {
  const mode = row.accepted_service_mode || null;
  const recurring = { monthly: money(row.monthly_total), annual: money(row.annual_total) };
  const recurringBasis = {
    recurring_quote_basis: recurring,
    recurring_basis_note: 'stored recurring quote basis before any annual-prepay adjustment; not the accepted invoice total or amount due — read the linked invoice for final discounts, tax and credits',
  };
  const oneTime = { one_time: money(row.onetime_total) };
  const locked_at = row.price_locked_at || row.accepted_at || row.declined_at || null;
  if (mode === 'recurring') {
    return { ...recurringBasis, accepted_service_mode: mode, locked_at, unselected_alternative: oneTime };
  }
  if (mode === 'one_time') {
    return { ...oneTime, accepted_service_mode: mode, locked_at, unselected_alternative: recurring };
  }
  return { ...recurringBasis, ...oneTime, accepted_service_mode: mode, locked_at };
}

async function shapeEstimate(row, deposits = []) {
  const reconciliation_error = await reconcileMembership(row);
  // Parsed AFTER the reconcile, never before (pre-push audit P1): the
  // reconciler rewrites row.estimate_data in place for a lapsed member, and
  // the public route runs its own call-side-block check on the
  // post-reconcile row. Reading a pre-mutation copy here would be the same
  // two-projections-of-one-row divergence this re-cut exists to remove.
  const data = lazy.publicRoute().parseEstimateDataSafe(row);
  const links = await estimateLinks(row, data);
  if (links.link_state === 'blocked') return blockedRecord(row);
  // Withheld outright when the live membership state could not be verified:
  // the row is then the stale frozen-member snapshot, and a page composed
  // from it would quote a discount that may no longer be given.
  const projection = reconciliation_error
    ? { page: null, page_unavailable: `withheld: ${reconciliation_error}` }
    : await pageProjection(row, links.link_state);
  // The committed deal, for a row whose price is locked (accepted, declined,
  // or explicitly stamped). These are the columns the send/accept path wrote
  // and the composer does not recompute them, so they are the answer to
  // "what did he accept" — and ONLY that. An unlocked row has no committed
  // figure: its price is whatever the page renders today, in `page`.
  const priceLocked = membershipFrozen(row);
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer: row.customer_name,
    address: row.address,
    status: row.status,
    disposition: row.disposition || null,
    disposition_note: row.disposition_note || null,
    decline_reason: row.decline_reason || null,
    category: row.category,
    service_interest: row.service_interest,
    tier: row.waveguard_tier,
    pricing_version: row.pricing_version || null,
    price_locked: !!priceLocked,
    ...(priceLocked
      ? {
        committed_totals: committedTotals(row),
      }
      : {}),
    ...projection,
    ...(reconciliation_error ? { reconciliation_error } : {}),
    accepted: row.accepted_at ? { at: row.accepted_at, service_mode: row.accepted_service_mode || null, frequency: row.accepted_frequency_key || null } : null,
    deposits: deposits.map(depositEntry),
    customer_notes: row.notes || null,
    ...links,
    sent_at: row.sent_at,
    viewed_at: row.viewed_at,
    view_count: row.view_count || 0,
    declined_at: row.declined_at,
    expires_at: row.expires_at,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getEstimateDetail({ estimate_id, customer_id, limit } = {}) {
  if (!estimate_id && !customer_id) return { error: 'Provide estimate_id or customer_id' };
  // The whole row: the public route's reconciler and page composer read the
  // estimate the way the public handlers load it (select *), so a column
  // subset here could starve them of a field they consult.
  let query = db('estimates').select('*').orderBy('created_at', 'desc');
  if (estimate_id) {
    query = query.where('id', estimate_id).limit(1);
  } else {
    const count = Math.max(1, Math.min(Math.trunc(Number(limit)) || DEFAULT_PER_CUSTOMER, MAX_PER_CUSTOMER));
    query = query.where('customer_id', customer_id).whereNull('archived_at').limit(count);
  }
  const rows = await query;
  if (!rows.length) {
    return {
      count: 0,
      estimates: [],
      error: estimate_id ? 'No estimate matches that id' : 'No estimates on file for that customer',
    };
  }
  const deposits = await db('estimate_deposits')
    .whereIn('estimate_id', rows.map((r) => r.id))
    .select('estimate_id', 'amount', 'card_surcharge', 'credited_amount', 'refunded_amount', 'refunded_surcharge', 'status', 'received_at')
    .orderBy('created_at', 'desc');
  const byEstimate = new Map();
  for (const d of deposits) {
    if (!byEstimate.has(d.estimate_id)) byEstimate.set(d.estimate_id, []);
    byEstimate.get(d.estimate_id).push(d);
  }
  const estimates = [];
  for (const row of rows) estimates.push(await shapeEstimate(row, byEstimate.get(row.id) || []));
  return { count: rows.length, estimates };
}

const GET_ESTIMATE_DETAIL_TOOL = {
  name: 'get_estimate_detail',
  description: `Read what an estimate offered, as the customer's own estimate page prices it. Returns that page's projection verbatim under \`page\`: \`page.pricing\` carries the plan cadences with their monthly / annual prices and per-application figures, each service's cadence ladder with its selectable additions (termite bond terms, station rental, commercial interior service), the priced cadence combinations on a mixed estimate, the one-time breakdown and upfront fees; \`page.cta\` carries the page's quote-required verdict and reason, whether it can still be self-accepted, and whether it bills monthly; \`page.estimate\` carries status, membership, effective invoice mode and acceptance; a formal commercial proposal arrives under \`page.proposal\` (that is the billed quote, not the engine rows). The page's own withholding applies before you see it — a quote-required bundle arrives as \`page.pricing.withheld = quote_required\` with the reason and no amounts at all, because that page shows the customer no figure — so quote whatever \`page\` says and nothing more. A grouped multi-property estimate lists its siblings under \`page.propertyGroup\` with only the one-time figure their switcher displays; each sibling's own page has to be read for its plan pricing. Also returns deposits (face amount + card surcharge; a pending or failed intent collected nothing), status and timestamps, and which link (customer or staff preview) can actually be opened. A lapsed membership is reconciled first so the amounts match the live page; when the live membership state cannot be verified, \`page\` is null and page_unavailable says so — never quote from a withheld projection. An ACCEPTED estimate, or one with an explicit price-lock stamp, also reports committed_totals split by accepted_service_mode, with the lane the customer did not take under unselected_alternative. Recurring columns are explicitly recurring_quote_basis, before any annual-prepay adjustment; they are NOT the accepted invoice total or amount due. Read the linked invoice for final discounts, tax and credits; never infer the prepay amount or selection from this basis. A declined estimate with no price-lock stamp has no committed figure at all (nothing was committed) and reports none. A cadence the page ranges rather than prices ("confirmed on site") arrives with its exact figures removed and ranged set instead — open the estimate link for the band.
Use for: "what did we quote him for quarterly pest", "what is the per-application price on her estimate", "what would monthly have cost", "what did the 9/5 estimate say" — anything about the amounts inside a sent estimate. Prefer this over guessing from monthly_rate or from the SMS thread. Pass estimate_id for one estimate or customer_id for that customer's latest estimates (newest first).`,
  input_schema: {
    type: 'object',
    properties: {
      estimate_id: { type: 'string', format: 'uuid', description: 'Estimate UUID — returns exactly that estimate' },
      customer_id: { type: 'string', format: 'uuid', description: 'Customer UUID — returns that customer\'s latest estimates when no estimate_id is given' },
      limit: { type: 'number', description: 'With customer_id: how many recent estimates to return (default 3, max 10)' },
    },
  },
};

module.exports = { GET_ESTIMATE_DETAIL_TOOL, getEstimateDetail, shapeEstimate };
