const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const EstimateConverter = require('./estimate-converter');
const AccountMembershipEmail = require('./account-membership-email');
const { markLinkedLeadEstimateAccepted } = require('./lead-estimate-link');
const { normalizeProposal } = require('./estimate-proposal');
const proposalWin = require('./proposal-win');
const {
  estimateDataHasUnresolvedManagerApproval,
  commercialRiskTypeReviewNeeded,
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
  if (Array.isArray(data.services)
    && data.services.some((svc) => svc?.recurring || svc?.frequency)) {
    return true;
  }
  // Engine-backed estimates (quote wizard / IB drafts) persist recurring rows
  // only under estimate_data.engineResult.lineItems — the converter accepts
  // them (via the same engine-aware extractor), so the prepay gates must not
  // reject them on the legacy shapes above.
  try {
    const { acceptanceServiceLists } = require('../routes/estimate-public');
    return (acceptanceServiceLists(data).recurringSvcList || []).length > 0;
  } catch {
    return false;
  }
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

// The amount actually INVOICED when this estimate is accepted as annual prepay:
// the undiscounted recurring annual run through the converter's shared resolver,
// which applies the prepay discount (non-membership-fee mixes) and the
// non-discountable floor — PLUS, for commercial recurring quotes, the same
// blended commercial sales tax the converter passes to InvoiceService.create
// (the customer is marked property_type='commercial' on accept, so the minted
// invoice is tax-inclusive). Same resolvers the accept path uses, so a
// Schedule-modal preview matches the invoice the booking mints (no
// pre-discount-vs-invoice and no pre-tax-vs-invoice drift). Null when there's
// no recurring annual.
async function annualPrepayInvoiceTotalForEstimate(estimate = {}) {
  const baseAnnual = resolveAnnualPrepayAmount(estimate);
  if (!baseAnnual) return null;
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  const { acceptanceServiceLists } = require('../routes/estimate-public');
  const { recurringSvcList } = acceptanceServiceLists(data);
  const resolved = EstimateConverter.resolveAnnualPrepayInvoiceTotal({
    baseAnnual,
    recurringServices: recurringSvcList,
    estimateData: data,
  });
  if (resolved?.amount == null) return null;
  const amount = Number(resolved.amount);
  // Same commercial detection as the converter (recurringServiceKey prefix) —
  // non-commercial prepay stays residential-exempt, so no tax leg at all.
  const hasCommercialRecurring = (recurringSvcList || []).some(
    (svc) => String(EstimateConverter.recurringServiceKey(svc) || '').startsWith('commercial_')
  );
  let total = amount;
  if (hasCommercialRecurring) {
    // Effective (exemption/county-aware) base rate for this customer, blended
    // by the taxable pest share of the plan — mirrors the converter's
    // prepayTaxRate. Fails soft to the FL default inside the resolver, like
    // the accept path. Tax dollars round to cents exactly as InvoiceService
    // does (rate * after-discount subtotal), so preview == minted total.
    const baseRate = await EstimateConverter.resolveCommercialPrepayBaseRate(
      estimate.customer_id || estimate.customerId || null, {}
    );
    const taxRate = EstimateConverter.resolveCommercialPrepayTaxRate(recurringSvcList, {
      prepayDiscountApplied: Number(resolved.discount) > 0,
      baseRate,
    });
    const taxDollars = Math.round(amount * taxRate * 100) / 100;
    total = Math.round((amount + taxDollars) * 100) / 100;
  }
  // Deposit credit: convertEstimate applies any pending estimate deposit to
  // the minted invoice (InvoiceService caps it against the after-tax total),
  // so the operator-facing preview nets it out the same way. Fail-SOFT to the
  // gross total on a read error — this is display copy; the accept path
  // re-reads the ledger fail-CLOSED inside its transaction.
  let depositCredit = 0;
  if (estimate.id) {
    try {
      const { pendingDepositCredit } = require('./estimate-deposits');
      const credit = await pendingDepositCredit(estimate.id);
      depositCredit = credit ? Math.max(0, Number(credit.amount) || 0) : 0;
    } catch { depositCredit = 0; }
  }
  return Math.round(Math.max(0, total - depositCredit) * 100) / 100;
}

// Can this estimate be accepted as annual prepay WHILE booking (the Schedule
// modal's one-step prepay), and may the modal offer it? Mirrors every guard
// markEstimateManuallyAccepted enforces for billingTerm='prepay_annual' — so
// the modal never offers what the server would reject — PLUS the converter's
// single-recurring-unit rule (one coverage_service_type per term; the shared
// annualPrepayRecurringUnitCount also counts a supplemental companion a solo
// primary absorbs, mirroring the converter's multi-service 422).
// Returns { eligible, invoiceTotal, reason }. Async because the eligible-path
// invoiceTotal resolves the customer's effective commercial tax rate.
async function prepayBookingEligibility(estimate = {}) {
  const ineligible = (reason) => ({ eligible: false, invoiceTotal: null, reason });
  const baseAnnual = resolveAnnualPrepayAmount(estimate);
  if (!baseAnnual) return ineligible('no_recurring_annual');
  if (isCommercialProposalEstimate(estimate)) return ineligible('commercial_proposal');
  if (estimate.bill_by_invoice) return ineligible('invoice_mode');
  if (estimate.show_one_time_option) return ineligible('one_time_option');
  if (!hasManualAnnualPrepayRecurringRows(estimate)) return ineligible('no_recurring_rows');
  if (!isManualAnnualPrepayEligibleServiceMix(estimate)) return ineligible('ineligible_mix');
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  const units = EstimateConverter.annualPrepayRecurringUnitCount(data);
  if (units !== 1) return ineligible(units > 1 ? 'multi_service' : 'no_recurring_rows');
  return { eligible: true, invoiceTotal: await annualPrepayInvoiceTotalForEstimate(estimate), reason: null };
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
  // Booked first-visit date (YYYY-MM-DD) for an annual-prepay accept made WHILE
  // scheduling — anchors the renewal term to the actual first service instead
  // of today. Ignored for standard accepts and when not supplied.
  annualPrepayTermStart = null,
  // Coverage config for an annual-prepay accept made WHILE scheduling
  // ({ coverageServiceType, coverageVisitCount, coverageCadence }), so the term
  // stamps the operator's just-booked visit series prepaid on payment instead
  // of seeding a duplicate one. coverageServiceType MUST be the booked
  // service_type so the coverage match (serviceMatchesCoverage) finds the
  // booked rows. Ignored for standard accepts and when not supplied.
  annualPrepayCoverage = null,
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
    if (commercialRiskTypeReviewNeeded(estimate.estimate_data || estimate.estimateData)) {
      throw httpError('Set the commercial business type before accepting — it sets the pest/rodent service cadence.', 400);
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

    // Race guard: re-derive proposal mode from the CLAIMED row. The validity
    // guards above ran on the pre-claim SELECT; if a proposal-mode toggle
    // committed between that read and this guarded UPDATE, the guards + the
    // branch below would act on the wrong mode — routing a now-proposal through
    // the legacy EstimateConverter (dropping its pricing/tax/cadence), or
    // vice-versa. Bail so the operator retries against fresh state rather than
    // mis-billing. (No-toggle is the norm, so this never fires in practice.)
    if (isCommercialProposalEstimate(updatedEstimate) !== isCommercialProposal) {
      throw httpError('This estimate changed while it was being accepted. Refresh and try again.', 409);
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
      // Flag the (created or pre-linked) customer commercial for a TAXABLE
      // proposal even when we're not building the first invoice now — otherwise a
      // pre-linked residential/lead customer stays non-commercial and any later
      // invoice for this taxable commercial work would be forced to $0 tax,
      // underbilling. Idempotent (a new lead-win customer is already commercial).
      await proposalWin.flagProposalCustomerCommercialIfTaxable({
        trx,
        customerId: updatedEstimate.customer_id,
        proposal: normalizeProposal(updatedEstimate),
      });
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
          if (annualPrepayTermStart) convertOptions.annualPrepayTermStart = annualPrepayTermStart;
          if (annualPrepayCoverage && annualPrepayCoverage.coverageServiceType) {
            // Fail CLOSED on a coverage cadence the renewal/stamping math
            // doesn't support: letting it silently normalize to null
            // downstream would seed a visit-count-derived schedule on wrong
            // dates, and paid covered visits could complete-bill again.
            // Callers pass a pre-normalized value (see admin-schedule's
            // prepayCoverageCadenceForPattern); this guards future callers.
            if (annualPrepayCoverage.coverageCadence != null) {
              const { normalizeCoverageCadence } = require('./annual-prepay-renewals')._private;
              if (!normalizeCoverageCadence(annualPrepayCoverage.coverageCadence)) {
                // isOperational: the conversion catch below passes operational
                // 422s through verbatim instead of wrapping them as a 500.
                const cadenceErr = httpError(`Unsupported annual-prepay coverage cadence: ${annualPrepayCoverage.coverageCadence}`, 422);
                cadenceErr.isOperational = true;
                throw cadenceErr;
              }
            }
            convertOptions.coverageServiceType = annualPrepayCoverage.coverageServiceType;
            convertOptions.coverageVisitCount = annualPrepayCoverage.coverageVisitCount;
            convertOptions.coverageCadence = annualPrepayCoverage.coverageCadence;
          }
          // ATOMIC overlap guard: take the SAME per-customer advisory lock the
          // Customer 360 prepay endpoints use and re-assert no overlapping term
          // INSIDE this transaction — so a double-click, two admins, or an
          // accept racing a Customer 360 prepay can't mint duplicate prepay
          // invoices/terms. The lock releases at commit/rollback. Term start =
          // the booked first visit for prepay-on-book, else today (the
          // converter's own default for manual accepts).
          const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;
          await lockAndAssertNoAnnualPrepayOverlap(
            trx,
            updatedEstimate.customer_id,
            annualPrepayTermStart || etDateString(),
            false,
            'Customer already has an annual prepay term through',
          );
        }
        conversion = await estimateConverter.convertEstimate(updatedEstimate.id, convertOptions);
        if (annualPrepaySelected && !conversion?.draftInvoiceId) {
          throw new Error('Annual prepay invoice was not created');
        }
      } catch (err) {
        logger.warn(`[estimate-manual-acceptance] EstimateConverter failed for estimate ${updatedEstimate.id}: ${err.message}`);
        // Surface the converter's fail-closed annual-prepay guards (multi-service
        // unsupported / coverage underivable) as their clear, operator-actionable
        // message (convert monthly or bill the prepay manually) rather than a
        // generic 500. The trx rolls back either way, so no partial
        // customer/visit/term/invoice is left behind.
        if (err && err.isOperational && err.statusCode === 422) {
          throw httpError(err.message, 422);
        }
        // Surface the atomic overlap guard as a 409 that keeps its tag, so the
        // booking route can detect it and degrade to a standard booking with a
        // warning instead of failing the whole request opaquely.
        if (err && err.annualPrepayOverlap) {
          const overlapErr = httpError(err.message, 409);
          overlapErr.annualPrepayOverlap = err.annualPrepayOverlap;
          throw overlapErr;
        }
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
  annualPrepayInvoiceTotalForEstimate,
  prepayBookingEligibility,
  hasManualAnnualPrepayRecurringRows,
  isManualAnnualPrepayEligibleServiceMix,
  isCommercialProposalEstimate,
};
