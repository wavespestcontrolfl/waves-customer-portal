// ============================================================
// setup-fee-alert-reconcile.js
//
// The ONE reconciliation for the estimate-wide unminted-setup-fee
// manual-billing alert (PR #3476). Called by the completion route on
// every non-parking completion of an estimate-sourced visit, and by the
// manual invoice route after a stamped manual invoice commits — the two
// paths staff use to satisfy the alert's instructions.
//
// ATOMIC with invoice state (Codex P0, final rounds): the whole
// read-classify-rewrite runs in ONE transaction that first takes the
// alert's dedupe advisory lock (the same key the alert-writing
// transaction takes) and reads the coverage invoices FOR UPDATE — a
// covering invoice can no longer be voided between the scans and the
// alert rewrite, and a stamped manual invoice serialized on the same
// key cannot interleave.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');

async function reconcileSetupFeeAlert({ customerId, sourceEstimateId, actorLabel = '' }) {
  if (!customerId || !sourceEstimateId) return;
  const dedupeKey = `unminted_setup_fee_manual_billing:${sourceEstimateId}`;
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [dedupeKey]);
          // RESOLVED rows are reconciled too (Codex P0, pre-push round
          // 18): if the fee's covering invoice is later voided while the
          // application invoice stays live, the resolved alert is the
          // only durable follow-up left — it must REOPEN with the
          // uncovered charge, never stay settled forever.
          const staleAlert = await trx('notifications')
            .where({ recipient_type: 'admin' })
            .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
            .first('id', 'metadata');
          if (!staleAlert) return;
          const {
            invoiceHasPositiveSetupFeeLine, invoiceBillsBaseApplication,
          } = require('./estimate-first-application-invoice');
          const staleMeta = typeof staleAlert.metadata === 'string'
            ? (() => { try { return JSON.parse(staleAlert.metadata); } catch { return null; } })()
            : staleAlert.metadata;
          // The alert's PERSISTED customer owns this reconciliation (Codex
          // PR r5 P1): a visit re-linked to another customer keeps its
          // source_estimate_id, and scanning under the NEW customer would
          // miss the original customer's fee invoice and reopen a settled
          // alert. A foreign visit never reconciles someone else's alert.
          const alertCustomerId = staleMeta?.customerId ? String(staleMeta.customerId) : null;
          if (alertCustomerId && alertCustomerId !== String(customerId)) return;
          const scanCustomerId = alertCustomerId || customerId;
          const deadAway = new Set([...require('./invoice').CANCELLED_SERVICE_RESOLVED_STATUSES, 'void']);
          const stampedLive = (await trx('invoices')
            .where({ customer_id: scanCustomerId })
            .where('notes', 'like', `%accepted estimate #${sourceEstimateId}%`)
            .forUpdate()
            .select('id', 'status', 'line_items', 'notes'))
            .filter((r) => !deadAway.has(String(r.status || '').toLowerCase()));
          // Alert-driven manual invoices may carry no service link (the
          // manual-invoice endpoint's link is optional — Codex PR r4 P1),
          // so the alert bodies instruct staff to stamp
          // "accepted estimate #<id>" into the invoice NOTES — the SAME
          // linkage convention every accept-time mint uses. The stamped
          // scan above then owns those rows; a customer-wide description
          // scan is deliberately NOT used (exact descriptions are
          // classifiers, not ownership keys — another estimate's
          // WaveGuard invoice must never settle this one's charges,
          // Codex P0 round 19).
          // EVERY parked visit must have its application billed (Codex
          // P0, pre-push round 15): a cross-visit race parks additional
          // visits into parkedVisitIds, and resolving on the primary
          // visit alone would strand the others unbilled with no alert.
          const parkedIds = [...new Set([
            ...(staleMeta?.scheduledServiceId ? [String(staleMeta.scheduledServiceId)] : []),
            ...(Array.isArray(staleMeta?.parkedVisitIds) ? staleMeta.parkedVisitIds.map(String) : []),
          ])];
          const onParkedLive = parkedIds.length
            ? (await trx('invoices')
              .where((qb) => {
                qb.whereIn('scheduled_service_id', parkedIds);
                if (staleMeta?.serviceRecordId) qb.orWhere({ service_record_id: staleMeta.serviceRecordId });
              })
              .forUpdate()
              .select('id', 'status', 'line_items', 'notes', 'scheduled_service_id', 'service_record_id'))
              .filter((r) => !deadAway.has(String(r.status || '').toLowerCase()))
            : [];
          // Notes are provenance, never charge coverage (Codex P0,
          // pre-push round 12) — only a positive parseable base line
          // (invoiceBillsBaseApplication) proves an application billed.
          // The stamped acceptance invoice can cover only the PRIMARY
          // visit's (first) application; every other parked visit needs
          // its own attached invoice.
          // Out-of-band prepayment revalidated from the DURABLE rows
          // (Codex PR r5 P1): a visit marked prepaid (cash/Zelle — never
          // the annual-prepay stamp) has its application collected, and
          // reconciliation must not instruct re-billing it after staff
          // bills the fee.
          const AnnualPrepayRenewalsReconcile = require('./annual-prepay-renewals');
          const prepaidParkedRows = parkedIds.length
            ? await trx('scheduled_services').whereIn('id', parkedIds).select('id', 'prepaid_amount', 'prepaid_method')
            : [];
          const prepaidCoveredIds = new Set(prepaidParkedRows
            .filter((r) => Number(r.prepaid_amount) > 0
              && r.prepaid_method !== AnnualPrepayRenewalsReconcile.ANNUAL_PREPAY_PREPAID_METHOD)
            .map((r) => String(r.id)));
          const feeProven = [...stampedLive, ...onParkedLive].some(invoiceHasPositiveSetupFeeLine);
          const primaryVisitId = String(staleMeta?.scheduledServiceId || '');
          const visitApplicationBilled = (visitId) => onParkedLive.some((r) => (
            String(r.scheduled_service_id || '') === String(visitId)
            || (String(visitId) === primaryVisitId
              && staleMeta?.serviceRecordId
              && String(r.service_record_id || '') === String(staleMeta.serviceRecordId))
            // Only the durable base-application identity counts (Codex
            // P0, round 18 — visit linkage alone is insufficient money
            // evidence: an add-on/product invoice on the visit must not
            // read as the application billed). The alert bodies instruct
            // staff to use the exact recognizable line description.
          ) && invoiceBillsBaseApplication(r));
          const applicationProven = parkedIds.length > 0 && parkedIds.every((visitId) => (
            visitApplicationBilled(visitId)
            || prepaidCoveredIds.has(String(visitId))
            || (String(visitId) === primaryVisitId && stampedLive.some(invoiceBillsBaseApplication))
          ));
          // All four coverage states rewrite the alert (Codex P0,
          // pre-push round 17): once staff bills ONE charge, the original
          // "bill BOTH" instruction must shrink to only what is still
          // uncovered — a stale instruction on a covered charge is a
          // duplicate-collection script. Neither-covered leaves the
          // original instruction standing.
          const wasResolved = staleMeta?.resolvedCovered === true || staleMeta?.resolvedCovered === 'true';
          if (feeProven && applicationProven) {
            if (wasResolved) return; // already settled — idempotent
            await trx('notifications').where({ id: staleAlert.id }).update({
              body: `RESOLVED — no action needed: live invoices now cover BOTH the one-time setup fee and every parked visit's application charge for this estimate. The earlier manual-billing instruction no longer applies; do NOT bill again on this alert.`,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: true })]),
            });
            logger.warn(`[setup-fee-reconcile]${actorLabel} stale unminted-setup-fee alert ${staleAlert.id} rewritten as resolved — fee and application coverage both proven`);
          } else if (!feeProven && !applicationProven
            && (wasResolved || staleMeta?.feeCovered === true || staleMeta?.applicationCovered === true)) {
            // Coverage fully regressed after resolution — REOPEN with the
            // original both-charges instruction.
            await trx('notifications').where({ id: staleAlert.id }).update({
              body: `REOPENED: the invoices that covered this estimate's setup fee and parked application are no longer live. Bill BOTH charges manually: the one-time WaveGuard setup fee plus the parked visit application${parkedIds.length === 1 ? '' : 's'} (${parkedIds.join(', ')}). Use the EXACT line descriptions "WaveGuard Membership — one-time setup fee" and "First service application", and include "accepted estimate #${sourceEstimateId}" in the invoice notes, so the system recognizes them as billed.`,
              read_at: null,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: false, feeCovered: false, applicationCovered: false })]),
            });
            logger.warn(`[setup-fee-reconcile]${actorLabel} unminted-setup-fee alert ${staleAlert.id} REOPENED — coverage regressed after resolution/partial coverage`);
          } else if (feeProven) {
            const uncoveredIds = parkedIds.filter((visitId) => !(visitApplicationBilled(visitId)
              || prepaidCoveredIds.has(String(visitId))
              || (String(visitId) === primaryVisitId && stampedLive.some(invoiceBillsBaseApplication))));
            await trx('notifications').where({ id: staleAlert.id }).update({
              body: `UPDATE: the one-time setup fee for this estimate is now COVERED by a live invoice — do NOT bill the setup fee again. Still owed: the application charge for parked visit${uncoveredIds.length === 1 ? '' : 's'} ${uncoveredIds.join(', ')} — bill only that, using the EXACT line description "First service application" and "accepted estimate #${sourceEstimateId}" in the invoice notes so the system recognizes it as billed.`,
              read_at: null,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: false, feeCovered: true, applicationCovered: false })]),
            });
            logger.warn(`[setup-fee-reconcile]${actorLabel} unminted-setup-fee alert ${staleAlert.id} rewritten — fee covered, application(s) still owed`);
          } else if (applicationProven) {
            await trx('notifications').where({ id: staleAlert.id }).update({
              body: `UPDATE: every parked visit's application charge for this estimate is now COVERED by live invoices — do NOT bill an application again. Still owed: the one-time WaveGuard setup fee — bill only that, using the EXACT line description "WaveGuard Membership — one-time setup fee" and "accepted estimate #${sourceEstimateId}" in the invoice notes so the system recognizes it as billed.`,
              read_at: null,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: false, applicationCovered: true, feeCovered: false })]),
            });
            logger.warn(`[setup-fee-reconcile]${actorLabel} unminted-setup-fee alert ${staleAlert.id} rewritten — application(s) covered, fee still owed`);
          }
  });
}

// Post-transition tap for coverage-CHANGING invoice writes (void, refund,
// cancel, line-item edit — Codex P0, final round): any invoice that is
// stamped for an estimate or linked to an estimate-sourced visit
// re-runs the alert reconciliation post-commit, so removed coverage
// REOPENS the alert instead of leaving it labeled RESOLVED forever.
// Best-effort by contract: the transition itself already committed.
async function reconcileSetupFeeAlertForInvoice(invoice) {
  try {
    if (!invoice) return;
    const stamp = String(invoice.notes || '').match(/accepted estimate #([0-9a-fA-F-]{8,})/);
    let estimateId = stamp ? stamp[1] : null;
    let customerId = invoice.customer_id || null;
    if (!estimateId && invoice.scheduled_service_id) {
      const ss = await db('scheduled_services')
        .where({ id: invoice.scheduled_service_id })
        .first('source_estimate_id', 'customer_id');
      estimateId = ss?.source_estimate_id || null;
      customerId = customerId || ss?.customer_id || null;
    }
    if (!estimateId || !customerId) return;
    await reconcileSetupFeeAlert({
      customerId,
      sourceEstimateId: estimateId,
      actorLabel: ` invoice ${invoice.id} transition:`,
    });
  } catch (err) {
    logger.error(`[setup-fee-reconcile] invoice-transition reconcile failed for ${invoice?.id}: ${err.message}`);
  }
}

// Daily safety net (billing cron): webhook-driven refund transitions flip
// invoice rows at many call sites — rather than tapping each, every
// standing setup-fee alert re-reconciles once a day, so a coverage
// regression the taps missed reopens within 24h.
async function sweepSetupFeeAlerts() {
  const rows = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' LIKE 'unminted_setup_fee_manual_billing:%'")
    .select('id', 'metadata');
  for (const row of rows) {
    try {
      const meta = typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : (row.metadata || {});
      const estimateId = String(meta?.dedupeKey || '').split(':')[1] || null;
      const customerId = meta?.customerId || null;
      if (!estimateId || !customerId) continue;
      await reconcileSetupFeeAlert({
        customerId,
        sourceEstimateId: estimateId,
        actorLabel: ` daily-sweep alert ${row.id}:`,
      });
    } catch (err) {
      logger.error(`[setup-fee-reconcile] daily sweep failed for alert ${row.id}: ${err.message}`);
    }
  }
}

module.exports = { reconcileSetupFeeAlert, reconcileSetupFeeAlertForInvoice, sweepSetupFeeAlerts };
