/**
 * Estimate Auto-Renew
 *
 * Runs daily. For any estimate that:
 *   - is sent or viewed (customer engaged but hasn't accepted/declined)
 *   - has expires_at in the past
 *   - hasn't already been auto-renewed (renewal_count < 1)
 *
 * extend expires_at by 7 days, bump renewal_count, and notify the customer
 * by email so they know it's still good (the SMS leg was retired 2026-07-06).
 * We only auto-renew once —
 * if the customer still hasn't moved after the second 7-day window, the
 * estimate dies naturally and lead-follow-up picks up the relationship.
 */

const db = require('../models/db');
const EmailService = require('./email');
const EmailTemplateLibrary = require('./email-template-library');
const EmailTemplateAutomationExecutor = require('./email-template-automation-executor');
const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const { shortenOrPassthrough } = require('./short-url');
const { isEnabled } = require('../config/feature-gates');
const { estimateDeliverableUnderGate } = require('./pricing-authority-gate');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { smtpFallbackAllowed } = require('./email-fallback-gate');

const RENEWAL_DAYS = 7;
const { FIXED_BID_VALIDITY_ABSENT_SQL } = require('./proposal-bid');

function canFallbackFromTemplateEmailError(err) {
  return /relation .*email_templates.* does not exist|active template not found|template version not found|template not found/i.test(err?.message || '');
}

function canFallbackFromAutomationEmailError(err) {
  return /relation .*email_template_automation|automation .*not found|does not define an idempotency key|active template not found|template version not found|template not found/i.test(err?.message || '');
}

// estimate_data.noEngagementAutomation — the durable zero-comms opt-out
// stamped by publish-without-delivery mints (report click-to-estimate).
// Same key the engagement engine and legacy follow-up cron enforce;
// duplicated locally like theirs (shared-import would couple this sender's
// load order to those modules) and pinned in lockstep by
// estimate-followup-engagement-optout.test.js. A renewal here would both
// EXTEND the estimate and EMAIL the customer — the lane promises neither.
function estimateOptedOutOfAutoRenew(est) {
  try {
    const data = typeof est.estimate_data === 'string'
      ? JSON.parse(est.estimate_data)
      : est.estimate_data;
    return data?.noEngagementAutomation === true;
  } catch {
    return false;
  }
}

const EstimateAutoRenew = {
  async checkAll() {
    let renewed = 0;
    try {
      const stale = await db('estimates')
        .whereIn('status', ['sent', 'viewed'])
        // Archived rows keep sent/viewed status — renewing one would extend
        // and re-text an estimate whose customer already converted.
        .whereNull('archived_at')
        .whereNotNull('expires_at')
        .where('expires_at', '<', new Date())
        .where(q => q.where('renewal_count', '<', 1).orWhereNull('renewal_count'))
        .where(q => q.whereNotNull('customer_phone').orWhereNotNull('customer_email'));

      for (const est of stale) {
        try {
          if (estimateOptedOutOfAutoRenew(est)) continue;
          // A renewal is a silent group extension: the same group-wide fixed
          // hold verdict the generic extension applies (any live fixed
          // sibling, including one mid-send) refuses it here, or an ordinary
          // sibling would be renewed and emailed while the fixed property
          // drops out of the revived group link (pre-push codex P1 on #4309).
          const { fixedBidBlocksExtension } = require('./estimate-extension');
          if (await fixedBidBlocksExtension(db, est)) continue;
          // Engine-authoritative pricing gate (#3750, GH codex P1 r13): a
          // renewal re-emails the estimate link — never for a delivered row
          // the engine never verified while the gate is on. Not renewed
          // either: the operator re-saves it through the engine first.
          if (!(await estimateDeliverableUnderGate(db, est))) {
            logger.info(`[est-auto-renew] skip ${est.id}: pricing-authority-not-server`);
            continue;
          }
          const newExpiry = new Date(Date.now() + RENEWAL_DAYS * 86400000);
          const updated = await db.transaction(async (trx) => {
            // GH codex P2 r4 on #4309: `est` can be stale by the time this
            // transaction runs — moved into, out of, or between groups. Lock
            // and evaluate the row's CURRENT membership (not the outer
            // read's), then pin that same membership on the write below so a
            // membership change between the re-read and the update makes the
            // update match nothing rather than silently renewing (and
            // emailing) a now-grouped estimate a fixed sibling should block.
            // Lock ORDER matches proposal saves and grouped sends (group
            // advisory lock first, row lock second), so the membership is
            // peeked without a row lock, the group lock is taken, and only
            // then is the row locked and its membership confirmed.
            const peek = await trx('estimates').where({ id: est.id }).first('estimate_group_id');
            if (!peek) return 0;
            let current = peek;
            const currentGroupId = peek.estimate_group_id || null;
            if (currentGroupId) {
              // Same lock proposal saves, grouped sends and extensions take,
              // then the fixed verdict is re-read under it before writing.
              await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
                ['estimate-group-send', String(currentGroupId)]);
              current = await trx('estimates').where({ id: est.id }).forUpdate().first();
              if (!current || (current.estimate_group_id || null) !== currentGroupId) return 0;
              if (await fixedBidBlocksExtension(trx, current)) return 0;
            }
            // Delivery-guards slice (re-cut of #4569): the renewal UPDATE is
            // itself a handoff — it extends expires_at and (below) emails the
            // customer a link to an offer that may no longer be deliverable.
            // Reread and lock the row fresh under this same transaction right
            // before the write and skip the renewal entirely when withheld:
            // no expires_at/renewal_count advance, no email.
            //
            // Codex round 3 on #4608 (P1 PRRT_kwDOR3YQi86j8Ydo): the single-
            // row verdict missed a link-visible WITHHELD SIBLING — a non-
            // annual anchor whose group link also surfaces a withheld annual
            // sibling still got its token reactivated (and consumed its one
            // renewal_count). annualHandoffGuard itself expands to
            // link-visible group siblings (the SAME membership this group
            // lock above already establishes), so a block on ANY member —
            // anchor or sibling — now stops the anchor's renewal too. The
            // FOR UPDATE reread stays: it locks the anchor row fresh for the
            // UPDATE below; the guard's own (unlocked, by design — a
            // chokepoint recheck must never contend with this transaction's
            // own lock) reads run right after, on the same trx connection.
            const { loadAnnualOfferRow, annualHandoffGuard } = require('./estimate-annual-guard');
            await loadAnnualOfferRow(trx, est.id, { forUpdate: true });
            const guardVerdict = await annualHandoffGuard({ db: trx, estimateIds: [est.id] })();
            if (guardVerdict.blocked) return 0;
            return trx('estimates').where({ id: est.id })
              .whereRaw(FIXED_BID_VALIDITY_ABSENT_SQL)
              .modify((qb) => (currentGroupId
                ? qb.where({ estimate_group_id: currentGroupId })
                : qb.whereNull('estimate_group_id')))
              .update({
                expires_at: newExpiry,
                renewal_count: trx.raw('COALESCE(renewal_count, 0) + 1'),
              });
          });
          if (!updated) continue;

          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const longUrl = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          const url = await shortenOrPassthrough(longUrl, { kind: 'estimate', entityType: 'estimates', entityId: est.id, customerId: est.customer_id });
          // Customer SMS removed 2026-07-06 — the estimate_auto_renewed
          // template is retired; the renewal still extends expires_at and
          // notifies by email below.
          if (est.customer_email) {
            try {
              let sentWithTemplateLibrary = false;
              const formattedExpiry = newExpiry.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
              const extensionPayload = {
                estimate_id: est.id,
                customer_id: est.customer_id || '',
                customer_email: est.customer_email,
                first_name: firstName,
                estimate_url: url,
                new_expires_at: formattedExpiry,
                estimate_status: est.status,
                status: est.status,
                renewal_count: Number(est.renewal_count || 0) + 1,
              };
              if (sendgrid.isConfigured()) {
                try {
                  if (isEnabled('emailTemplateAutomations')) {
                    const result = await EmailTemplateAutomationExecutor.processTrigger({
                      triggerEventKey: 'estimate.auto_renewed',
                      triggerEventId: `estimate_auto_renew:${est.id}`,
                      entityType: 'estimate',
                      entityId: est.id,
                      recipient: {
                        email: est.customer_email,
                        type: est.customer_id ? 'customer' : 'lead',
                        id: est.customer_id || '',
                      },
                      payload: extensionPayload,
                      executeImmediately: true,
                    });
                    if (result.automation_count > 0) {
                      const statuses = result.results.map((r) => r.run?.status).filter(Boolean).join(', ') || 'queued';
                      logger.info(`[est-auto-renew] Email automation handled estimate ${est.id}: ${statuses}`);
                      sentWithTemplateLibrary = true;
                    }
                  }

                  if (!sentWithTemplateLibrary) {
                    const result = await EmailTemplateLibrary.sendTemplate({
                      templateKey: 'estimate.extension_notice',
                      to: est.customer_email,
                      payload: extensionPayload,
                      recipientType: est.customer_id ? 'customer' : 'lead',
                      recipientId: est.customer_id || null,
                      triggerEventId: `estimate_auto_renew:${est.id}`,
                      estimateId: est.id,
                      categories: ['estimate_auto_renew'],
                    });
                    if (result.blocked) {
                      logger.warn(`[est-auto-renew] Email suppressed for estimate ${est.id}: ${result.reason || 'suppressed'}`);
                      sentWithTemplateLibrary = true;
                    } else if (result.aborted) {
                      // Pre-push audit P1: a pre-dispatch abort (the annual
                      // guard's own lookup threw, most likely) is a real
                      // failure, never a handled/deduped outcome. It must NOT
                      // fall through to the raw SMTP fallback either — that
                      // path bypasses the guarded send library, so a guard
                      // outage would send the link unguarded (fail-open).
                      // Log it as a failure and stop; the direct path has no
                      // durable retry (deferred, see PR body).
                      logger.error(`[est-auto-renew] Email pre-dispatch abort for estimate ${est.id}: ${result.reason || 'aborted'}${result.error ? ` (${result.error})` : ''}`);
                      sentWithTemplateLibrary = true;
                    } else {
                      sentWithTemplateLibrary = true;
                    }
                  }
                } catch (e) {
                  if (!canFallbackFromTemplateEmailError(e) && !canFallbackFromAutomationEmailError(e)) throw e;
                  logger.warn(`[est-auto-renew] Template unavailable for estimate ${est.id}; falling back to SMTP: ${e.message}`);
                }
              }
              if (!sentWithTemplateLibrary) {
                if (!smtpFallbackAllowed()) {
                  logger.error(`[est-auto-renew] SMTP fallback disabled in production for estimate ${est.id} — SendGrid template send required`);
                } else {
                  // This raw SMTP send bypasses the guarded send library, so
                  // it carries the chokepoint verdict itself: fresh row, no
                  // lock, immediately before the provider call. Fails closed.
                  const { annualHandoffGuard } = require('./estimate-annual-guard');
                  const fallbackVerdict = await annualHandoffGuard({ db, estimateIds: [est.id] })();
                  if (fallbackVerdict.blocked) {
                    logger.warn(`[est-auto-renew] SMTP fallback withheld for estimate ${est.id}: ${fallbackVerdict.reason}`);
                    throw Object.assign(new Error('annual offer withheld at SMTP fallback'), { code: 'ANNUAL_OFFER_WITHHELD' });
                  }
                  await EmailService.send({
                    to: est.customer_email,
                    subject: 'Your Waves estimate was extended',
                    heading: `Hey ${firstName} — we extended your estimate`,
                    body: `<p>Your Waves Pest Control estimate was about to expire, so we went ahead and extended it by another few days. It's still good — take another look whenever you're ready.</p><p>Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.</p>`,
                    ctaUrl: url,
                    ctaLabel: 'View Your Estimate',
                  });
                }
              }
            } catch (e) { logger.error(`[est-auto-renew] Email failed: ${e.message}`); }
          }

          renewed++;
        } catch (e) { logger.error(`[est-auto-renew] Failed to renew estimate ${est.id}: ${e.message}`); }
      }
    } catch (e) { logger.error(`[est-auto-renew] Query failed: ${e.message}`); }

    if (renewed > 0) logger.info(`[est-auto-renew] Renewed ${renewed} expired estimates`);
    return { renewed };
  },
};

module.exports = EstimateAutoRenew;
