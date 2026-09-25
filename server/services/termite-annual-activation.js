'use strict';

// ============================================================
// termite-annual-activation.js — completes the deferred half of "sign
// before pay" for the Subterranean Termite Protection annual plan (slice
// 3a, owner ruling 2026-09-24, dark behind GATE_TERMITE_ANNUAL_PLAN).
//
// estimate-converter.js defers the annual-fee invoice + annual_prepay_terms
// row on accept until the customer e-signs the annual agreement — this
// module runs that deferred work once contracts-public.js's sign route
// commits a signature on that exact agreement template.
//
// Idempotent by construction: everything happens under a FOR UPDATE lock on
// the source estimate row, gated on
// estimates.annual_plan_activation_status === 'awaiting_signature'. A
// double-sign, a webhook replay, or a retry after a prior partial failure
// all land on the same check and no-op once the estimate reads 'activated'.
//
// Fail-closed, never throws out of the caller: any failure rings the admin
// bell and leaves the estimate 'awaiting_signature' so it can be retried —
// by a re-drive of this function, or by the slice-3b reconciliation sweep
// (TODO: not built in this slice — see estimate-converter.js's deferral
// comment for the same TODO).
// ============================================================

const db = require('../models/db');
const logger = require('./logger');

const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';
const DEFAULT_ANNUAL_PLAN_VERSION = 'v3';
// The annual plan is one inspection per year (gate comment on
// GATE_TERMITE_ANNUAL_PLAN, feature-gates.js) — fixed coverage shape, not
// derived per-estimate the way the generic multi-program prepay path does.
const COVERAGE_SERVICE_TYPE = 'Termite Bait';
const COVERAGE_VISIT_COUNT = 1;
const COVERAGE_CADENCE = 'annual';

function parseJsonish(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// The termite program agreement (termite-program-agreement.js) has always
// snapshotted its source estimate at document_variables_snapshot.estimate.id
// — reused here rather than adding a new customer_contracts column, per the
// slice's own design note. Slice 2 (the v3 annual template, PR #4811, not
// yet merged) builds its render context the same way; if that ever
// diverges, sourceEstimateId comes back null and this function fails
// closed below rather than guessing.
function sourceEstimateIdFromContract(contract) {
  const snapshot = parseJsonish(contract?.document_variables_snapshot);
  const id = snapshot?.estimate?.id;
  return id ? String(id) : null;
}

// Mirrors selectedTermiteAnnualPlanRows' own precedence (mapped tmBait
// envelope wins; otherwise the raw lineItems row) — the first row carrying a
// positive `.annual` is the recurring annual-fee line. Setup/installation
// rows (service: 'termite_bait_installation', kind: 'setup') don't carry an
// `.annual` field, so they're skipped automatically rather than by name.
function resolveAnnualFeeAmount(annualPlanRows) {
  for (const row of annualPlanRows) {
    const n = Number(row?.annual);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
  }
  return null;
}

async function ringActivationBell(NotificationService, { estimateId, contractId, reason }) {
  try {
    await NotificationService.notifyAdmin(
      'estimate',
      'Termite annual plan activation needs manual follow-up',
      `Signed annual termite agreement (contract #${contractId}${estimateId ? `, estimate #${estimateId}` : ''}) could not activate automatically: ${reason}. The estimate stays "awaiting signature" — recheck after fixing, or activate by hand.`,
      {
        icon: '⚠️',
        link: estimateId ? `/admin/estimates?estimateId=${estimateId}` : undefined,
        bell: true,
        metadata: { estimateId, contractId, reason },
      },
    );
  } catch (bellErr) {
    logger.error(`[termite-annual-activation] admin bell failed for contract ${contractId}: ${bellErr.message}`);
  }
}

/**
 * Runs the deferred annual-prepay term + invoice for a just-signed termite
 * annual agreement. Call this AFTER the sign transaction has committed.
 *
 * @param {object} params
 * @param {string|number} params.contractId - the just-signed customer_contracts.id
 * @param {import('knex').Knex} [params.conn] - defaults to the shared db handle
 * @returns {Promise<{activated: boolean}|{skipped: string, [key: string]: any}>}
 */
async function activateTermiteAnnualPlanForSignedContract({ contractId, conn = db }) {
  if (!contractId) return { skipped: 'no_contract_id' };
  let estimateId = null;
  try {
    const result = await conn.transaction(async (trx) => {
      const contract = await trx('customer_contracts').where({ id: contractId }).first();
      if (!contract) return { skipped: 'contract_not_found' };
      if (contract.document_template_key !== ANNUAL_TEMPLATE_KEY) return { skipped: 'not_annual_template' };
      if (contract.status !== 'signed') return { skipped: 'not_signed' };

      estimateId = sourceEstimateIdFromContract(contract);
      if (!estimateId) return { skipped: 'no_source_estimate' };

      const estimate = await trx('estimates').where({ id: estimateId }).forUpdate().first();
      if (!estimate) return { skipped: 'estimate_not_found' };
      // Idempotent: already activated (double-sign / replay / a retried
      // call), or never deferred in the first place — never re-run the
      // money side, and never overwrite a terminal 'activated' stamp.
      if (estimate.annual_plan_activation_status !== 'awaiting_signature') {
        return { skipped: estimate.annual_plan_activation_status || 'not_awaiting_signature' };
      }

      const { selectedTermiteAnnualPlanRows } = require('./estimate-termite-program-rows');
      let estimateData = estimate.estimate_data;
      if (typeof estimateData === 'string') {
        try { estimateData = JSON.parse(estimateData); } catch { estimateData = {}; }
      }
      estimateData = estimateData || {};
      const annualPlanRows = selectedTermiteAnnualPlanRows(estimateData);
      if (!annualPlanRows.length) return { skipped: 'no_annual_plan_rows_on_estimate' };
      const annualAmount = resolveAnnualFeeAmount(annualPlanRows);
      if (!annualAmount) return { skipped: 'annual_fee_amount_underivable' };

      const { pendingDepositCredit, consumeDepositCredit } = require('./estimate-deposits');
      const InvoiceService = require('./invoice');
      let requestedDepositCredit = 0;
      const depositCredit = await pendingDepositCredit(estimateId, trx).catch(() => null);
      requestedDepositCredit = depositCredit ? Number(depositCredit.amount) || 0 : 0;
      const invoice = await InvoiceService.create({
        database: trx,
        customerId: estimate.customer_id,
        title: 'Subterranean Termite Protection — Annual Fee',
        lineItems: [{
          description: 'Subterranean Termite Protection — annual fee (signed agreement)',
          quantity: 1,
          unit_price: annualAmount,
        }],
        notes: `Auto-generated on signature of the termite annual agreement (contract #${contractId}, estimate #${estimateId}). Charge was deferred at acceptance until this signature (sign-before-pay).`,
        ...(requestedDepositCredit > 0
          ? { depositCredit: { amount: requestedDepositCredit, estimateId } }
          : {}),
      });
      const appliedDepositCredit = Number(invoice?.applied_deposit_credit) || 0;
      if (invoice?.id && appliedDepositCredit > 0) {
        await consumeDepositCredit({
          estimateId, amount: appliedDepositCredit, invoiceId: invoice.id, trx,
        });
      }
      if (!invoice?.id) throw new Error('Annual-fee invoice was not created');

      const AnnualPrepayRenewals = require('./annual-prepay-renewals');
      const prepayAmount = invoice.total != null ? Number(invoice.total) : annualAmount;
      const term = await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: estimate.customer_id,
        sourceEstimateId: estimateId,
        prepayInvoiceId: invoice.id,
        planLabel: 'Termite Annual Protection',
        monthlyRate: Math.round((annualAmount / 12) * 100) / 100,
        prepayAmount,
        coverageServiceType: COVERAGE_SERVICE_TYPE,
        coverageVisitCount: COVERAGE_VISIT_COUNT,
        coverageCadence: COVERAGE_CADENCE,
        conn: trx,
      });
      if (!term?.id) throw new Error('Annual prepay term was not created');

      // Ruling A-13: the signed v3 annual agreement IS the auto-charge
      // consent — stamp it on the term the moment that signature commits.
      await trx('annual_prepay_terms').where({ id: term.id }).update({
        annual_plan_version: contract.annual_plan_version || DEFAULT_ANNUAL_PLAN_VERSION,
        renewal_charge_consent_at: contract.signed_at || new Date(),
      });

      await trx('estimates').where({ id: estimateId }).update({
        annual_plan_activation_status: 'activated',
        annual_plan_activated_at: new Date(),
      });

      return { activated: true, termId: term.id, invoiceId: invoice.id };
    });

    if (result?.skipped) return result;
    return result;
  } catch (err) {
    logger.error(`[termite-annual-activation] activation failed for contract ${contractId}${estimateId ? ` (estimate ${estimateId})` : ''}: ${err.message}`);
    try {
      const NotificationService = require('./notification-service');
      await ringActivationBell(NotificationService, { estimateId, contractId, reason: err.message });
    } catch (bellSetupErr) {
      logger.error(`[termite-annual-activation] bell setup failed for contract ${contractId}: ${bellSetupErr.message}`);
    }
    return { skipped: 'error', error: err.message };
  }
}

module.exports = {
  activateTermiteAnnualPlanForSignedContract,
  ANNUAL_TEMPLATE_KEY,
};
