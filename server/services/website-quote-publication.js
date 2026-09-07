const { randomBytes } = require('crypto');
const { isDeepStrictEqual } = require('util');
const db = require('../models/db');
const { CUSTOMER_STAGES, FORMER_CUSTOMER_STAGES } = require('./customer-stages');
const { isMembershipCustomerRow } = require('./waveguard-existing-services');
const { lineRequiresReview, lineHasHeuristicTurf } = require('./estimator-engine/draft-builder');
const { estimateExpiresAt } = require('./admin-estimate-persistence');
const { moneyCents } = require('./estimate-pricing-bundle-utils');
const { recordAuditEvent } = require('./audit-log');

// Called only with THIS /calculate run's server result, after its existing
// self-bookability checks. The website may request publication; it never
// supplies an estimate token, a publication verdict, or trusted dollar values.
async function publishWebsiteQuote({ estimateId, leadId, engineInput, engineResult, totals }) {
  const lines = engineResult?.lineItems;
  if (!Array.isArray(lines) || !lines.length || lines.some(line => (
    lineRequiresReview(line) || lineHasHeuristicTurf(line)
    || String(line.pricingConfidence || '').toLowerCase() === 'low'
  ))) return null;

  return db.transaction(async (trx) => {
    // Same lock order as acceptance: estimate, then customer. A staff edit,
    // another calculation, or a concurrent acceptance cannot cross this mint.
    const row = await trx('estimates')
      .where({ id: estimateId, source: 'quote_wizard', status: 'draft', pricing_authority: 'SERVER' })
      .whereNull('archived_at').whereNull('price_locked_at').forUpdate().first();
    if (!row) return null;
    const stored = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data;
    const fee = stored.setupFeeQuote || {};
    if (stored.lead_id !== leadId || fee.unverified
      || !isDeepStrictEqual(stored.engineInput, JSON.parse(JSON.stringify(engineInput)))) return null;
    if (['monthly_total', 'annual_total', 'onetime_total'].some(key => (
      moneyCents(row[key]) !== moneyCents(totals[key])
    ))) return null;

    const customer = await trx('customers').where({ id: row.customer_id, active: true })
      .whereNull('deleted_at').whereNotIn('pipeline_stage', [...CUSTOMER_STAGES, ...FORMER_CUSTOMER_STAGES])
      .forUpdate().first();
    if (!customer || isMembershipCustomerRow(customer)) return null;

    const token = row.token || randomBytes(16).toString('hex');
    const publishable = { ...row, token };
    const delivery = require('../routes/admin-estimates');
    // Reuse the send boundary, including quote-required, linkage, approval,
    // and engine-authority guards. No staff acknowledgement is fabricated.
    delivery._internals.assertAutoSendPricingAuthority(publishable);
    delivery._internals.assertEstimateSendable(publishable);
    const now = new Date();
    const snapshot = await delivery.buildEstimateSendSnapshot(publishable, () => now, { delivered: false });
    const bundle = snapshot.sendSnapshot.pricingBundle;
    if (!bundle || snapshot.sendSnapshot.pricingBundleError || bundle.quoteRequired) return null;
    const recurring = Number(row.annual_total) > 0;
    const matchingFrequency = bundle.frequencies.find(frequency => (
      moneyCents(frequency.annual) === moneyCents(row.annual_total)
      && moneyCents(frequency.monthly) === moneyCents(row.monthly_total)
    ));
    if (recurring ? !matchingFrequency : moneyCents(bundle.anchorOneTimePrice) !== moneyCents(row.onetime_total)) return null;
    if (fee.kind === 'waveguard_membership'
      && moneyCents(bundle.setupFee ? bundle.setupFee.amount : 0) !== moneyCents(fee.amount)) return null;

    snapshot.websiteSelfService = { publishedAt: now.toISOString() };
    await trx('estimates').where({ id: row.id, status: 'draft' }).update({
      token,
      status: 'sent',
      sent_at: now,
      expires_at: estimateExpiresAt(() => now),
      estimate_data: JSON.stringify(snapshot),
      updated_at: now,
    });
    await recordAuditEvent({
      actor_type: 'system', action: 'website_quote_published',
      resource_type: 'estimate', resource_id: row.id,
      metadata: { leadId }, critical: true, trx,
    });
    return { token };
  });
}

module.exports = { publishWebsiteQuote };
