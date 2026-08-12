/**
 * Voice-relay Phase D — money surfaces: get_open_estimates and
 * get_invoice_history. READ-ONLY, gated (VOICE_RELAY_CONTEXT_ENABLED, checked
 * in relay-tools before either body runs). NOTHING here moves money, mints a
 * link, or emits a token.
 *
 * SENT-PRICE DOCTRINE (owner ruling): a sent estimate is quoted at the price
 * it was SENT at — and `buildPricingBundle` (routes/estimate-public.js) is what
 * IMPLEMENTS that ruling, so that is what this module calls. It is the same
 * function the customer's own /estimate/:token page renders from, and it
 * deliberately REJECTS the frozen sendSnapshot and re-derives in six cases
 * (lawn-policy floor, retired quarterly cadence, stale termite row, missing
 * setup fee, un-netted manual discount, totals mismatch). Reading
 * `sendSnapshot.pricingBundle` raw would therefore speak a price the customer's
 * own estimate page refuses to show — the one number they can check us against.
 * generateEstimate (the LIVE quote engine) is still never called here: a test
 * asserts it.
 *
 * PER-APPLICATION PRICE COPY (AGENTS.md, owner rule re-affirmed 2026-07-23):
 * customer-facing price units read "per application", never "per visit", and NO
 * combined plan total ("$X/mo" / "$X/yr") appears on any customer-facing
 * estimate surface — the phone is one of them. The row's persisted
 * monthly_total / annual_total are still read, but only to pick WHICH cadence
 * the estimate was sent at; they are never spoken. onetime_total is: one-time
 * work is a single real charge, the same carve-out EstimateProposalDocument
 * makes.
 *
 * TOKENS NEVER LEAVE THEIR CHANNEL (house rule): estimates.token and
 * invoices.token are permanent bearer credentials behind /estimate/:token,
 * /pay/:token and /receipt/:token. Neither is SELECTed here, so no pay link,
 * receipt link, or reservice token can ride a voice reply — the caller is
 * pointed at the portal or the office instead. Tests regex every output.
 *
 * INVOICES reuse the customer-facing loader: openBalanceInvoices /
 * openBalanceSummary (services/open-balance.js), the same self-pay,
 * payer-resolved, credit-netted set the portal's billing balance view shows
 * (routes/billing-v2.js GET /api/billing/balance), with invoiceAmountDue
 * (services/invoice-helpers.js) as the cents-authoritative amount owed.
 * Recently-PAID invoices are read with the same status/payer discipline so
 * "did my payment go through?" can be answered honestly.
 */

const INVOICE_HISTORY_LIMIT = 6;
const ESTIMATE_LIMIT = 5;

// The statuses that mean "sent and still open" — a draft was never presented,
// and accepted/declined/expired are closed. 'scheduled' is a queued send that
// has not gone out yet, so it is NOT quotable.
const OPEN_ESTIMATE_STATUSES = ['sent', 'viewed'];

function parseJson(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ── get_open_estimates ─────────────────────────────────────────────────────

/**
 * The quoted lines for ONE open estimate, from THE sent-price mechanism.
 *
 * ⚠️ WHAT THIS USED TO DO, AND WHY IT NEVER FIRED: it read
 * `sendSnapshot.pricingBundle.lineItems`. There is no `lineItems` key on a
 * pricing bundle. The real bundle is keyed on `frequencies` — which is exactly
 * what estimate-public.js's own snapshot fast-path gates on
 * (`Array.isArray(snapshotBundle.frequencies)`). So the quoted-lines output was
 * dead against real data, and the test fixture that "proved" it worked invented
 * the shape.
 *
 * ⚠️ AND WHY READING THE RAW SNAPSHOT WAS WRONG EVEN WITH THE RIGHT KEY: the
 * house ruling is that a sent estimate replays at the SENT price, and
 * `buildPricingBundle` is what IMPLEMENTS that ruling — including the six cases
 * where it deliberately REJECTS the frozen snapshot and re-derives (lawn-policy
 * floor, retired quarterly cadence, stale termite row, missing setup fee,
 * un-netted manual discount, totals mismatch). Reading the raw JSON therefore
 * speaks a price the customer's OWN `/estimate/:token` page refuses to show —
 * the one number the caller can check against.
 *
 * So this calls buildPricingBundle(estimateRow) and reads its `frequencies`.
 * That is not "re-pricing": it is asking the same function the customer's
 * estimate page asks what this estimate is worth right now, which is the only
 * definition of the sent price that both surfaces agree on.
 *
 * Still true: no engine numbers are invented here, no token is ever selected,
 * and a failure degrades to the row's persisted totals rather than guessing.
 */
async function quotedLines(estimateRow) {
  const { fmtMoney, promptSafeUntrusted } = require('./relay-context');
  const { buildPricingBundle } = require('../../routes/estimate-public');
  const bundle = await buildPricingBundle(estimateRow);
  const frequencies = (bundle && Array.isArray(bundle.frequencies)) ? bundle.frequencies : [];
  if (!frequencies.length) return [];

  // WHICH cadence was sent: the one whose totals match the estimate row's own
  // persisted monthly/annual — the same correspondence
  // pricingBundleMatchesEstimateTotals uses to decide a snapshot is still
  // honest. No match (a one-time-only estimate, say) ⇒ the first entry.
  // ⭐ EVERY POPULATED TOTAL, NOT EITHER ONE. The canonical predicate
  // (estimate-pricing-bundle-utils.pricingBundleMatchesEstimateTotals) requires
  // both populated totals to agree and DERIVES the annual from the monthly when
  // a frequency carries no explicit one. An OR joined here meant a cadence that
  // happened to share only ONE total with the estimate could win `find()` —
  // quoting another cadence's per-application price at the customer.
  const monthlyTotal = Number(estimateRow.monthly_total);
  const annualTotal = Number(estimateRow.annual_total);
  const moneyMatches = (a, b) => Number.isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) < 0.01;
  const matches = (f) => {
    const freqMonthly = Number(f && f.monthly);
    const explicitAnnual = Number(f && f.annual);
    const freqAnnual = explicitAnnual > 0
      ? explicitAnnual
      : (freqMonthly > 0 ? freqMonthly * 12 : null);
    const monthlyOk = (Number.isFinite(monthlyTotal) && monthlyTotal > 0) ? moneyMatches(freqMonthly, monthlyTotal) : true;
    const annualOk = (Number.isFinite(annualTotal) && annualTotal > 0) ? moneyMatches(freqAnnual, annualTotal) : true;
    // Neither total populated ⇒ nothing to match on: fail closed (no lines)
    // rather than let every frequency qualify and pick the first.
    if (!(monthlyTotal > 0) && !(annualTotal > 0)) return false;
    return monthlyOk && annualOk;
  };
  // ⭐ NO MATCH ⇒ NO LINES. The fallback used to be `|| frequencies[0]`, which
  // quotes A cadence rather than THE cadence: buildPricingBundle returns the
  // whole ladder, and when it rejects a mismatched snapshot and re-derives, the
  // first entry can easily be terms this estimate was never sent with — a
  // quarterly customer told a monthly price, on the one number they can check
  // us against. A one-time-only estimate lands here too, and its real charge is
  // the onetime total the caller prints separately. Failing closed costs a
  // "the office can go over it" line; guessing costs a wrong price.
  const chosen = frequencies.find(matches);
  if (!chosen) return [];
  // The frequency-level flag the customer's own estimate card reads
  // (client/src/components/estimate/PriceCard.jsx `showBilledMonthlyNote`): a
  // FLAGGED per-application row bills exactly its per-application headline and
  // gets no monthly line at all; a legacy monthly-billed row (mosquito seasonal
  // spreads, pre-flag termite monitoring) genuinely charges a flat monthly, and
  // that surface states it as a note UNDER the per-application price.
  const billedPerApplication = chosen.billedPerApplication === true;

  const lines = (Array.isArray(chosen.perServiceTreatments) ? chosen.perServiceTreatments : [])
    .slice(0, 6)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = promptSafeUntrusted(item.label || item.service, 60);
      if (!label) return null;
      const monthly = fmtMoney(item.monthly);
      // Owner rule: recurring pricing is "per application", never "per visit" —
      // and the per-application price LEADS, exactly as the customer's estimate
      // card does. Leading with (or standing on) a monthly figure presents the
      // service as a flat monthly spread, which AGENTS.md forbids.
      //
      // ⭐ AND IT IS `displayPrice`, NOT `perTreatment`. On a row that receives
      // a tier discount (recurringServiceReceivesTierDiscount — WaveGuard and
      // friends), `perTreatment` is the LIST per-application price and
      // `displayPrice` is the net one the bundle computes from the discounted
      // annual. PriceCard.jsx renders `row.displayPrice ?? row.perTreatment`
      // and prints it as "/ application", and the monthly-total math on the
      // same page reads displayPrice too — so quoting perTreatment made the
      // phone say a HIGHER number than the customer's own estimate page for
      // exactly the discounted customers who are most likely to check.
      const perApp = fmtMoney(item.displayPrice ?? item.perTreatment);
      const bits = [];
      if (perApp) {
        bits.push(`${perApp} per application`);
        if (monthly && !billedPerApplication) bits.push(`billed ${monthly} per month`);
      } else if (monthly) {
        // No per-application price on the row at all ⇒ a genuinely
        // monthly-billed line; the monthly IS its unit.
        bits.push(`${monthly} per month`);
      }
      return bits.length ? `${label} at ${bits.join(', ')}` : label;
    })
    .filter(Boolean);
  return lines;
}

/**
 * Open (sent/viewed) estimates for an account.
 *   - full tier (ANI-matched): line items + the sent prices + totals
 *   - redacted tier (looked-up ref): existence + date only, NO amounts
 */
async function openEstimatesText(customerId, { tier = 'redacted' } = {}) {
  const redacted = tier !== 'full';
  const db = require('../../models/db');
  const { fmtMoney, speakDate, promptSafe } = require('./relay-context');
  const rows = await db('estimates')
    .where({ customer_id: customerId })
    .whereIn('status', OPEN_ESTIMATE_STATUSES)
    .orderBy('created_at', 'desc')
    // ⭐ OVERFETCH, BECAUSE THE FILTER RUNS AFTER THE LIMIT. Viewability
    // (archived / expired / linkage-invalidated) is a predicate this query
    // cannot express, so limiting to five FIRST let five newer hidden rows mask
    // an older valid estimate and make the agent say there are none open —
    // worse than saying nothing, because it is a confident wrong answer. Read a
    // wider page and cut to ESTIMATE_LIMIT after filtering.
    .limit(ESTIMATE_LIMIT * 5)
    // NOTE the absence of `token`: the estimate view link is a bearer
    // credential and never rides a voice reply.
    //
    // ⭐ THE PROJECTION IS PART OF THE SENT-PRICE CONTRACT. quotedLines hands
    // this row to buildPricingBundle — the same function the customer's own
    // /estimate/:token page asks — and that function reads more than the
    // totals: `customer_id` / `customer_phone` are how
    // estimateRendersMonthlyBilling identifies a legacy monthly member
    // (estimate-public.js estimateCustomerPreservesMonthlyBilling returns
    // false outright when BOTH are absent, so a thin projection silently
    // classified every estimate as per-application and suppressed the
    // truthful "billed $X per month" line), and `show_one_time_option` /
    // `waveguard_tier` shape the bundle itself. Selecting them is what keeps
    // the phone and the estimate page quoting the same estimate.
    // `archived_at` rides along for the viewability predicate below.
    .select('id', 'status', 'service_type', 'created_at', 'sent_at', 'expires_at', 'archived_at',
      'monthly_total', 'annual_total', 'onetime_total', 'estimate_data',
      'customer_id', 'customer_phone', 'show_one_time_option', 'waveguard_tier');
  // ⭐ STATUS IS NOT THE SAME QUESTION AS "CAN THE CUSTOMER SEE THIS?".
  // `sent`/`viewed` is a status the expiry sweep has to come along and change;
  // until it does — or if it fails — the row still reads as open while
  // /estimate/:token already refuses it. Quoting from it would put a price on
  // the call that the customer's own estimate page will not show, which is the
  // exact failure the sent-price contract exists to prevent. Same predicate
  // that page uses (estimate-public.isEstimateCustomerViewable): archived,
  // linkage-invalidated and past-expiry rows all drop out here too.
  const { isEstimateCustomerViewable } = require('../../routes/estimate-public');
  const viewable = rows.filter((row) => isEstimateCustomerViewable(row)).slice(0, ESTIMATE_LIMIT);
  if (!viewable.length) {
    return 'No open estimates on this account. Do not guess at a quote — get_pricing gives standard plan '
      + 'pricing, and a team member can put a written estimate together.';
  }

  if (redacted) {
    const lines = viewable.map((row) => {
      const when = speakDate(row.sent_at || row.created_at);
      return `an estimate sent ${when || 'recently'}`;
    });
    return `There ${viewable.length === 1 ? 'is' : 'are'} ${viewable.length} open estimate${viewable.length === 1 ? '' : 's'} `
      + `on that account (${lines.join('; ')}). Do NOT state any amounts — the account holder can see the `
      + 'estimate in their portal, or the office can go over it with them directly.';
  }

  const rendered = await Promise.all(viewable.map(async (row) => {
    const when = speakDate(row.sent_at || row.created_at);
    const expires = speakDate(row.expires_at);
    const bits = [];
    const service = promptSafe(row.service_type, 60);
    bits.push(`Estimate sent ${when || 'recently'}${service ? ` for ${service}` : ''}`);
    // THE sent-price mechanism. The per-application lines ARE the price — there
    // is no combined-total fallback behind them (see below), so a bundle
    // failure degrades to "don't state a price", never to a guessed or
    // engine-invented number.
    let lines = [];
    try {
      lines = await quotedLines(row);
    } catch (err) {
      require('../logger').warn(`[voice-relay-money] pricing bundle unavailable for estimate ${row.id}: ${err.message}`);
    }
    if (lines.length) {
      bits.push(`quoted lines: ${lines.join('; ')}`);
    } else {
      bits.push('the per-application lines could not be read back, so do NOT state a price for this one — '
        + 'the account holder can see it in their portal, or a team member can go over it');
    }
    // ⭐ NO COMBINED PLAN TOTALS. AGENTS.md ("Per application" price copy,
    // owner rule re-affirmed 2026-07-23): customer-facing price units read
    // "per application" and no combined "$X/mo" / "$X/yr" plan total appears on
    // ANY customer-facing estimate surface — the phone is one. The estimate
    // surfaces enforce it themselves (EstimateViewPage.jsx's plan-total card
    // returns null on a creditless plan; PriceCard.jsx's cadence line is a
    // COUNT with "no combined annual dollar total"; EstimateProposalDocument
    // .jsx's `suppressPlanTotals`; public-ranges.js's header rule "no combined
    // per-month or per-year program totals"), and this used to speak both of
    // them out loud. One-time work is a single real charge and still prints —
    // the same carve-out EstimateProposalDocument makes.
    const oneTime = fmtMoney(row.onetime_total);
    if (oneTime) bits.push(`one-time work totalling ${oneTime}`);
    if (expires) bits.push(`good through ${expires}`);
    return bits.join('; ');
  }));

  return `Open estimates on this account: ${rendered.join(' || ')}. `
    + 'These are the prices the estimate was SENT at — quote them exactly as written, never re-price, '
    + 'discount, or update them. Recurring prices are PER APPLICATION: say them in exactly that unit, and '
    + 'never add them up into a combined monthly or yearly plan total. Do not read out a link; the estimate '
    + 'is in their portal, or a team member can resend it.';
}

// ── get_invoice_history ────────────────────────────────────────────────────

/**
 * Itemized invoices for the ANI-matched caller ONLY (enforced in
 * relay-tools): numbers, dates, amounts, paid/unpaid, and the open-balance
 * total. Reuses open-balance.js for the open set — the same loader the
 * portal's billing balance view uses.
 */
async function invoiceHistoryText(customerId, { tier = 'redacted' } = {}) {
  // Itemized billing detail is FULL-TIER ONLY, and the tier defaults to
  // redacted so an exported helper cannot fail open. relay-tools already
  // refuses the looked-up case; this is the in-body backstop that also covers
  // a caller recognised on a secondary contact slot (spouse/tenant/prior
  // occupant), whose voice authenticates nothing.
  if (tier !== 'full') {
    return 'Invoice detail is only available for the account whose own phone number the caller is '
      + 'calling from. Do NOT state any invoice numbers, dates, or amounts. Tell the caller the account '
      + 'holder can see their billing in the Waves portal, or a team member can go over it with them.';
  }
  const db = require('../../models/db');
  const { fmtMoney, speakDate, promptSafe } = require('./relay-context');
  const { openBalanceSummary } = require('../open-balance');
  const { invoiceAmountDue } = require('../invoice-helpers');

  const summary = await openBalanceSummary(customerId, { displayLimit: INVOICE_HISTORY_LIMIT })
    .catch(() => null);

  // Recently settled invoices, the SAME self-pay discipline as the open set —
  // and that discipline is not the SQL nulls alone. open-balance.js records the
  // pre-push P0: a payer assigned AFTER the invoice row was written (per-visit,
  // or the customer's default payer) leaves the row payer-null, so payer-null
  // SQL plus a LIVE per-row re-resolution is the invariant, failing toward DROP.
  // A payer-billed invoice is the third party's debt and must never be read out
  // to the homeowner. No token column is selected, so no receipt or pay link can
  // leak either.
  const candidatePaidRows = await db('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', ['paid', 'processing', 'prepaid'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .orderBy('created_at', 'desc')
    .limit(INVOICE_HISTORY_LIMIT)
    .select('invoice_number', 'status', 'service_type', 'service_date', 'created_at', 'total',
      'scheduled_service_id');
  const PayerService = require('../payer');
  const paidRows = [];
  for (const row of candidatePaidRows) {
    try {
      const resolved = await PayerService.resolveForInvoice({
        customerId: String(customerId),
        ...(row.scheduled_service_id ? { scheduledServiceId: String(row.scheduled_service_id) } : {}),
        throwOnError: true,
      });
      if (resolved && resolved.payerId) continue; // somebody else's bill
    } catch (err) {
      require('../logger').warn(`[voice-relay-money] payer resolve failed for invoice ${row.invoice_number} — dropping from the spoken history (fail closed): ${err.message}`);
      continue;
    }
    paidRows.push(row);
  }

  const parts = [];
  const openRows = (summary && Array.isArray(summary.invoices) ? summary.invoices : []);
  if (openRows.length) {
    const lines = openRows.map((inv) => {
      const number = promptSafe(inv.invoice_number, 30);
      const due = fmtMoney(invoiceAmountDue(inv));
      const when = speakDate(inv.service_date || inv.created_at);
      const service = promptSafe(inv.service_type, 40);
      return `${number ? `Invoice ${number}` : 'An invoice'}${when ? ` from ${when}` : ''}`
        + `${service ? ` for ${service}` : ''}${due ? `, ${due} still owed` : ''}`;
    });
    parts.push(`UNPAID: ${lines.join(' | ')}.`);
    const total = fmtMoney(summary.total);
    if (total) {
      parts.push(`Total open balance: ${total} across ${summary.count} invoice${summary.count === 1 ? '' : 's'}.`);
    }
    if (summary.moreCount > 0) parts.push(`(${summary.moreCount} older open invoice${summary.moreCount === 1 ? '' : 's'} not listed.)`);
  } else if (summary) {
    parts.push('UNPAID: none — the account is paid up.');
  } else {
    parts.push('The open balance could not be checked right now — do not guess at what is owed.');
  }

  if (paidRows.length) {
    const lines = paidRows.map((inv) => {
      const number = promptSafe(inv.invoice_number, 30);
      const amount = fmtMoney(inv.total);
      const when = speakDate(inv.service_date || inv.created_at);
      const state = String(inv.status) === 'processing' ? 'payment processing' : 'paid';
      return `${number ? `Invoice ${number}` : 'An invoice'}${when ? ` from ${when}` : ''}`
        + `${amount ? `, ${amount}` : ''} — ${state}`;
    });
    parts.push(`RECENTLY SETTLED: ${lines.join(' | ')}.`);
  }

  parts.push('You may state these amounts to the matched caller about their own account. Never read out a '
    + 'payment link, receipt link, or any code — they can pay in the Waves customer portal, or a team member '
    + 'can help them directly. Never take a card number over this call.');
  return parts.join(' ');
}

module.exports = {
  openEstimatesText,
  invoiceHistoryText,
  quotedLines,
  OPEN_ESTIMATE_STATUSES,
  INVOICE_HISTORY_LIMIT,
  ESTIMATE_LIMIT,
};
