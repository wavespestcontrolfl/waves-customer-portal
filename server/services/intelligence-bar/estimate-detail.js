// Read one estimate through the customer page's own composer. Apply the
// client's disclosure rules to the composed payload, verify provenance and
// membership, and report whether the customer or staff can open the link.
// Record scope: task-context resolves estimate_id to its customer.
const db = require('../../models/db');

const { portalUrl } = require('../../utils/portal-url');
const MAX_PER_CUSTOMER = 10;
const DEFAULT_PER_CUSTOMER = 3;

// Resolve the portal origin in each environment for customer and staff links.
const estimateLink = (token, query = '') => portalUrl(`/estimate/${encodeURIComponent(token)}${query}`);

// The public route pulls in the full estimate pipeline; the registry must
// not load it with the tool list.
const lazy = {
  publicRoute: () => require('../../routes/estimate-public'),
  claimSql: () => require('../../utils/estimate-claim-sql'),
};

// ── The page projection ──────────────────────────────────────────────
// Drop credentials, generated copy, chrome, and unverified sibling details:
//   askToken  — a live bearer credential for the ask endpoint. Never leaves
//               the page's own response.
//   token     — the estimate link secret; the openable link is already
//               reported as customer_link when the page would serve it.
//   intelligence / showYourWork — the page's generated narrative and
//               reasoning copy. No amounts, thousands of tokens of context.
//   satelliteUrl / licenseNumber — page chrome.
//   notes     — already reported as customer_notes at the top level.
// Other priced sections pass through so the reader tracks the page composer.
// consultationOffer.url is a live 14-day /inspection bearer that can book
// a visit (Codex #4853 r1 P1) — never handed to the model.
const DROPPED_PAYLOAD_KEYS = new Set(['intelligence', 'showYourWork', 'propertyGroup', 'consultationOffer']);
const DROPPED_ESTIMATE_KEYS = new Set([
  'askToken', 'token', 'intelligence', 'satelliteUrl', 'licenseNumber', 'notes',
]);

// PriceCard renders a range for low-confidence cadences, never the exact
// monthly, annual, or per-treatment amounts still present in the payload.
const RANGED_METADATA_FIELDS = ['key', 'label', 'selection', 'lowConfidenceRangePct', 'quoteRequired', 'quoteRequiredReason'];

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

// Residential combined cards say "Priced per application". Keep only
// selection/display metadata and the itemized application rows: aggregate
// base prices and discounts can reconstruct the hidden total too.
function stripCombinedAmounts(node) {
  const out = {};
  for (const field of [
    ...RANGED_METADATA_FIELDS, 'ranged', 'ranged_note', 'perServiceTreatments', 'addOns',
    'waveGuardTier', 'waveGuardTierLabel', 'waveGuardDiscountPct', 'qualifyingCount',
  ]) {
    if (Object.hasOwn(node, field)) out[field] = node[field];
  }
  out.combined_total_withheld = 'priced_per_application';
  return out;
}

function suppressResidentialCombinedTotals(pricing, cta = {}) {
  // EstimateViewPage's billsMonthly predicate, including its reason fallback.
  const reason = cta.quoteRequiredReason || pricing.quoteRequiredReason || pricing.quoteRequiredItems?.[0]?.reason || '';
  const billsMonthly = cta.commercialProposal === true || reason === 'commercial_proposal'
    || cta.commercialAutoPriced === true || cta.monthlyBilled === true;
  const services = pricing.services || [];
  const hasCombinedPlan = services.some((section) => section.key === 'bundle')
    || services.filter((section) => section.isRecurring).length > 1;
  if (billsMonthly || !hasCombinedPlan) return;
  // Whole-plan percentage/amount metadata can reconstruct the hidden base.
  // PlanTotalSummary displays only the credit label.
  if (pricing.manualDiscount) pricing.manualDiscount = { label: pricing.manualDiscount.label || 'Discount' };
  pricing.services = services.map((section) => section.key === 'bundle'
    ? { ...section, frequencies: (section.frequencies || []).map(stripCombinedAmounts) }
    : section);
  for (const key of ['frequencies', 'serviceCadenceCombos']) {
    if (Array.isArray(pricing[key])) pricing[key] = pricing[key].map(stripCombinedAmounts);
  }
  if (pricing.combinedRecurring) pricing.combinedRecurring = stripCombinedAmounts(pricing.combinedRecurring);
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
  if (out.pricing) {
    out.pricing = sanitizeRanges(out.pricing);
    suppressResidentialCombinedTotals(out.pricing, out.cta);
    // Retained by the server only to honor stale clients' accept requests;
    // the current customer page does not offer these floor-clamped tiers.
    delete out.pricing.hiddenLawnFrequencies;
    // The page renders the stamped service cards; its aggregate fallback
    // frequencies retain exact, unstamped prices in the same payload.
    if (out.pricing.combinedRecurring?.ranged) {
      // A whole-plan percentage discount also reveals the exact range base.
      if (out.pricing.manualDiscount) out.pricing.manualDiscount = { label: out.pricing.manualDiscount.label || 'Discount' };
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

// The composer builds its switcher from a separate sibling read. Verify its
// tokens against complete persisted rows before exposing even an address.
// The payload supplies selectors only; identity and links come from the DB.
function sameGroupCustomer(current, sibling) {
  // Match admin-estimate-persistence.ensureEstimateGroupId: any linked
  // customer requires equal IDs; two lead-only rows need a phone or email.
  if (current.customer_id || sibling.customer_id) return current.customer_id === sibling.customer_id;
  const phone = (value) => String(value || '').replace(/\D/g, '').slice(-10);
  const email = (value) => String(value || '').trim().toLowerCase();
  return (phone(current.customer_phone).length === 10 && phone(current.customer_phone) === phone(sibling.customer_phone))
    || !!(email(current.customer_email) && email(current.customer_email) === email(sibling.customer_email));
}

async function verifiedPropertyGroup(group, current) {
  if (!Array.isArray(group)) return null;
  if (!current.estimate_group_id) return null;
  try {
    const siblings = group.filter((entry) => !entry.isCurrent);
    if (group.filter((entry) => entry.isCurrent).length !== 1
      || group.find((entry) => entry.isCurrent)?.token !== current.token
      || siblings.some((entry) => !entry.token || entry.token === current.token)) return null;
    const tokens = siblings.map((entry) => entry.token);
    if (new Set(tokens).size !== tokens.length) return null;
    const rows = await db('estimates').select('*').whereIn('token', tokens);
    if (rows.length !== tokens.length) return null;
    const byToken = new Map(rows.map((sibling) => [sibling.token, sibling]));
    const verified = [];
    for (const entry of group) {
      const sibling = entry.isCurrent ? current : byToken.get(entry.token);
      if (!sibling || sibling.estimate_group_id !== current.estimate_group_id
        || !sameGroupCustomer(current, sibling)) return null;
      const links = await estimateLinks(sibling, lazy.publicRoute().parseEstimateDataSafe(sibling));
      if (links.link_state === 'blocked' || (!entry.isCurrent && links.link_state !== 'customer_viewable')) return null;
      verified.push({
        id: sibling.id, address: sibling.address || null, status: sibling.status, isCurrent: sibling.id === current.id,
        customer_link: links.customer_link, staff_preview_link: links.staff_preview_link,
      });
    }
    return verified;
  } catch {
    return null;
  }
}

// Drafts use the same staff preview mode as the Customer View page.
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
    const page = stripPayload(payload);
    if (Array.isArray(payload.propertyGroup)) {
      const group = await verifiedPropertyGroup(payload.propertyGroup, row);
      if (group) page.propertyGroup = group;
    }
    return { page };
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
    blocked = estimateOffCustomerSurface(row) || !!(await callSideBlockForEstimateData(db, data, { estimateStatus: row?.status }));
  } catch {
    blocked = true; // fail closed: an unverifiable block is not a link
  }
  if (blocked) return { customer_link: null, staff_preview_link: null, link_state: 'blocked' };
  if (!row.token) return { customer_link: null, staff_preview_link: null, link_state: 'no_token' };
  const publicRoute = lazy.publicRoute();
  if (publicRoute.isEstimateCustomerViewable(row)) {
    return { customer_link: estimateLink(row.token), staff_preview_link: estimateLink(row.token, '?adminPreview=1'), link_state: 'customer_viewable' };
  }
  if (publicRoute.adminDraftPreviewEligible(row, '1')) {
    return { customer_link: null, staff_preview_link: estimateLink(row.token, '?adminPreview=1'), link_state: 'staff_preview_only' };
  }
  return { customer_link: null, staff_preview_link: null, link_state: 'not_openable' };
}

// Reconcile before provenance and composition because the reconciler mutates
// the row in memory. Accepted or explicitly locked rows retain their frozen
// snapshot; other rows require a verified live membership lookup.
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

// A provenance block withholds the whole record, including identity.
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

async function shapeEstimate(row) {
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
    price_locked: !!membershipFrozen(row),
    price_locked_at: row.price_locked_at || null,
    ...projection,
    ...(reconciliation_error ? { reconciliation_error } : {}),
    accepted: row.accepted_at ? { at: row.accepted_at, service_mode: row.accepted_service_mode || null, frequency: row.accepted_frequency_key || null } : null,
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

const COLLECTED_DEPOSIT_STATUSES = new Set(['received', 'credited', 'refunding', 'refunded']);
const money = (value) => value == null || value === '' || !Number.isFinite(Number(value))
  ? null : Math.round(Number(value) * 100) / 100;

function depositEntry(deposit) {
  const collected = COLLECTED_DEPOSIT_STATUSES.has(deposit.status);
  const amount = money(deposit.amount);
  const surcharge = money(deposit.card_surcharge);
  // Stale captures can enter refunding/refunded without receipt stamping.
  // Their default zero surcharge is not evidence of the amount paid.
  const receiptRecorded = !!deposit.received_at;
  return {
    amount, card_surcharge: receiptRecorded ? surcharge : null, collected,
    total_paid: collected && receiptRecorded && amount !== null && surcharge !== null
      ? money(amount + surcharge) : null,
    credited: money(deposit.credited_amount), refunded: money(deposit.refunded_amount),
    refunded_surcharge: money(deposit.refunded_surcharge),
    status: deposit.status, received_at: deposit.received_at,
  };
}

async function getEstimateDetail({ estimate_id, customer_id, limit } = {}) {
  if (!estimate_id && !customer_id) return { error: 'Provide estimate_id or customer_id' };
  // The public composer and reconciler need the whole persisted row.
  let query = db('estimates').select('*').orderBy('created_at', 'desc');
  if (estimate_id) query = query.where('id', estimate_id).limit(1);
  else {
    const count = Math.max(1, Math.min(Math.trunc(Number(limit)) || DEFAULT_PER_CUSTOMER, MAX_PER_CUSTOMER));
    query = query.where('customer_id', customer_id).whereNull('archived_at').limit(count);
  }
  const rows = await query;
  if (!rows.length) return { count: 0, estimates: [], error: estimate_id
    ? 'No estimate matches that id' : 'No estimates on file for that customer' };
  const estimates = [];
  for (const row of rows) estimates.push(await shapeEstimate(row));
  const readable = estimates.filter((estimate) => estimate.withheld !== 'provenance_blocked');
  if (readable.length) {
    try {
      const deposits = await db('estimate_deposits')
        .whereIn('estimate_id', readable.map((estimate) => estimate.id))
        .select('estimate_id', 'amount', 'card_surcharge', 'credited_amount', 'refunded_amount', 'refunded_surcharge', 'status', 'received_at')
        .orderBy('created_at', 'desc');
      for (const estimate of readable) estimate.deposits = deposits
        .filter((deposit) => deposit.estimate_id === estimate.id).map(depositEntry);
    } catch {
      for (const estimate of readable) {
        estimate.deposits = null;
        estimate.deposits_unavailable = 'deposit records could not be read';
      }
    }
  }
  return { count: estimates.length, estimates };
}

const GET_ESTIMATE_DETAIL_TOOL = {
  name: 'get_estimate_detail',
  description: `Read estimates as the customer's own estimate page prices them: estimate_id returns exactly one, even when customer_id is also given; customer_id alone returns the latest nonarchived estimates (default 3, max 10). Returns status, timestamps, customer or staff preview link state, and the composed page under \`page\`. \`page.pricing\` includes plan cadences, per-application prices, selectable additions, and one-time breakdowns; an authored commercial quote is in \`page.proposal\`. Quote-required pricing is withheld with a reason; low-confidence cadences are marked ranged without exact figures. Residential combined plan totals are withheld while itemized application prices remain; commercial and monthly-billed totals remain where displayed. A verified \`page.propertyGroup\` lists sibling id, address, status and links only; use its id to read that sibling's pricing separately. Deposits report captured face amount plus card surcharge as total_paid, credited/refunded amounts, status and received_at; pending, failed and unknown statuses have total_paid null. A failed deposit read yields deposits:null and deposits_unavailable, never an empty ledger. A failed live membership verification sets \`page\` to null with page_unavailable. Provenance blocks withhold the entire record, including deposits. Accepted service mode/frequency and price_locked_at identify the accepted basis, but stored aggregate totals do not establish the final invoice amount. Use staff_preview_link for staff inspection so it does not register customer engagement; customer_link is the shareable customer URL. Never reconstruct hidden totals or infer final invoice amounts.`,
  input_schema: {
    type: 'object',
    properties: {
      estimate_id: { type: 'string', format: 'uuid', description: 'Estimate UUID — returns exactly that estimate' },
      customer_id: { type: 'string', format: 'uuid', description: 'Customer UUID — return recent nonarchived estimates when no estimate_id is given' },
      limit: { type: 'number', description: 'With customer_id: how many recent estimates to return (default 3, max 10)' },
    },
  },
};

module.exports = { GET_ESTIMATE_DETAIL_TOOL, getEstimateDetail, shapeEstimate };
