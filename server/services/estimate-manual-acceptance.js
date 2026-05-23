const db = require('../models/db');
const logger = require('./logger');
const EstimateConverter = require('./estimate-converter');
const AccountMembershipEmail = require('./account-membership-email');
const { markLinkedLeadEstimateAccepted } = require('./lead-estimate-link');
const {
  estimateDataHasUnresolvedManagerApproval,
} = require('./estimate-delivery-options');

const MANUAL_ACCEPTABLE_STATUSES = new Set(['sent', 'viewed']);

function asMoneyOrNull(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function logManualAcceptance(database, {
  estimate,
  updatedEstimate,
  adminUserId,
  source,
}) {
  try {
    await database('activity_log').insert({
      admin_user_id: adminUserId || null,
      customer_id: updatedEstimate.customer_id || null,
      estimate_id: updatedEstimate.id,
      action: 'estimate_manual_accept',
      description: `Estimate manually marked accepted (${source || 'verbal_yes'}).`,
      metadata: JSON.stringify({
        source: source || 'verbal_yes',
        previousStatus: estimate.status,
        previousAcceptedAt: estimate.accepted_at || null,
      }),
    });
  } catch (err) {
    logger.warn(`[estimate-manual-acceptance] activity_log insert failed for estimate ${updatedEstimate.id}: ${err.message}`);
  }
}

async function markEstimateManuallyAccepted({
  estimateId,
  adminUserId,
  source = 'verbal_yes',
  database = db,
  leadLinkService = { markLinkedLeadEstimateAccepted },
  estimateConverter = EstimateConverter,
} = {}) {
  if (!estimateId) throw httpError('estimateId is required', 400);

  const claim = await database.transaction(async (trx) => {
    const estimate = await trx('estimates').where({ id: estimateId }).first();
    if (!estimate) throw httpError('Estimate not found', 404);

    if (estimate.status === 'accepted') {
      return { acceptedEstimate: estimate, alreadyAccepted: true, shouldRunDownstream: false, previousEstimate: estimate };
    }

    if (!MANUAL_ACCEPTABLE_STATUSES.has(estimate.status)) {
      throw httpError(
        `Only sent or viewed estimates can be manually marked accepted. Current status: ${estimate.status}.`,
        400,
      );
    }

    if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) {
      throw httpError('Estimate is no longer active.', 409);
    }

    if (estimateDataHasUnresolvedManagerApproval(estimate.estimate_data || estimate.estimateData)) {
      throw httpError('Manager approval is required before this estimate can be manually accepted.', 400);
    }

    if (estimate.bill_by_invoice) {
      throw httpError(
        'Invoice-mode estimates must be accepted through the customer link so the due-immediately invoice is created correctly.',
        400,
      );
    }

    if (!estimate.customer_id) {
      throw httpError(
        'Manual acceptance requires the estimate to be linked to a customer first.',
        400,
      );
    }

    if (estimate.show_one_time_option) {
      throw httpError(
        'Estimates with a one-time option must be accepted through the customer link so recurring vs one-time is recorded.',
        400,
      );
    }

    const now = trx.fn.now();
    const updates = {
      status: 'accepted',
      accepted_at: estimate.accepted_at || now,
      declined_at: null,
      decline_reason: null,
      updated_at: now,
    };
    if (!estimate.sent_at) updates.sent_at = now;

    const [updatedEstimate] = await trx('estimates')
      .where({ id: estimateId })
      .whereIn('status', Array.from(MANUAL_ACCEPTABLE_STATUSES))
      .whereRaw('(expires_at IS NULL OR expires_at >= NOW())')
      .update(updates)
      .returning('*');

    if (!updatedEstimate) {
      const latest = await trx('estimates').where({ id: estimateId }).first();
      if (latest?.status === 'accepted') {
        return { acceptedEstimate: latest, alreadyAccepted: true, shouldRunDownstream: false, previousEstimate: latest };
      }
      throw httpError('Estimate is no longer active.', 409);
    }

    await logManualAcceptance(trx, {
      estimate,
      updatedEstimate,
      adminUserId,
      source,
    });

    let conversion = null;
    if (asMoneyOrNull(updatedEstimate.monthly_total)) {
      try {
        // Mark Won skips both side effects the converter would normally do
        // on a customer-facing accept: no auto-scheduled visit and no
        // draft setup-fee invoice. Adam wants to control scheduling on
        // the calendar and invoice manually when the verbal yes converts
        // to a real start. Customer flips to active_customer + tier +
        // monthly_rate still land — those are pure data updates.
        conversion = await estimateConverter.convertEstimate(updatedEstimate.id, {
          database: trx,
          skipAutoSchedule: true,
          skipSetupInvoice: true,
          skipMembershipEmail: true,
        });
      } catch (err) {
        logger.warn(`[estimate-manual-acceptance] EstimateConverter failed for estimate ${updatedEstimate.id}: ${err.message}`);
        throw httpError('Customer conversion did not complete; estimate was not marked accepted.', 500);
      }
    }

    return {
      acceptedEstimate: updatedEstimate,
      alreadyAccepted: false,
      shouldRunDownstream: true,
      previousEstimate: estimate,
      conversion,
    };
  });

  const {
    acceptedEstimate,
    alreadyAccepted,
    shouldRunDownstream,
    conversion,
  } = claim;

  const warnings = [];

  if (shouldRunDownstream) {
    try {
      await leadLinkService.markLinkedLeadEstimateAccepted({
        estimateId: acceptedEstimate.id,
        customerId: acceptedEstimate.customer_id || null,
        monthlyValue: asMoneyOrNull(acceptedEstimate.monthly_total),
        initialServiceValue: asMoneyOrNull(acceptedEstimate.onetime_total),
        waveguardTier: acceptedEstimate.waveguard_tier || null,
      });
    } catch (err) {
      logger.warn(`[estimate-manual-acceptance] linked lead conversion failed for estimate ${acceptedEstimate.id}: ${err.message}`);
      warnings.push('Linked lead was not marked won automatically.');
    }

    if (conversion?.membershipEmail) {
      void AccountMembershipEmail.sendMembershipStarted(conversion.membershipEmail)
        .catch((err) => logger.warn(`[estimate-manual-acceptance] membership.started email failed for estimate ${acceptedEstimate.id}: ${err.message}`));
    }
  }

  return {
    estimate: acceptedEstimate,
    alreadyAccepted,
    conversion,
    warnings,
  };
}

module.exports = {
  MANUAL_ACCEPTABLE_STATUSES,
  markEstimateManuallyAccepted,
};
