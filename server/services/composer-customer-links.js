/**
 * Per-customer link builders for the SMS composer's Insert Link sheet —
 * the four link kinds beyond the existing reschedule/re-service pair:
 * review request, pay balance, latest estimate, referral.
 *
 * Contract mirrors reschedule-link/reservice-link: each builder returns
 * { url, line, ...context } with url null + a `reason` sentence when there
 * is nothing to insert (the route turns that into a 404 {error}). The line
 * is a self-contained plain-ASCII SMS clause ending in '\n\n'.
 *
 * These reuse the owning systems rather than minting parallel credentials:
 *   review   — ReviewService.createInline (the dispatch completion-SMS
 *              pattern): mints a real review_requests row WITHOUT sending.
 *              The row's built-in +120min safety-net send stays armed until
 *              the composer send marks it delivered (POST /sms) or the
 *              operator's removal cancels it (customer-link/cancel).
 *   pay      — open-balance.js selection (self-pay only, live payer
 *              re-resolution) + the oldest open invoice's /pay/:token link,
 *              short-wrapped with the repo-wide invoice idiom. Totals a
 *              resolve failure made incomplete suppress the amount, never
 *              understate it.
 *   estimate — the customer's newest OPEN estimate (sending/sent/viewed ∩
 *              isEstimateCustomerViewable), short-wrapped kind 'estimate'.
 *   referral — referral-engine.enrollPromoter: idempotent, self-healing,
 *              guarantees a personal /r/CODE link. No short code (referral
 *              links go out raw everywhere).
 */

const db = require('../models/db');
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');

// Estimate statuses that count as "open" for a composer insert: delivered or
// mid-delivery, not yet resolved. Draft/scheduled are unpublished (must never
// be linked), accepted/declined/expired/void are settled, quote_required
// needs a human quote first.
const OPEN_ESTIMATE_STATUSES = ['sending', 'sent', 'viewed'];

async function buildReviewRequestLink(customerId) {
  const ReviewService = require('./review-request');
  const customer = await db('customers').where({ id: customerId }).first('id', 'has_left_google_review');
  if (customer?.has_left_google_review) {
    return { url: null, line: '', reason: 'This customer is already marked as having left a review' };
  }
  const inline = await ReviewService.createInline({ customerId });
  if (!inline?.url) {
    return { url: null, line: '', reason: 'No review link for this customer — review texts may be turned off in their notification preferences' };
  }
  return {
    url: inline.url,
    line: `Would you share how we did? It takes 30 seconds: ${inline.url}\n\n`,
    requestId: inline.requestId,
  };
}

async function buildPayBalanceLink(customerIds) {
  const { openBalanceSummary } = require('./open-balance');

  // Oldest open self-pay invoice across the account is the anchor — the pay
  // page itself (GATE_PAY_INCLUDE_BALANCE) offers the rest of the balance.
  // openBalanceInvoices deliberately never selects tokens, so the anchor's
  // token comes from its own scoped query.
  let anchor = null;
  let total = 0;
  let count = 0;
  let incomplete = false;
  for (const id of customerIds) {
    const summary = await openBalanceSummary(id, {
      onResolveFailure: () => { incomplete = true; },
      onTruncation: () => { incomplete = true; },
    });
    total += summary.total;
    count += summary.count;
    const first = summary.invoices[0];
    if (first) {
      const firstDue = new Date(first.due_date || first.created_at || 0).getTime();
      const anchorDue = anchor ? new Date(anchor.due_date || anchor.created_at || 0).getTime() : Infinity;
      if (firstDue < anchorDue) anchor = first;
    }
  }
  if (!anchor || !(total > 0)) {
    return { url: null, line: '', reason: 'No open balance on this account' };
  }

  const invoice = await db('invoices').where({ id: anchor.id }).first('id', 'token', 'customer_id');
  if (!invoice?.token) {
    return { url: null, line: '', reason: 'No open balance on this account' };
  }
  const url = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
    kind: 'invoice',
    entityType: 'invoices',
    entityId: invoice.id,
    customerId: invoice.customer_id,
    channel: 'sms',
    purpose: 'composer_insert',
    codePrefix: invoiceShortCodePrefix(invoice),
  });
  return {
    url,
    line: `You can view and pay your balance securely here: ${url}\n\n`,
    // An incomplete read (payer resolve failure / truncation) may understate
    // the total — say nothing about the amount rather than assert a wrong
    // figure (the open-balance SMS-line rule).
    balance: incomplete ? null : { total: Math.round(total * 100) / 100, count },
  };
}

async function buildLatestEstimateLink(customerIds) {
  const { isEstimateCustomerViewable } = require('../routes/estimate-public');
  const rows = await db('estimates')
    .whereIn('customer_id', customerIds)
    .whereIn('status', OPEN_ESTIMATE_STATUSES)
    .whereNull('archived_at')
    .orderByRaw('COALESCE(last_viewed_at, viewed_at, sent_at, updated_at, created_at) DESC')
    .limit(15);
  const estimate = rows.find((row) => isEstimateCustomerViewable(row));
  if (!estimate?.token) {
    return { url: null, line: '', reason: 'No open estimate on this account' };
  }
  const url = await shortenOrPassthrough(`${publicPortalUrl()}/estimate/${estimate.token}`, {
    kind: 'estimate',
    entityType: 'estimates',
    entityId: estimate.id,
    customerId: estimate.customer_id,
    channel: 'sms',
    purpose: 'composer_insert',
  });
  return {
    url,
    line: `You can view your estimate here: ${url}\n\n`,
    estimate: { id: estimate.id, serviceType: estimate.service_type || null, status: estimate.status },
  };
}

async function buildReferralLink(customerId) {
  const { enrollPromoter } = require('./referral-engine');
  let promoter;
  try {
    ({ promoter } = await enrollPromoter(customerId));
  } catch (err) {
    // enrollPromoter is strictly per-customer while referral_promoters.
    // customer_phone stays unique, so a multi-property sibling whose phone
    // already backs another sibling's promoter loses the insert (23505).
    // Same household fallback as the report referral endpoint
    // (reports-public.js): resolve the promoter read-only, scoped to the
    // SAME account_id — phone alone is not identity (recycled/shared
    // numbers cross unrelated customers). No account-scoped match = a
    // genuine cross-account collision → the plain reason, never a guessed
    // attribution. Log err.code only, never err.message — PG constraint
    // violations quote the conflicting value, which here is a phone number
    // (AGENTS.md PII-in-logs rule).
    if (err?.code === '23505') {
      const profile = await db('customers')
        .where({ id: customerId })
        .first('id', 'phone', 'account_id');
      promoter = profile?.phone && profile?.account_id
        ? await db('referral_promoters as rp')
          .join('customers as c', 'rp.customer_id', 'c.id')
          .where('rp.customer_phone', profile.phone)
          .where('c.account_id', profile.account_id)
          .first('rp.*')
        : null;
    }
    if (!promoter) {
      logger.warn(`[composer-links] referral enroll failed (customerId=${customerId}, code=${err?.code || 'none'})`);
      return { url: null, line: '', reason: 'Could not build a referral link for this customer' };
    }
  }
  if (!promoter?.referral_link) {
    return { url: null, line: '', reason: 'Could not build a referral link for this customer' };
  }
  return {
    url: promoter.referral_link,
    line: `Know someone who needs pest control? Share Waves here: ${promoter.referral_link}\n\n`,
  };
}

module.exports = {
  OPEN_ESTIMATE_STATUSES,
  buildReviewRequestLink,
  buildPayBalanceLink,
  buildLatestEstimateLink,
  buildReferralLink,
};
