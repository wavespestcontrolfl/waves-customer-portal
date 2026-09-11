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
// page renders — and passes the priced sections through VERBATIM. Every
// withholding rule, every band, every quote-required verdict is applied
// once, by the page's own composer, upstream of this file. If the page
// starts withholding something new, this tool withholds it the same day
// with no change here; if it exposes something new, the bar can answer
// about it the same day. There is no second copy to drift.
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
//   committed    — for a price-locked row (accepted / declined /
//                  price_locked_at) the stored monthly/annual/onetime
//                  columns ARE the committed deal and the composer does not
//                  recompute them; they are reported as committed_totals,
//                  never as "the price today".
//   deposits     — estimate_deposits, which the page never shows.
// Record scope: estimate_id resolves to its customer through the
// task-context RECORDS map, customer_id is the customer selector itself.
const db = require('../../models/db');

const MAX_PER_CUSTOMER = 10;
const DEFAULT_PER_CUSTOMER = 3;
const PUBLIC_ESTIMATE_BASE = 'https://portal.wavespestcontrol.com/estimate/';

function money(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseStoredJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// The public route pulls in the full estimate pipeline; the registry must
// not load it with the tool list.
const lazy = {
  publicRoute: () => require('../../routes/estimate-public'),
  claimSql: () => require('../../utils/estimate-claim-sql'),
  proposalBilling: () => require('../estimate-proposal-billing'),
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
  return out;
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
    return { page: stripPayload(payload) };
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
  if (!row.token) return { customer_link: null, staff_preview_link: null, link_state: 'no_token' };
  let blocked = false;
  try {
    blocked = !!(await lazy.claimSql().callSideBlockForEstimateData(db, data));
  } catch {
    blocked = true; // fail closed: an unverifiable block is not a link
  }
  if (blocked) return { customer_link: null, staff_preview_link: null, link_state: 'blocked' };
  const publicRoute = lazy.publicRoute();
  if (publicRoute.isEstimateCustomerViewable(row)) {
    return { customer_link: `${PUBLIC_ESTIMATE_BASE}${row.token}`, staff_preview_link: null, link_state: 'customer_viewable' };
  }
  if (publicRoute.adminDraftPreviewEligible(row, '1')) {
    return { customer_link: null, staff_preview_link: `${PUBLIC_ESTIMATE_BASE}${row.token}?adminPreview=1`, link_state: 'staff_preview_only' };
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
// Skipped ENTIRELY for a price-locked row (estimateIsPriceLocked: status
// accepted/declined, or price_locked_at stamped) — the real reconciler only
// refuses to touch 'accepted' or an explicit price_locked_at stamp, NOT
// 'declined', so a declined-but-unstamped row's committed columns could
// still be repriced in memory by a later membership lapse.
async function reconcileMembership(row) {
  if (lazy.proposalBilling().estimateIsPriceLocked(row)) return null;
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

async function shapeEstimate(row, deposits = []) {
  const data = parseStoredJson(row.estimate_data);
  const reconciliation_error = await reconcileMembership(row);
  const links = await estimateLinks(row, data);
  // Withheld outright when the live membership state could not be verified:
  // the row is then the stale frozen-member snapshot, and a page composed
  // from it would quote a discount that may no longer be given.
  //
  // A call-side BLOCK withholds it too, and for a different reason: that
  // block means the estimate's own provenance is in doubt (wrong-identity
  // draft, rejected or in-flight call), so its amounts may belong to another
  // customer entirely. The page 404s it for exactly that reason; a staff
  // answer must not launder it back out.
  const projection = reconciliation_error
    ? { page: null, page_unavailable: `withheld: ${reconciliation_error}` }
    : links.link_state === 'blocked'
      ? { page: null, page_unavailable: 'withheld: a call-side block is on this estimate — its provenance is unverified, so the page will not serve it to anyone' }
      : await pageProjection(row, links.link_state);
  // The committed deal, for a row whose price is locked (accepted, declined,
  // or explicitly stamped). These are the columns the send/accept path wrote
  // and the composer does not recompute them, so they are the answer to
  // "what did he accept" — and ONLY that. An unlocked row has no committed
  // figure: its price is whatever the page renders today, in `page`.
  const priceLocked = lazy.proposalBilling().estimateIsPriceLocked(row);
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
    ...(priceLocked && !reconciliation_error
      ? {
        committed_totals: {
          monthly: money(row.monthly_total),
          annual: money(row.annual_total),
          one_time: money(row.onetime_total),
          locked_at: row.price_locked_at || row.accepted_at || row.declined_at || null,
        },
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
  description: `Read what an estimate offered, as the customer's own estimate page prices it. Returns that page's projection verbatim under \`page\`: \`page.pricing\` carries the plan cadences with their monthly / annual prices and per-application figures, each service's cadence ladder with its selectable additions (termite bond terms, station rental, commercial interior service), the priced cadence combinations on a mixed estimate, the one-time breakdown and upfront fees; \`page.cta\` carries the page's quote-required verdict and reason, whether it can still be self-accepted, and whether it bills monthly; \`page.estimate\` carries status, membership, effective invoice mode and acceptance; a formal commercial proposal arrives under \`page.proposal\` (that is the billed quote, not the engine rows). The page's own withholding applies before you see it — a low-confidence commercial price arrives as its range, a quote-required bundle arrives with no amounts — so quote whatever \`page\` says and nothing more. Also returns deposits (face amount + card surcharge; a pending or failed intent collected nothing), status and timestamps, and which link (customer or staff preview) can actually be opened. A lapsed membership is reconciled first so the amounts match the live page; when the live membership state cannot be verified, \`page\` is null and page_unavailable says so — never quote from a withheld projection. An accepted or declined estimate also reports committed_totals: what was actually committed, which is not the same as what the page would price today.
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
