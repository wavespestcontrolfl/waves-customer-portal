const db = require('../models/db');
const logger = require('./logger');
const EstimateConverter = require('./estimate-converter');
const AccountMembershipEmail = require('./account-membership-email');
const { markLinkedLeadEstimateAccepted } = require('./lead-estimate-link');
const { normalizeProposal } = require('./estimate-proposal');
const proposalWin = require('./proposal-win');
const {
  estimateDataHasUnresolvedManagerApproval,
} = require('./estimate-delivery-options');

const MANUAL_ACCEPTABLE_STATUSES = new Set(['sent', 'viewed']);

function asMoneyOrNull(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeManualBillingTerm(value) {
  return value === 'prepay_annual' ? 'prepay_annual' : 'standard';
}

function resolveAnnualPrepayAmount(estimate = {}) {
  const annual = asMoneyOrNull(estimate.annual_total);
  if (annual) return Math.round(annual * 100) / 100;
  const monthly = asMoneyOrNull(estimate.monthly_total);
  return monthly ? Math.round(monthly * 12 * 100) / 100 : null;
}

function parseEstimateData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
}

function hasManualAnnualPrepayRecurringRows(estimate = {}) {
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  const explicitRecurringLists = [
    data.recurring?.services,
    data.result?.recurring?.services,
    data.result?.results?.recurring?.services,
  ];
  if (explicitRecurringLists.some((list) => Array.isArray(list) && list.length > 0)) {
    return true;
  }
  return Array.isArray(data.services)
    && data.services.some((svc) => svc?.recurring || svc?.frequency);
}

function isManualAnnualPrepayEligibleServiceMix(estimate = {}) {
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  const {
    acceptanceServiceLists,
    isAnnualPrepayEligibleServiceMix,
  } = require('../routes/estimate-public');
  const { recurringSvcList, oneTimeList } = acceptanceServiceLists(data);
  return isAnnualPrepayEligibleServiceMix(recurringSvcList, oneTimeList);
}

function isCommercialProposalEstimate(estimate = {}) {
  return parseEstimateData(estimate.estimate_data || estimate.estimateData)?.proposal?.enabled === true;
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
  billingTerm,
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
        billingTerm: billingTerm || 'standard',
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
  billingTerm = 'standard',
  database = db,
  leadLinkService = { markLinkedLeadEstimateAccepted },
  estimateConverter = EstimateConverter,
} = {}) {
  if (!estimateId) throw httpError('estimateId is required', 400);
  const normalizedBillingTerm = normalizeManualBillingTerm(billingTerm);
  const annualPrepaySelected = normalizedBillingTerm === 'prepay_annual';

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

    const isCommercialProposal = isCommercialProposalEstimate(estimate);

    // Invoice-mode: a normal estimate's due-immediately invoice is built by
    // EstimateConverter via the customer link, so manual accept still rejects
    // it. A commercial proposal instead builds its own first invoice from the
    // proposal line items below (#1917 invoice-mode win), so it passes here.
    if (estimate.bill_by_invoice && !isCommercialProposal) {
      throw httpError(
        'Invoice-mode estimates must be accepted through the customer link so the due-immediately invoice is created correctly.',
        400,
      );
    }

    // No linked customer: a normal estimate must be linked first (the converter
    // needs a customer). A commercial proposal win auto-creates and promotes
    // the customer from the proposal/contact details (#1917 lead-win).
    if (!estimate.customer_id && !isCommercialProposal) {
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

    // A commercial proposal's pricing/cadence lives in estimate_data.proposal,
    // which EstimateConverter does not read, so the proposal branch below marks
    // the win and skips conversion. Annual prepay, though, promises a real draft
    // invoice + pending renewal term that ONLY the converter creates — under the
    // skip it would silently produce nothing. Reject prepay for proposals so the
    // operator bills the board deal through the proposal's own invoice flow
    // rather than getting a no-op "annual prepay" win. (Lead/invoice-mode win
    // paths for proposals are tracked in #1917.)
    if (annualPrepaySelected && isCommercialProposalEstimate(estimate)) {
      throw httpError(
        'Annual prepay is not available for a commercial proposal. Mark it accepted as a standard win and bill it through the proposal invoice flow.',
        400,
      );
    }

    const annualPrepayAmount = annualPrepaySelected ? resolveAnnualPrepayAmount(estimate) : null;
    if (annualPrepaySelected && !annualPrepayAmount) {
      throw httpError('Annual prepay requires a recurring estimate with a monthly or annual total.', 400);
    }
    if (annualPrepaySelected && !hasManualAnnualPrepayRecurringRows(estimate)) {
      throw httpError('Annual prepay requires recurring service rows on the estimate.', 400);
    }
    if (annualPrepaySelected && !isManualAnnualPrepayEligibleServiceMix(estimate)) {
      throw httpError('Annual prepay is not available for this estimate service mix.', 400);
    }

    // #1917: a commercial proposal's customer creation + first invoice run AFTER
    // the guarded status flip below, so they only execute on the accept that
    // actually won the race — a losing/already-accepted path never orphans a
    // duplicate customer or invoice.
    let proposalCustomer = null;

    const now = trx.fn.now();
    const updates = {
      status: 'accepted',
      accepted_at: estimate.accepted_at || now,
      declined_at: null,
      decline_reason: null,
      updated_at: now,
      // Freeze the price at acceptance (atomic with the status flip; the
      // whereIn(status) guard below stops a second accept from re-pricing).
      price_locked_at: estimate.price_locked_at || now,
      price_locked_by: 'manual_accept',
      pricing_authority: 'LOCKED',
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

    // A commercial proposal's pricing lives in estimate_data.proposal.buildings,
    // which EstimateConverter does not read — it converts from the legacy
    // result/recurring service mix. Auto-converting here would activate the
    // wrong (or empty) service mix and drop the proposal's tax/cadence, so a
    // proposal records the win (status + linked-lead). Invoice-mode proposals
    // additionally build their first invoice straight from the proposal lines
    // (#1917); non-invoice-mode proposals leave billing to the operator.
    let conversion = null;
    let proposalInvoice = null;
    if (isCommercialProposal) {
      // Lead-win: create/link + promote the customer now. Only the flip winner
      // reaches here, so a concurrent accept can't orphan a duplicate customer.
      if (!updatedEstimate.customer_id) {
        proposalCustomer = await proposalWin.ensureCustomerForProposalWin({
          trx,
          estimate: updatedEstimate,
          proposal: normalizeProposal(updatedEstimate),
        });
        await trx('estimates')
          .where({ id: updatedEstimate.id })
          .update({ customer_id: proposalCustomer.customerId, updated_at: now });
        updatedEstimate.customer_id = proposalCustomer.customerId;
      } else {
        // Pre-linked customer: proposals skip EstimateConverter (which normally
        // promotes the linked customer), so promote/reactivate here — otherwise
        // a proposal linked to a lead/inactive/churned customer is won + invoiced
        // while the customer stays outside active-customer/revenue queries.
        await proposalWin.promoteLinkedCustomerForProposalWin({
          trx,
          customerId: updatedEstimate.customer_id,
        });
      }
      // Invoice-mode win: build the first invoice from the proposal line items.
      if (updatedEstimate.bill_by_invoice) {
        try {
          proposalInvoice = await proposalWin.createProposalAcceptanceInvoice({
            trx,
            estimate: updatedEstimate,
            proposal: normalizeProposal(updatedEstimate),
            customerId: updatedEstimate.customer_id,
          });
        } catch (err) {
          logger.warn(`[estimate-manual-acceptance] proposal invoice failed for estimate ${updatedEstimate.id}: ${err.message}`);
          throw httpError('Proposal invoice could not be created; estimate was not marked accepted.', 500);
        }
        // Invoice mode promises a first invoice. If the proposal has no billable
        // lines, there is nothing to bill — reject so the transaction rolls back
        // rather than recording an invoice-mode win with no invoice.
        if (!proposalInvoice) {
          throw httpError(
            'This invoice-mode proposal has no billable line items to invoice. Add priced lines or turn off invoice mode before winning it.',
            400,
          );
        }
      }
    } else if (asMoneyOrNull(updatedEstimate.monthly_total) || annualPrepaySelected) {
      try {
        // Manual Mark Won keeps scheduling under operator control. Standard
        // verbal wins also skip the setup invoice. Annual-prepay verbal wins
        // intentionally create the annual draft invoice + pending term so
        // billing/renewal state matches the customer's commitment.
        const convertOptions = {
          database: trx,
          skipAutoSchedule: true,
          skipMembershipEmail: true,
          skipSetupInvoice: !annualPrepaySelected,
        };
        if (annualPrepaySelected) {
          convertOptions.billingTerm = 'prepay_annual';
          convertOptions.prepayInvoiceAmount = annualPrepayAmount;
          convertOptions.autoSendInvoice = false;
        }
        conversion = await estimateConverter.convertEstimate(updatedEstimate.id, convertOptions);
        if (annualPrepaySelected && !conversion?.draftInvoiceId) {
          throw new Error('Annual prepay invoice was not created');
        }
      } catch (err) {
        logger.warn(`[estimate-manual-acceptance] EstimateConverter failed for estimate ${updatedEstimate.id}: ${err.message}`);
        throw httpError('Customer conversion did not complete; estimate was not marked accepted.', 500);
      }
    }

    // Audit the win AFTER the customer is created/linked so a newly-created
    // no-customer proposal customer gets the acceptance event in its timeline
    // (activity_log is keyed on customer_id). updatedEstimate.customer_id is now
    // final for every path: created/linked above for proposals, already set for
    // non-proposals. A throw above rolls back this same trx, so no orphan log.
    await logManualAcceptance(trx, {
      estimate,
      updatedEstimate,
      adminUserId,
      source,
      billingTerm: normalizedBillingTerm,
    });

    return {
      acceptedEstimate: updatedEstimate,
      alreadyAccepted: false,
      shouldRunDownstream: true,
      previousEstimate: estimate,
      conversion,
      proposalInvoice,
      proposalCustomer,
    };
  });

  const {
    acceptedEstimate,
    alreadyAccepted,
    shouldRunDownstream,
    conversion,
    proposalInvoice = null,
    proposalCustomer = null,
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

    if (normalizedBillingTerm !== 'prepay_annual' && conversion?.membershipEmail) {
      void AccountMembershipEmail.sendMembershipStarted(conversion.membershipEmail)
        .catch((err) => logger.warn(`[estimate-manual-acceptance] membership.started email failed for estimate ${acceptedEstimate.id}: ${err.message}`));
    }

    // Conversion runs inside the accept transaction, so the converter defers
    // the new-recurring welcome SMS. Fire it post-commit. Idempotent, so if the
    // operator later schedules the visit on the calendar (admin-schedule's own
    // welcome path) it won't double-send.
    if (conversion?.welcomeSms) {
      const { sendNewRecurringWelcome } = require('./new-recurring-welcome-sms');
      void sendNewRecurringWelcome(conversion.welcomeSms)
        .catch((err) => logger.warn(`[estimate-manual-acceptance] welcome SMS failed for estimate ${acceptedEstimate.id}: ${err.message}`));
    }
  }

  return {
    estimate: acceptedEstimate,
    alreadyAccepted,
    conversion,
    billingTerm: normalizedBillingTerm,
    warnings,
    // #1917 proposal win surfaces: the auto-built invoice + whether a new
    // customer was created, so the admin UI can link to them.
    proposalInvoice: proposalInvoice
      ? {
        id: proposalInvoice.id,
        invoiceNumber: proposalInvoice.invoice_number,
        token: proposalInvoice.token,
        total: proposalInvoice.total,
      }
      : null,
    createdCustomer: proposalCustomer?.created
      ? { id: proposalCustomer.customerId }
      : null,
  };
}

module.exports = {
  MANUAL_ACCEPTABLE_STATUSES,
  markEstimateManuallyAccepted,
  normalizeManualBillingTerm,
  resolveAnnualPrepayAmount,
  hasManualAnnualPrepayRecurringRows,
  isManualAnnualPrepayEligibleServiceMix,
  isCommercialProposalEstimate,
};
