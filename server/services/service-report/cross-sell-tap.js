/**
 * The cross-sell card's TAP, shared by every customer surface that renders
 * it (service report, invoice receipt, tracker). Moved out of
 * routes/reports-public.js unchanged when the card spread past the report
 * (owner 2026-11-21): the offer is recomputed server-side from the service
 * record, matched against what the customer saw (fingerprint, family, mode,
 * option, and the per-application price to the cent), recorded as ONE open
 * service_requests row per customer + service across every surface, and —
 * with GATE_REPORT_CLICK_TO_ESTIMATE on and a priced offer — minted into a
 * viewable estimate the card redirects to. No customer message is sent;
 * the office gets the bundle_quote_requested bell.
 *
 * Each surface passes its own `surface` descriptor: `source` (the
 * service_requests.source value, one of CTA_REQUEST_SOURCES), `noun` (the
 * page named in the customer-facing "please refresh the …" error) and
 * `title` (the page named in the staff-facing subject and description).
 * Returns { status, body } for the route to send.
 */
const logger = require('../logger');
const { stampedLine2Sql } = require('../stamped-address');
const { writeOrRefreshCtaRequest } = require('../cta-service-request');
const { reserviceReportCopyGateOn } = require('./reservice-report');

// The service-record shape buildReportCrossSell prices from. A surface
// that RENDERS the card from this row and then TAPS through
// handleCrossSellTap prices both sides from one query, so the fingerprint
// the customer saw is the one the tap recomputes.
function loadCrossSellService(db, serviceRecordId) {
  return db('service_records as sr')
    .leftJoin('customers as c', 'sr.customer_id', 'c.id')
    .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
    .where('sr.id', serviceRecordId)
    .select(
      // scheduled_service_id rides along so the click-path recompute
      // classifies the report by its catalog identity exactly like
      // the read path (codex #3367 PR r4) — omitting it made every
      // valid click 409 whenever the catalog reclassified stale text.
      'sr.id', 'sr.customer_id', 'sr.service_type', 'sr.scheduled_service_id', 'sr.is_callback',
      // service_date/created_at feed the historical-report recency
      // gate (PR r9) — the click path must classify identically.
      'sr.service_date', 'sr.created_at',
      db.raw('COALESCE(ss.service_address_line1, c.address_line1) as address_line1'),
      db.raw(`${stampedLine2Sql('ss', 'c')} as address_line2`),
      db.raw('COALESCE(ss.service_address_city, c.city) as city'),
      db.raw('COALESCE(ss.service_address_zip, c.zip) as zip'),
      'c.first_name', 'c.last_name',
    )
    .first();
}

// Who may see the cards on a link-based surface (receipt, tracker): only a
// link that reaches the account holder alone. Those links can also go to
// the account's service contacts (tenant, home buyer, property manager) or
// to a third-party payer, who must never start the homeowner's plan or
// enroll as the homeowner's promoter. `row` carries the customer's service
// contact columns (SERVICE_CONTACT_COLUMNS) and any payer ids.
function linkReachesOnlyAccountHolder(row, payerIds = []) {
  if (!row || payerIds.some(Boolean)) return false;
  const { getServiceContactSlots } = require('../customer-contact');
  return !getServiceContactSlots(row).some((slot) => slot.phone || slot.email);
}

// The card a non-report surface renders for a visit: the report's own
// composer over the same row the tap recomputes from, with the report's
// complaint-visit suppression (owner 2026-08-30: no upsell after a
// callback) applied here so every surface inherits it. Best-effort like the
// report: null on any failure.
async function buildCrossSellForServiceRecord(db, serviceRecordId) {
  try {
    const service = await loadCrossSellService(db, serviceRecordId);
    if (!service?.customer_id) return null;
    if (reserviceReportCopyGateOn() && service.is_callback === true) return null;
    return await require('./cross-sell').buildReportCrossSell(service, db);
  } catch (err) {
    logger.warn(`[cross-sell-tap] card suppressed (code=${err?.code || 'none'})`);
    return null;
  }
}

async function handleCrossSellTap({ db, serviceRecordId, metadata = {}, surface, recordEvent = null }) {
  try {
    const joined = await loadCrossSellService(db, serviceRecordId);
    const { buildReportCrossSell } = require('./cross-sell');
    // Click-to-estimate (GATE_REPORT_CLICK_TO_ESTIMATE, inert without the
    // parent card gate that already guarded this event): a priced tap
    // mints a viewable estimate at the shown price inside the SAME
    // transaction as the request row. Gate off → includeEngineContext is
    // false and this block behaves byte-for-byte as today.
    const clickToEstimate = require('../../config/feature-gates').isEnabled('reportClickToEstimate');
    const crossSell = joined?.customer_id
      ? await buildReportCrossSell(joined, db, { includeEngineContext: clickToEstimate })
      : null;
    // The recomputed offer must MATCH what the customer clicked (codex
    // #3367 r6 P1): a vanished offer, a different target family, or a
    // shown per-application price that no longer holds (>1% drift) all
    // reject — the card fails visibly instead of confirming a request
    // for something the customer never saw. Client metadata is only
    // COMPARED against server truth here, never persisted as the offer.
    const clickedKey = String(metadata.serviceKey || '').trim();
    const clickedMode = String(metadata.offerMode || '').trim();
    // STRICT type check before any numeric handling (AGENTS.md
    // report-token rule; local codex r11): Number() coerces '', null,
    // false, and [] to 0, which slipped malformed bodies through the
    // quote-mode branch. A priced click must carry an actual finite
    // positive number; a quote click must carry null/absent — the
    // exact shapes the card emits.
    const rawPer = metadata.perApplication;
    const clickedPer = typeof rawPer === 'number' && Number.isFinite(rawPer) ? rawPer : null;
    const serverPer = Number(crossSell?.option?.perVisit);
    // Key AND mode must match, and a priced offer must match to the
    // cent (codex #3367 r8: a quote-only card that became priced before
    // the click must not record "shown $X" the customer never saw; a
    // priced card whose price moved must re-render first).
    // The server-issued fingerprint covers every RENDERED field
    // (relationship, label, cadence, tier included — pre-push P1), so
    // any drift between what the customer saw and what the server now
    // computes rejects, not just key/mode/price/option drift.
    const clickedPrint = String(metadata.fingerprint || '').trim();
    // Callback reports no longer render offer cards (owner 2026-08-30):
    // a card retained by a page opened before this deploy/gate flip must
    // not act — same 409 the customer would get for any vanished offer
    // (codex P2 r4 on #3631).
    if (reserviceReportCopyGateOn() && joined?.is_callback === true) {
      return { status: 409, body: { error: `This offer is no longer available — please refresh the ${surface.noun}` } };
    }
    const offerMismatch = !crossSell
      || !clickedPrint || clickedPrint !== crossSell.fingerprint
      || !clickedKey || clickedKey !== crossSell.serviceKey
      || !clickedMode || clickedMode !== crossSell.mode
      || (crossSell.mode === 'priced'
        ? !(clickedPer !== null && clickedPer > 0
          && Number.isFinite(serverPer) && Math.abs(clickedPer - serverPer) < 0.005
          // The clicked OPTION must be the recomputed option too
          // (pre-push codex r11 P1): a preferred-variant change that
          // happens to keep the same per-application price must not
          // snapshot a different cadence/tier than the customer saw.
          && String(metadata.optionId || '') === String(crossSell.option?.id || ''))
        : !(rawPer === null || rawPer === undefined));
    if (offerMismatch) {
      return { status: 409, body: { error: `This offer is no longer available — please refresh the ${surface.noun}` } };
    }
    {
      const { normalizeRequestedServiceKey } = require('../estimate-add-service-request');
      const requestedService = normalizeRequestedServiceKey(crossSell.serviceKey) || crossSell.serviceKey;
      const perApplication = Number(crossSell.option?.perVisit);
      const priceText = Number.isFinite(perApplication) && perApplication > 0
        ? `(shown $${perApplication.toFixed(2)} per application on ${surface.noun})`
        : '(quote requested from report)';
      // One server-computed subject for insert AND dedupe refresh
      // (codex #3367 PR r3): if ownership changed since the original
      // request (start → add) while the ladder target held, the reused
      // row's subject must match the newly validated snapshot too.
      const requestSubject = `${crossSell.relationship === 'start' ? 'Start' : 'Add'} ${crossSell.label} — requested from ${surface.title}`;
      // One server-computed snapshot for insert, dedupe compare, AND the
      // refresh update — the three must never drift apart.
      // engineContext is STRIPPED first (click-to-estimate lane): it is
      // server-internal mint material carrying raw engine inputs and the
      // live customer row, whose incidental fields (updated_at) move
      // between taps — embedding it would turn every identical tap into
      // a "material refresh" (bell churn + a superseded estimate per
      // tap), and its presence would also flip on the gate state.
      const { engineContext: _mintContext, ...publicCrossSell } = crossSell;
      const revisionSnapshot = { source: surface.source, serviceRecordId, crossSell: publicCrossSell };
      // Shared CTA writer (one mechanism with the portal home CTA — the
      // open-row lookup spans both sources so the same service tapped on
      // two surfaces refreshes one row instead of minting two). The
      // event row commits WITH the request row via onWrite — one
      // transaction, so analytics can never claim a request that has no
      // actionable record; the identical-resubmission no-op records no
      // extra event (local codex r15 P1).
      // Mint hook (click-to-estimate): runs on EVERY writer outcome —
      // dedupe included, because a repeat tap must hand back the same
      // live estimate URL — inside the writer's transaction, so the
      // estimate, the request row, and the event commit or roll back
      // together. A missing engineContext on a priced offer (composer
      // degradation) simply keeps today's request-only flow.
      let mintedEstimate = null;
      const mintEligible = clickToEstimate && crossSell.mode === 'priced' && !!crossSell.engineContext;
      const outcome = await writeOrRefreshCtaRequest(db, {
        customerId: joined.customer_id,
        requestedService,
        source: surface.source,
        subject: requestSubject,
        description: `Customer tapped "${crossSell.label}" on their ${surface.title} ${priceText}. Review and follow up — no customer message has been sent.`,
        revisionSnapshot,
        ...(recordEvent ? {
          onWrite: async (trx) => {
            const recorded = await recordEvent(trx);
            if (!recorded) throw new Error('event insert failed');
          },
        } : {}),
        ...(mintEligible ? {
          withRow: async (trx, { row, deduped }) => {
            const { mintReportClickEstimate } = require('./click-estimate-mint');
            // Prior-mint lineage is resolved DURABLY inside the mint
            // (estimates query under lock) — the request row's
            // pricing_revision pointer is advisory display linkage only.
            mintedEstimate = await mintReportClickEstimate(trx, {
              customer: crossSell.engineContext.customer,
              // The full service-record row, as the report route passed
              // before the move (the mint reads service.id today).
              service: joined,
              crossSell,
              requestRow: row,
              deduped,
              revisionSnapshot,
            });
          },
        } : {}),
      });
      // acceptedReuse (GitHub #3391 round P1): acceptance already
      // resolved the original request, so this tap's fresh row arrives
      // deduped=false — but the mint found the ACCEPTED fingerprint and
      // resolved the fresh row too. The work is booked; paging staff to
      // follow up on it is the exact noise the accept-path resolution
      // exists to prevent.
      // Send-time pricing snapshot for click-mints (estimator audit
      // M4): the mint stamps status='sent' inside its transaction but
      // never wrote an audit snapshot. AFTER commit (the trx above is
      // closed once outcome exists) and fail-soft — analytics never
      // unwind a minted offer.
      if (mintedEstimate?.estimateId) {
        try {
          const { saveEstimatePricingAuditSnapshot, getLatestEstimatePricingAuditSnapshot } = require('../estimate-pricing-audit');
          // A REUSED live mint gets a recovery snapshot only when none
          // exists (pre-change mints, or a transient failure on the
          // original attempt) — fresh mints always snapshot (GH codex
          // P2). Both fail-soft.
          const existing = mintedEstimate.reused
            ? await getLatestEstimatePricingAuditSnapshot(mintedEstimate.estimateId)
            : null;
          if (!mintedEstimate.reused || !existing) {
            const mintedRow = await db('estimates').where({ id: mintedEstimate.estimateId }).first();
            // acceptedReuse also lands here — acceptance rewrites
            // result/totals, so a backfill from that row would mix
            // post-acceptance lines with the original sendSnapshot.
            // No snapshot beats an internally inconsistent one (GH
            // codex P2).
            if (mintedEstimate.reused && mintedRow
              && (mintedRow.status === 'accepted' || mintedRow.price_locked_at)) {
              throw Object.assign(new Error('skip: accepted reuse — no send-time state to backfill'), { skipBackfill: true });
            }
            // A recovery row for an OLD reused mint quotes the persisted
            // send-time prices but costs them with TODAY's inventory —
            // the distinct trigger keeps it from masquerading as a
            // mint-time record (codex pre-push P1).
            if (mintedRow) {
              await saveEstimatePricingAuditSnapshot(mintedRow, {
                trigger: mintedEstimate.reused ? 'cta_reuse_backfill' : 'cta_mint',
              });
            }
          }
        } catch (auditErr) {
          if (!auditErr.skipBackfill) {
            logger.warn(`[cross-sell-tap] click-mint pricing audit snapshot failed (mint ${mintedEstimate.estimateId} stands): ${auditErr.message}`);
          }
        }
      }
      if (!outcome.deduped && !mintedEstimate?.acceptedReuse) {
        // Bell AFTER the durable row exists; a bell failure leaves the
        // row actionable in the Customer 360 requests panel either way.
        const { triggerNotification } = require('../notification-triggers');
        await triggerNotification('bundle_quote_requested', {
          bundled: false,
          customerId: joined.customer_id,
          customerName: `${joined.first_name || ''} ${joined.last_name || ''}`.trim() || null,
          suggestedService: [crossSell.label, priceText].join(' '),
          // Start-vs-add rides to the bell too (codex #3367 PR r3): the
          // builder's add-to-plan copy contradicts a start-plan request.
          relationship: crossSell.relationship,
          // Distinguishes "the terms on an open request just changed"
          // from a first-time inquiry (codex #3367 PR r12).
          refreshed: !!outcome.refreshed,
          // The request row this bell is about.
          ...(outcome.request?.id ? { requestId: outcome.request.id } : {}),
        }).catch((err) => {
          logger.warn(`[cross-sell-tap] cross-sell bell failed (request ${outcome.request?.id} stands): ${err.message}`);
        });
      }
      // The estimate URL rides the confirmation response so the card can
      // redirect straight into the estimate page. Only present when the
      // mint (or reuse) actually committed — everything durable happened
      // in the transaction above, so this response can never promise a
      // link that doesn't exist.
      return { status: 200, body: { ok: true, ...(mintedEstimate ? { estimateUrl: mintedEstimate.url } : {}) } };
    }
  } catch (err) {
    // A mint whose recomputed price no longer matches the card is the
    // same situation as the offer-fingerprint drift above: nothing was
    // persisted (the transaction rolled back), the card refreshes.
    if (err && err.clickEstimateDrift === true) {
      return { status: 409, body: { error: `This offer is no longer available — please refresh the ${surface.noun}` } };
    }
    // err.code preferred over message near constraint-bearing inserts
    // (PG quotes conflicting values — the estimates row carries customer
    // identity); non-PG errors have no code and keep their message.
    logger.warn(`[cross-sell-tap] cross-sell request creation failed: ${err.code || err.message}`);
    return { status: 503, body: { error: 'Could not record the request — please try again' } };
  }

}

module.exports = {
  handleCrossSellTap, loadCrossSellService, buildCrossSellForServiceRecord, linkReachesOnlyAccountHolder,
};
