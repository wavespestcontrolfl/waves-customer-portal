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
  // Pre-read the visit ids the coverage scans will touch so their shared
  // mint locks can be taken in the SAME global order every invoice writer
  // uses — mint locks first (sorted), dedupe lock after, exactly like the
  // alert-writing transaction (Codex P0: row locks cannot stop phantom
  // inserts; only the shared advisory locks serialize linked mints).
  const preAlerts = await db('notifications')
    .where({ recipient_type: 'admin' })
    .where(function preKeys() {
      this.whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
        .orWhereRaw("metadata->>'setupFeeDedupeKey' = ?", [dedupeKey]);
    })
    .select('metadata');
  const preLockVisitIds = [...new Set(preAlerts.flatMap((row) => {
    const m = typeof row.metadata === 'string'
      ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })()
      : row.metadata;
    return [
      ...(m?.scheduledServiceId ? [String(m.scheduledServiceId)] : []),
      ...(Array.isArray(m?.parkedVisitIds) ? m.parkedVisitIds.map(String) : []),
    ];
  }))].sort();
  await db.transaction(async (trx) => {
    const { acquireScheduledInvoiceMintLock } = require('./scheduled-invoice-mint');
    for (const lockId of preLockVisitIds) {
      await acquireScheduledInvoiceMintLock(trx, lockId);
    }
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [dedupeKey]);
    // A visit parked AFTER the pre-read is outside our lock set — do not
    // classify under a torn lock order; the next reconcile/sweep owns it.
    const lockCheck = await trx('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .first('metadata');
    const lockCheckMeta = lockCheck && (typeof lockCheck.metadata === 'string'
      ? (() => { try { return JSON.parse(lockCheck.metadata); } catch { return null; } })()
      : lockCheck.metadata);
    const nowIds = [
      ...(lockCheckMeta?.scheduledServiceId ? [String(lockCheckMeta.scheduledServiceId)] : []),
      ...(Array.isArray(lockCheckMeta?.parkedVisitIds) ? lockCheckMeta.parkedVisitIds.map(String) : []),
    ];
    if (nowIds.some((id) => !preLockVisitIds.includes(id))) {
      logger.warn(`[setup-fee-reconcile]${actorLabel} parked set grew mid-lock — deferring to the next reconcile`);
      return;
    }
    // Canonical prepay coverage (Codex P0 → PR r19 P1): a covered
    // annual-prepay term WAIVES the setup fee estate-wide, but each
    // alerted VISIT is covered only per the canonical
    // annualPrepayCoversVisit gate — an unallocated visit keeps its
    // application follow-up. The waiver rides the normal flow as
    // feeWaivedByTerm; visit coverage joins the per-visit predicates.
    const AnnualPrepayCoverage = require('./annual-prepay-renewals');
    const coveredTermStanding = await AnnualPrepayCoverage.coveredTermsAsOf(trx, null)
      .where('t.source_estimate_id', sourceEstimateId)
      .first('t.id');
    const feeWaivedByTerm = !!coveredTermStanding;
    const annualCoversVisitId = async (visitId) => {
      if (!feeWaivedByTerm || !visitId) return false;
      try {
        const visitRow = await trx('scheduled_services').where({ id: visitId }).first();
        return !!(visitRow && await AnnualPrepayCoverage.annualPrepayCoversVisit(visitRow, trx));
      } catch { return false; }
    };
          // RESOLVED rows are reconciled too (Codex P0, pre-push round
          // 18): if the fee's covering invoice is later voided while the
          // application invoice stays live, the resolved alert is the
          // only durable follow-up left — it must REOPEN with the
          // uncovered charge, never stay settled forever.
          const staleAlert = await trx('notifications')
            .where({ recipient_type: 'admin' })
            .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
            .first('id', 'metadata');
          // Terminal-lane alerts that carry the fee note register under
          // setupFeeDedupeKey (Codex PR r13 P1) — they are reconciled in
          // the terminal pass below even when no estate alert exists.
          const terminalFeeAlerts = await trx('notifications')
            .where({ recipient_type: 'admin' })
            .whereRaw("metadata->>'setupFeeDedupeKey' = ?", [dedupeKey])
            .select('id', 'body', 'metadata');
          const reconcileTerminalFeeAlerts = async (feeIsProven) => {
            for (const row of terminalFeeAlerts) {
              const meta = typeof row.metadata === 'string'
                ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })()
                : row.metadata;
              const wasFeeResolved = meta?.setupFeeResolved === true;
              if (feeIsProven && !wasFeeResolved) {
                const strippedBody = String(row.body || '')
                  .replace(/ ALSO: the one-time WaveGuard setup fee[\s\S]*$/, ' UPDATE: the one-time setup fee is now COVERED by a live invoice — do NOT bill it.');
                await trx('notifications').where({ id: row.id }).update({
                  body: strippedBody,
                  read_at: null,
                  metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ setupFeeResolved: true })]),
                });
                logger.warn(`[setup-fee-reconcile]${actorLabel} terminal alert ${row.id} fee clause retired — fee coverage proven`);
              } else if (!feeIsProven && wasFeeResolved) {
                // Symmetric REOPEN (Codex PR r14 P1): the covering fee
                // invoice was voided/edited away — restore the fee
                // instruction instead of leaving a false "covered".
                const expectCents = Number(meta?.expectedSetupFeeCents);
                const feeAmt = Number.isFinite(expectCents) && expectCents > 0
                  ? `$${(expectCents / 100).toFixed(2)}` : 'the accepted amount';
                const restoredBody = String(row.body || '')
                  .replace(/ UPDATE: the one-time setup fee is now COVERED[\s\S]*$/, '')
                  + ` ALSO: the one-time WaveGuard setup fee (${feeAmt}) is OWED AGAIN — its covering invoice is no longer live. Bill it using the EXACT line description "WaveGuard Membership — one-time setup fee" and include "accepted estimate #${meta?.sourceEstimateId || sourceEstimateId}" in the invoice notes.`;
                await trx('notifications').where({ id: row.id }).update({
                  body: restoredBody,
                  read_at: null,
                  metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ setupFeeResolved: false })]),
                });
                logger.warn(`[setup-fee-reconcile]${actorLabel} terminal alert ${row.id} fee clause REOPENED — coverage regressed`);
              }
            }
          };
          if (!staleAlert && !terminalFeeAlerts.length) return;
          if (!staleAlert) {
            // TERMINAL-ONLY pass: no estate alert stands — prove fee
            // coverage compactly (stamped rows + each terminal visit's
            // own rows, refunded doctrine included) and retire the fee
            // clauses when it stands.
            const {
              invoiceHasPositiveSetupFeeLine: tFeeLine,
              sumPositiveSetupFeeCents: tFeeCents,
            } = require('./estimate-first-application-invoice');
            const tDead = new Set([...require('./invoice').CANCELLED_SERVICE_RESOLVED_STATUSES, 'void']);
            const tMeta0 = typeof terminalFeeAlerts[0].metadata === 'string'
              ? (() => { try { return JSON.parse(terminalFeeAlerts[0].metadata); } catch { return null; } })()
              : terminalFeeAlerts[0].metadata;
            const tCustomer = tMeta0?.customerId || customerId;
            if (String(tCustomer) !== String(customerId)) return;
            const tStamped = await trx('invoices')
              .where({ customer_id: tCustomer })
              .where('notes', 'like', `%accepted estimate #${sourceEstimateId}%`)
              .forUpdate()
              .select('id', 'status', 'line_items', 'notes');
            const tVisitIds = [...new Set(terminalFeeAlerts.map((row) => {
              const m = typeof row.metadata === 'string'
                ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })()
                : row.metadata;
              return m?.scheduledServiceId ? String(m.scheduledServiceId) : null;
            }).filter(Boolean))];
            const tRecords = tVisitIds.length
              ? await trx('service_records')
                .whereIn('scheduled_service_id', tVisitIds)
                .select('id')
              : [];
            const tRecordIds = tRecords.map((r) => r.id);
            const tOnVisit = tVisitIds.length
              ? await trx('invoices')
                .where({ customer_id: tCustomer })
                .where(function tLinked() {
                  this.whereIn('scheduled_service_id', tVisitIds);
                  if (tRecordIds.length) this.orWhereIn('service_record_id', tRecordIds);
                })
                .forUpdate()
                .select('id', 'status', 'line_items', 'notes')
              : [];
            const tRows = [...new Map([...tStamped, ...tOnVisit].map((r) => [String(r.id), r])).values()];
            const tRefundedFeeCents = tRows
              .filter((r) => String(r.status || '').toLowerCase() === 'refunded')
              .reduce((sum, r) => sum + tFeeCents(r), 0);
            const tLiveFeeCents = tRows
              .filter((r) => !tDead.has(String(r.status || '').toLowerCase()))
              .reduce((sum, r) => sum + tFeeCents(r), 0);
            const tExpect = Math.max(0, ...terminalFeeAlerts.map((row) => {
              const m = typeof row.metadata === 'string'
                ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })()
                : row.metadata;
              const v = Number(m?.expectedSetupFeeCents);
              return Number.isFinite(v) ? v : 0;
            }));
            const tFeeProven = feeWaivedByTerm || (tExpect > 0
              ? (tLiveFeeCents + tRefundedFeeCents) >= tExpect
              : tRefundedFeeCents > 0);
            await reconcileTerminalFeeAlerts(tFeeProven);
            return;
          }
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
          const stampedAll = await trx('invoices')
            .where({ customer_id: scanCustomerId })
            .where('notes', 'like', `%accepted estimate #${sourceEstimateId}%`)
            .forUpdate()
            .select('id', 'status', 'line_items', 'notes');
          const stampedLive = stampedAll
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
          // Every coverage scan is scoped to the ALERT's customer (Codex
          // PR r7 P1): a parked visit later re-linked to another customer
          // carries that customer's invoices, and the daily sweep (which
          // runs AS the persisted customer) must never let them resolve
          // this customer's charges.
          const onParkedAll = parkedIds.length
            ? await trx('invoices')
              .where({ customer_id: scanCustomerId })
              .where((qb) => {
                qb.whereIn('scheduled_service_id', parkedIds);
                if (staleMeta?.serviceRecordId) qb.orWhere({ service_record_id: staleMeta.serviceRecordId });
              })
              .forUpdate()
              .select('id', 'status', 'line_items', 'notes', 'scheduled_service_id', 'service_record_id')
            : [];
          const onParkedLive = onParkedAll
            .filter((r) => !deadAway.has(String(r.status || '').toLowerCase()));
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
            ? await trx('scheduled_services')
              .whereIn('id', parkedIds)
              .where({ customer_id: scanCustomerId })
              .select('id', 'prepaid_amount', 'prepaid_method', 'estimated_price')
            : [];
          // FULL coverage only (Codex P0): the completion guard requires
          // prepaid_amount >= the visit charge — a partial prepayment must
          // not prove the application billed. Cents compare against the
          // row's own estimated_price; an unknown price proves nothing.
          const cents = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
          const prepaidCoveredIds = new Set(prepaidParkedRows
            .filter((r) => {
              const paid = cents(r.prepaid_amount);
              const priceDue = cents(r.estimated_price);
              return paid !== null && paid > 0 && priceDue !== null && priceDue > 0
                && paid >= priceDue
                && r.prepaid_method !== AnnualPrepayRenewalsReconcile.ANNUAL_PREPAY_PREPAID_METHOD;
            })
            .map((r) => String(r.id)));
          // A REFUNDED fee-carrying invoice is fee-RESOLUTION evidence,
          // never a reopened debt (mirrors setup-fee-obligation's rule —
          // Codex P0, final round): the refund is a deliberate money
          // action, refund.failed can restore the payment, and there is
          // no refund-event clock — re-instructing the fee risks double
          // collection. Application coverage stays live-rows-only.
          // CENTS-EXACT coverage against the FROZEN expected amounts the
          // alert persisted at parking time (Codex PR r7 P1): a $9.90
          // typo must not retire a $99 obligation. Alerts without the
          // persisted amounts (none exist pre-gate) keep the boolean
          // positive-line behavior.
          const { sumPositiveSetupFeeCents, sumBaseApplicationCents } = require('./estimate-first-application-invoice');
          const refundedFeeCents = [...new Map(
            [...stampedAll, ...onParkedAll].map((r) => [String(r.id), r]),
          ).values()]
            .filter((r) => String(r.status || '').toLowerCase() === 'refunded')
            .reduce((sum, r) => sum + sumPositiveSetupFeeCents(r), 0);
          const expectedFeeCents = Number.isFinite(Number(staleMeta?.expectedSetupFeeCents))
            ? Number(staleMeta.expectedSetupFeeCents) : null;
          // Deduped by invoice id (Codex P0): a stamped invoice attached
          // to a parked visit appears in BOTH scans — counting its fee
          // line twice would let $49.50 satisfy a $99 expectation.
          const uniqueLiveRows = [...new Map(
            [...stampedLive, ...onParkedLive].map((r) => [String(r.id), r]),
          ).values()];
          const liveFeeCents = uniqueLiveRows
            .reduce((sum, r) => sum + sumPositiveSetupFeeCents(r), 0);
          // Refunded fee cents CREDIT the obligation (never re-billed —
          // the no-rebill doctrine holds for the amount actually
          // refunded), but only full coverage resolves (Codex P0): a
          // $9.90 partial refund leaves the remainder owed.
          // A covered annual-prepay term WAIVES the fee estate-wide
          // (Codex P0) — the estate alert must never instruct a waived
          // $99 while the term stands.
          const feeProven = feeWaivedByTerm
            || (expectedFeeCents !== null
              ? (liveFeeCents + refundedFeeCents) >= expectedFeeCents
              : (refundedFeeCents > 0 || uniqueLiveRows.some(invoiceHasPositiveSetupFeeLine)));
          await reconcileTerminalFeeAlerts(feeProven);
          const expectedAppCents = (visitId) => {
            const map = staleMeta?.expectedApplicationCentsByVisit;
            const v = map && Number(map[String(visitId)]);
            return Number.isFinite(v) && v > 0 ? v : null;
          };
          const primaryVisitId = String(staleMeta?.scheduledServiceId || '');
          // Only the durable base-application identity counts (Codex P0,
          // round 18 — visit linkage alone is insufficient money
          // evidence), and coverage is CENTS-EXACT against the persisted
          // expected amount when one exists (Codex PR r7 P1).
          const rowsForVisit = (visitId) => onParkedLive.filter((r) => (
            String(r.scheduled_service_id || '') === String(visitId)
            || (String(visitId) === primaryVisitId
              && staleMeta?.serviceRecordId
              && String(r.service_record_id || '') === String(staleMeta.serviceRecordId))
          ));
          const visitApplicationBilled = (visitId) => {
            const rows = rowsForVisit(visitId);
            const expect = expectedAppCents(visitId);
            if (expect === null) return rows.some(invoiceBillsBaseApplication);
            return rows.reduce((sum, r) => sum + sumBaseApplicationCents(r), 0) >= expect;
          };
          // All four coverage states rewrite the alert (Codex P0,
          // pre-push round 17): once staff bills ONE charge, the original
          // "bill BOTH" instruction must shrink to only what is still
          // uncovered — a stale instruction on a covered charge is a
          // duplicate-collection script. Neither-covered leaves the
          // original instruction standing.
          const wasResolved = staleMeta?.resolvedCovered === true || staleMeta?.resolvedCovered === 'true';
          // Per-visit coverage, tracked individually (Codex PR r6 P1): a
          // cross-visit race can park several visits, and staff may bill
          // them one at a time — every rewritten instruction lists ONLY
          // the still-uncovered visits, never a covered one.
          // ONE invoice covers ONE visit (Codex P0): an invoice attached
          // to a secondary parked visit already counts there via
          // visitApplicationBilled — only UNATTACHED acceptance invoices
          // may provide the primary-visit fallback, or a single charge
          // resolves two applications and loses AR.
          const attachedRowIds = new Set(onParkedAll.map((r) => String(r.id)));
          const stampedUnattached = stampedLive.filter((r) => !attachedRowIds.has(String(r.id)));
          const stampedAppCents = stampedUnattached.reduce((sum, r) => sum + sumBaseApplicationCents(r), 0);
          const stampedCoversPrimary = (visitId) => {
            if (String(visitId) !== primaryVisitId) return false;
            const expect = expectedAppCents(visitId);
            return expect === null
              ? stampedUnattached.some(invoiceBillsBaseApplication)
              : stampedAppCents >= expect;
          };
          const annualCoveredIds = new Set();
          if (feeWaivedByTerm) {
            for (const visitId of parkedIds) {
               
              if (await annualCoversVisitId(visitId)) annualCoveredIds.add(String(visitId));
            }
          }
          const visitCovered = (visitId) => (visitApplicationBilled(visitId)
            || prepaidCoveredIds.has(String(visitId))
            || annualCoveredIds.has(String(visitId))
            || stampedCoversPrimary(visitId));
          const uncoveredIds = parkedIds.filter((visitId) => !visitCovered(visitId));
          // FEE-ONLY alerts (historic leaks) REVALIDATE the historical
          // application coverage too (Codex PR r8 P1 → r14 P1): if the
          // prior visit's application invoice is later voided/edited
          // away, the alert must list it again instead of resolving on
          // the fee alone.
          const feeOnlyAlert = staleMeta?.feeOnly === true;
          let feeOnlyUncoveredIds = [];
          if (feeOnlyAlert) {
            // ONLY the persisted billed visits are revalidated (Codex P0):
            // a completed inspection_only/declined visit never billed an
            // application and must never be instructed. Legacy alerts
            // without the list skip application revalidation entirely.
            const histPlanIds = Array.isArray(staleMeta?.historicVisitIds)
              ? staleMeta.historicVisitIds.map(String)
              : [];
            if (histPlanIds.length) {
              const histRecords = await trx('service_records')
                .whereIn('scheduled_service_id', histPlanIds)
                .select('id', 'scheduled_service_id');
              const recordToVisit = new Map(histRecords.map((r) => [String(r.id), String(r.scheduled_service_id)]));
              const histRecordIds = histRecords.map((r) => r.id);
              const histBilled = (await trx('invoices')
                .where({ customer_id: scanCustomerId })
                .where(function histLinked() {
                  this.whereIn('scheduled_service_id', histPlanIds);
                  if (histRecordIds.length) this.orWhereIn('service_record_id', histRecordIds);
                })
                .forUpdate()
                .select('id', 'status', 'line_items', 'notes', 'scheduled_service_id', 'service_record_id'))
                .filter((r) => !deadAway.has(String(r.status || '').toLowerCase()));
              // Full out-of-band prepayment covers a historic visit too
              // (Codex P0) — same predicate as the parked-visit path:
              // cents vs the row's own price, never the annual stamp.
              const histPrepaidRows = await trx('scheduled_services')
                .whereIn('id', histPlanIds)
                .where({ customer_id: scanCustomerId })
                .select('id', 'prepaid_amount', 'prepaid_method', 'estimated_price');
              const histPriceCents = new Map(histPrepaidRows.map((r) => {
                const n = Number(r.estimated_price);
                return [String(r.id), Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null];
              }));
              const histCents = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
              const histPrepaidOk = new Set(histPrepaidRows
                .filter((r) => {
                  const paid = histCents(r.prepaid_amount);
                  const priceDue = histCents(r.estimated_price);
                  return paid !== null && paid > 0 && priceDue !== null && priceDue > 0
                    && paid >= priceDue
                    && r.prepaid_method !== AnnualPrepayRenewalsReconcile.ANNUAL_PREPAY_PREPAID_METHOD;
                })
                .map((r) => String(r.id)));
              // Record-linked invoices map back to their visit (Codex P0):
              // an application invoice attached only through its service
              // record is coverage for that visit, not perpetual debt.
              // FULL cents coverage per visit (Codex PR r19 P1), boolean
              // only when the row carries no price.
              const histAnnualOk = new Set();
              if (feeWaivedByTerm) {
                for (const visitId of histPlanIds) {
                   
                  if (await annualCoversVisitId(visitId)) histAnnualOk.add(String(visitId));
                }
              }
              feeOnlyUncoveredIds = histPlanIds.filter((visitId) => {
                if (histPrepaidOk.has(String(visitId))) return false;
                if (histAnnualOk.has(String(visitId))) return false;
                const rowsFor = histBilled.filter((r) => (
                  String(r.scheduled_service_id || '') === String(visitId)
                  || recordToVisit.get(String(r.service_record_id || '')) === String(visitId)));
                const expect = histPriceCents.get(String(visitId));
                if (expect === null || expect === undefined) return !rowsFor.some(invoiceBillsBaseApplication);
                return rowsFor.reduce((sum, r) => sum + sumBaseApplicationCents(r), 0) < expect;
              });
            }
          }
          const applicationProven = feeOnlyAlert
            ? feeOnlyUncoveredIds.length === 0
            : (parkedIds.length > 0 && uncoveredIds.length === 0);
          const effectiveUncoveredIds = feeOnlyAlert ? feeOnlyUncoveredIds : uncoveredIds;
          const priorUncovered = Array.isArray(staleMeta?.uncoveredVisitIds)
            ? staleMeta.uncoveredVisitIds.map(String).sort().join(',')
            : null;
          const feeInstruction = `the one-time WaveGuard setup fee — use the EXACT line description "WaveGuard Membership — one-time setup fee"`;
          const appInstruction = (ids) => `the application charge for visit${ids.length === 1 ? '' : 's'} ${ids.join(', ')} — use the EXACT line description "First service application"`;
          if (feeProven && applicationProven) {
            if (wasResolved) return; // already settled — idempotent
            await trx('notifications').where({ id: staleAlert.id }).update({
              body: `RESOLVED — no action needed: live invoices now cover BOTH the one-time setup fee and every parked visit's application charge for this estimate. The earlier manual-billing instruction no longer applies; do NOT bill again on this alert.`,
              // Nothing left to act on — never a false unread billing badge.
              read_at: trx.fn.now(),
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: true })]),
            });
            logger.warn(`[setup-fee-reconcile]${actorLabel} stale unminted-setup-fee alert ${staleAlert.id} rewritten as resolved — fee and application coverage both proven`);
          } else if (feeProven) {
            await trx('notifications').where({ id: staleAlert.id }).update({
              body: `UPDATE: the one-time setup fee for this estimate is now COVERED by a live invoice — do NOT bill the setup fee again. Still owed: ${appInstruction(effectiveUncoveredIds)}, and include "accepted estimate #${sourceEstimateId}" in the invoice notes so the system recognizes it as billed. Do NOT re-bill any other visit.`,
              read_at: null,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: false, feeCovered: true, applicationCovered: false, uncoveredVisitIds: effectiveUncoveredIds })]),
            });
            logger.warn(`[setup-fee-reconcile]${actorLabel} unminted-setup-fee alert ${staleAlert.id} rewritten — fee covered, ${uncoveredIds.length} application(s) still owed`);
          } else if (applicationProven) {
            await trx('notifications').where({ id: staleAlert.id }).update({
              body: `UPDATE: every parked visit's application charge for this estimate is now COVERED — do NOT bill an application again. Still owed: ${feeInstruction}, and include "accepted estimate #${sourceEstimateId}" in the invoice notes so the system recognizes it as billed.`,
              read_at: null,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: false, applicationCovered: true, feeCovered: false, uncoveredVisitIds: [] })]),
            });
            logger.warn(`[setup-fee-reconcile]${actorLabel} unminted-setup-fee alert ${staleAlert.id} rewritten — application(s) covered, fee still owed`);
          } else if (wasResolved || staleMeta?.feeCovered === true || staleMeta?.applicationCovered === true
            || (uncoveredIds.length < parkedIds.length)
            || (priorUncovered !== null && priorUncovered !== uncoveredIds.map(String).sort().join(','))) {
            // Fee uncovered; applications partially covered (or coverage
            // regressed after a resolved/partial state) — the instruction
            // lists exactly the still-owed charges, excluding every
            // already-covered application (Codex PR r6 P1).
            const appClause = effectiveUncoveredIds.length
              ? ` plus ${appInstruction(effectiveUncoveredIds)}`
              : '';
            await trx('notifications').where({ id: staleAlert.id }).update({
              body: `UPDATE: still owed for this estimate: ${feeInstruction}${appClause}. Include "accepted estimate #${sourceEstimateId}" in the invoice notes so the system recognizes the charges as billed. Do NOT re-bill any covered visit.`,
              read_at: null,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: false, feeCovered: false, applicationCovered: false, uncoveredVisitIds: effectiveUncoveredIds })]),
            });
            logger.warn(`[setup-fee-reconcile]${actorLabel} unminted-setup-fee alert ${staleAlert.id} rewritten — fee owed, ${uncoveredIds.length}/${parkedIds.length} application(s) still owed`);
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
    let linkedVisitId = invoice.scheduled_service_id || null;
    if (!linkedVisitId && invoice.service_record_id) {
      // Record-only linkage resolves through service_records (Codex PR
      // r18 P2) — an edited historical invoice with no stamp and no
      // direct visit link must still find its estimate.
      const sr = await db('service_records')
        .where({ id: invoice.service_record_id })
        .first('scheduled_service_id');
      linkedVisitId = sr?.scheduled_service_id || null;
    }
    if (!estimateId && linkedVisitId) {
      const ss = await db('scheduled_services')
        .where({ id: linkedVisitId })
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
    .where(function sweepKeys() {
      this.whereRaw("metadata->>'dedupeKey' LIKE 'unminted_setup_fee_manual_billing:%'")
        .orWhereRaw("metadata->>'setupFeeDedupeKey' LIKE 'unminted_setup_fee_manual_billing:%'");
    })
    .select('id', 'metadata');
  for (const row of rows) {
    try {
      const meta = typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : (row.metadata || {});
      const feeKey = String(meta?.setupFeeDedupeKey || meta?.dedupeKey || '');
      const estimateId = feeKey.startsWith('unminted_setup_fee_manual_billing:')
        ? feeKey.split(':')[1] || null : null;
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
