/**
 * Estimate extension — shared core for pushing an estimate's expires_at
 * forward and telling the customer via the `estimate_extended` SMS template.
 *
 * Two callers:
 *   - POST /api/admin/estimates/:id/extend (admin-estimates.js) — Adam
 *     extends by any 1–180 days, optional silent mode.
 *   - POST /api/estimates/:token/extension-request (estimate-public.js) —
 *     the public expired-screen button's ONE automatic 7-day grant.
 *
 * Extracted from the admin route so the public auto-grant can't drift from
 * the reviewed admin behavior (expiry anchoring, status revival, expiring-
 * nudge re-arm, consent-aware SMS). Behavior is 1:1 with the pre-extraction
 * admin route, including the deliberate quirk that the extension persists
 * even when the SMS template turns out missing/inactive (the admin route
 * surfaces that as a 422 AFTER the expiry write, and always has).
 */

const db = require('../models/db');
const logger = require('./logger');
const { shortenOrPassthrough } = require('./short-url');
const { leadIdForEstimate } = require('./estimate-lead-linkage');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
// Router module doubling as the template helper — same import the
// estimate-follow-up service uses.
const smsTemplatesRouter = require('../routes/admin-sms-templates');

// Every PUBLISHED status the public eligibility predicate
// (isEstimateExtensionRequestEligible) can admit, plus the admin trio. A
// date-expired send_failed row with sent_at (some channel delivered) and a
// stuck date-expired 'sending' row are both real customer-held links — the
// service must be able to extend anything the UI offers the button for, or
// the POST deterministically 500s on an eligible row.
const EXTENDABLE_STATUSES = ['sent', 'viewed', 'expired', 'send_failed', 'sending'];

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Anchor the extension on the LATER of "now" and the current expiry —
// extending an already-expired estimate by 7d means 7d from today, not 7d
// after the expiry that already passed. Active estimates get their current
// expiry pushed out by the requested days.
function computeExtensionExpiry(estimate = {}, days, now = new Date()) {
  const currentExpiry = estimate.expires_at ? new Date(estimate.expires_at) : now;
  const anchor = currentExpiry > now ? currentExpiry : now;
  return new Date(anchor.getTime() + days * 86400000);
}

// Estimates whose status itself blocks the customer view need reviving on
// extension: 'expired' (the sweep's flip) and 'send_failed' (404s in
// isEstimateCustomerViewable regardless of expiry) reset to viewed/sent per
// the customer's history. A DATE-EXPIRED 'sending' row with publication
// evidence is a STUCK send claim, not an in-flight send (claims live
// seconds-to-minutes; expiry windows are days) — it must revive too, because
// extending it in place would bump updated_at (delaying
// recoverStaleScheduledEstimateClaims) and that recovery later flips the row
// to send_failed/scheduled, killing the just-extended link (codex P2,
// 2026-07-11). A 'sending' row without sent_at/viewed_at stays untouched —
// the send/recovery machinery owns it. sent/viewed stay untouched.
function extensionStatusUpdate(estimate = {}, now = new Date()) {
  const revived = () => (estimate.viewed_at ? 'viewed' : 'sent');
  if (['expired', 'send_failed'].includes(estimate.status)) return revived();
  if (estimate.status === 'sending'
    && estimate.expires_at && new Date(estimate.expires_at) < now
    && (estimate.sent_at || estimate.viewed_at)) return revived();
  return null;
}

/**
 * Push expires_at forward and (unless silent) text the customer the
 * refreshed link via the `estimate_extended` template.
 *
 * @param {object} opts
 * @param {object} opts.estimate  full estimates row
 * @param {number} opts.days      integer 1–180
 * @param {boolean} [opts.silent] skip the customer SMS
 * @param {string} opts.entryPoint  sendCustomerMessage entry point label
 * @param {string} opts.workflow    template-audit workflow label
 * @param {object} [opts.smsMetadata] extra metadata for the outbound message
 * @returns {{ newExpiry: Date, status: string, smsResult: object }}
 *   smsResult: { sent, reason } — reason 'silent' | 'no_phone' |
 *   'template_missing' | provider/consent block reasons from
 *   sendCustomerMessage.
 * @throws validation errors carrying statusCode 400 (bad days / status /
 *   archived) and concurrency conflicts carrying statusCode 409 (the row
 *   changed between read and guarded write) so route callers can pass them
 *   straight through.
 */
async function extendEstimate({ estimate, days, silent = false, entryPoint, workflow, smsMetadata = {} }) {
  if (!estimate || !estimate.id) throw validationError('Estimate not found');

  const parsedDays = Number.parseInt(days, 10);
  if (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > 180) {
    throw validationError('days must be an integer between 1 and 180.');
  }
  if (!EXTENDABLE_STATUSES.includes(estimate.status)) {
    throw validationError(`Only sent / viewed / expired estimates can be extended. Current status: ${estimate.status}.`);
  }
  // A LIVE 'sending' claim belongs to an in-flight send: its finalization
  // writes status + the real expires_at when it completes, so extending now
  // would either be overwritten or steal the claim mid-send. Only a STALE
  // claim — one whose expiry window already lapsed — is extendable (that row
  // is definitionally a crashed send: claims live seconds, windows days).
  // This also keeps the admin route's old behavior of refusing mid-send rows.
  if (estimate.status === 'sending') {
    if (!(estimate.expires_at && new Date(estimate.expires_at) < new Date())) {
      throw validationError('Estimate is mid-send — wait for the send to finish before extending.');
    }
    // A stale send that never reached the customer (no sent_at/viewed_at)
    // has no link to extend, and extensionStatusUpdate would leave it
    // 'sending' — pushing expires_at forward on a row the stale-send
    // recovery will later flip to send_failed, killing the refreshed link.
    // The right tool for that row is a re-send.
    if (!estimate.sent_at && !estimate.viewed_at) {
      throw validationError('This send crashed before reaching the customer — re-send the estimate instead of extending.');
    }
  }
  if (estimate.archived_at) {
    throw validationError('Estimate is archived. Unarchive first.');
  }

  const newExpiry = computeExtensionExpiry(estimate, parsedDays);

  // Re-arm the expiring nudge for the new deadline. Other stage flags
  // (unviewed / viewed / final) stay as-is — those are tied to send / view
  // timestamps that haven't moved.
  const updates = {
    expires_at: newExpiry,
    followup_expiring_sent: false,
    updated_at: db.fn.now(),
  };
  const revivedStatus = extensionStatusUpdate(estimate);
  if (revivedStatus) updates.status = revivedStatus;

  // Guarded write — the caller's row is a snapshot, so predicate on the
  // state this extension was computed FROM, not just the id. This stops a
  // stale snapshot from (a) shortening a concurrent longer extension (the
  // expires_at < newExpiry guard: never move an expiry backwards), (b)
  // resurrecting a row a concurrent accept/decline/archive just made
  // terminal (status + archived_at guards), or (c) reporting success over a
  // concurrent sweep flip (status guard). Zero rows → 409, callers surface
  // retry/failure.
  const updated = await db('estimates')
    .where({ id: estimate.id, status: estimate.status })
    .whereNull('archived_at')
    .where((b) => b.whereNull('expires_at').orWhere('expires_at', '<', newExpiry))
    .update(updates);
  if (!updated) {
    const err = new Error('Estimate changed while extending — retry.');
    err.statusCode = 409;
    throw err;
  }

  // Re-arm the ENGAGEMENT ENGINE's expiring lifecycle for the new deadline
  // too (codex 2736 r9): the engine's one-lifecycle enqueue guard and the
  // expiring sends-group budget would otherwise suppress expiring_* forever
  // — job and ledger rows from the OLD deadline don't describe this one,
  // and a lingering ledger row also blocks the legacy cron's cross-lane
  // claim. Deletion IS the re-arm, mirroring the followup_expiring_sent
  // reset above (the extension itself is the audit trail; the estimate's
  // follow_up_count keeps counting the old send toward the inbox cap).
  // Post-write invariant applies (see below): never throws.
  try {
    // Count any uncounted sends BEFORE deleting their rows (codex 2736
    // r11): a sent-but-unbumped expiring email leaves counted_at NULL as
    // the heal marker — deleting it first would erase the only evidence
    // and quietly loosen the inbox cap/spacing for an email the customer
    // really received. Repair failure skips the deletes too (same catch):
    // never destroy evidence that hasn't been counted. Lazy require avoids
    // loading the follow-up module graph on every extension.
    const { repairFollowupCounters } = require('./estimate-follow-up')._private;
    // olderThanMinutes (codex 2736 r14): this runs OUTSIDE the follow-up
    // advisory lock, so a seconds-old uncounted row can be a live
    // processor's pre-send claim (which the deadline-moved abort will
    // release) — counting it would leave a phantom touch. Ten minutes is
    // far beyond any in-flight send; genuinely lost bumps are older.
    await repairFollowupCounters(estimate.id, { olderThanMinutes: 10 });
    const EXPIRING_RULE_KEYS = ['expiring_engaged', 'expiring_never_viewed'];
    await db('estimate_followup_jobs')
      .where({ estimate_id: estimate.id })
      .whereIn('rule_key', EXPIRING_RULE_KEYS)
      .del();
    // Only COUNTED rows are deleted (codex 2736 r15): the age-thresholded
    // repair above deliberately leaves sub-10-min uncounted rows (possible
    // in-flight claims), and deleting one would erase the only marker that
    // can later heal the counters for a real send. A surviving row is
    // either an in-flight claim (the deadline-moved abort releases it) or
    // a fresh lost bump — the cron-side heal counts it later, and its
    // group-guard suppression of the re-arm errs toward fewer emails.
    await db('estimate_followup_sends')
      .where({ estimate_id: estimate.id })
      .whereIn('rule_key', EXPIRING_RULE_KEYS)
      .whereNotNull('counted_at')
      .del();
  } catch (e) {
    logger.warn(`[estimate-extension] engine expiring re-arm failed (non-fatal): ${e.message}`);
  }

  // Customer notification — Waves voice. Skipped if no phone or the caller
  // asked for silence; consent/opt-out/gate enforcement lives inside
  // sendCustomerMessage.
  //
  // POST-WRITE INVARIANT: nothing after the guarded UPDATE above may throw
  // out of this function. The extension is already persisted, and callers
  // treat a service throw as "nothing happened" — the public route releases
  // its lifetime auto-grant burn on that signal, which would let the same
  // token self-serve another "first" grant after this one lapses (codex P2,
  // 2026-07-11). Plumbing failures (URL shortener, lead lookup, provider)
  // degrade to an unsent-SMS result instead; the admin notification/response
  // carry the reason.
  let smsResult = { sent: false, reason: 'silent' };
  if (!silent) {
    try {
      if (!estimate.customer_phone) {
        smsResult = { sent: false, reason: 'no_phone' };
      } else {
        const firstName = estimate.customer_name?.split(' ')[0] || 'there';
        const longUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
        const viewUrl = await shortenOrPassthrough(longUrl, {
          kind: 'estimate', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
          leadId: await leadIdForEstimate(estimate),
          channel: 'sms', purpose: 'estimate_extended',
        });
        const newExpiryLabel = newExpiry.toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', timeZone: 'America/New_York',
        });
        const body = await smsTemplatesRouter.getTemplate(
          'estimate_extended',
          { first_name: firstName, estimate_url: viewUrl, new_expiry: newExpiryLabel, days_added: String(parsedDays) },
          { workflow, entity_type: 'estimate', entity_id: estimate.id },
        ).catch((err) => {
          logger.warn(`[estimate-extension] SMS template estimate_extended lookup failed: ${err.message}`);
          return null;
        });
        if (!body) {
          smsResult = { sent: false, reason: 'template_missing' };
        } else {
          smsResult = await sendCustomerMessage({
            to: estimate.customer_phone,
            body,
            channel: 'sms',
            audience: estimate.customer_id ? 'customer' : 'lead',
            purpose: 'estimate_followup',
            customerId: estimate.customer_id || undefined,
            estimateId: estimate.id,
            identityTrustLevel: estimate.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
            consentBasis: estimate.customer_id ? undefined : {
              status: 'transactional_allowed',
              source: entryPoint,
              capturedAt: estimate.created_at || new Date().toISOString(),
            },
            entryPoint,
            metadata: { days_added: parsedDays, ...smsMetadata },
          });
          // GATE_TWILIO_SMS off yields a "successful" gate-blocked outcome
          // (sent:true, providerMessageId:'gate-blocked') so automations
          // upstream don't retry — but here `sent` feeds customer-facing
          // "we texted you" copy and the admin alert, so a suppressed send
          // must read as unsent.
          if (smsResult?.sent && smsResult.providerMessageId === 'gate-blocked') {
            smsResult = { ...smsResult, sent: false, reason: 'sms_gate_off' };
          }
        }
      }
    } catch (err) {
      logger.error(`[estimate-extension] post-write SMS step failed for estimate ${estimate.id}: ${err.message}`);
      smsResult = { sent: false, reason: 'sms_error' };
    }
  }

  // Email leg (owner ask 2026-07-11: extension confirmations go by text AND
  // email). Same POST-WRITE INVARIANT as the SMS above — never throws; the
  // library's own suppression/dedupe surface as blocked/deduped and a missing
  // template throws internally, all degrading to an unsent result here. The
  // idempotency key is scoped per grant (id + new expiry) so a later, further
  // extension emails again while accidental double-fires of THIS grant don't.
  let emailResult = { sent: false, reason: 'silent' };
  if (!silent) {
    try {
      if (!estimate.customer_email) {
        emailResult = { sent: false, reason: 'no_email' };
      } else {
        const EmailTemplateLibrary = require('./email-template-library');
        const firstName = estimate.customer_name?.split(' ')[0] || 'there';
        const newExpiryLabel = newExpiry.toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', timeZone: 'America/New_York',
        });
        const result = await EmailTemplateLibrary.sendTemplate({
          templateKey: 'estimate.extended',
          to: estimate.customer_email,
          payload: {
            first_name: firstName,
            estimate_url: `https://portal.wavespestcontrol.com/estimate/${estimate.token}`,
            new_expiry: newExpiryLabel,
          },
          recipientType: estimate.customer_id ? 'customer' : 'lead',
          recipientId: estimate.customer_id || null,
          triggerEventId: `estimate_extended:${estimate.id}:${newExpiry.toISOString()}`,
          idempotencyKey: `estimate_extended:${estimate.id}:${newExpiry.toISOString()}`,
          categories: ['estimate_extended'],
          // Provider rejection bodies can echo the recipient address — keep
          // them out of the provider log (mirrors estimate-follow-up.js).
          suppressProviderErrorLog: true,
        });
        if (result?.sent) {
          emailResult = { sent: true };
        } else if (result?.deduped) {
          emailResult = { sent: false, reason: 'deduped' };
        } else {
          emailResult = { sent: false, reason: result?.reason || 'blocked' };
        }
      }
    } catch (err) {
      logger.error(`[estimate-extension] post-write email step failed for estimate ${estimate.id}: ${require('./email-template-library').redactEmailAddresses(err.message)}`);
      emailResult = { sent: false, reason: 'email_error' };
    }
  }

  logger.info(`[estimate-extension] Extended estimate ${estimate.id} by ${parsedDays}d to ${newExpiry.toISOString()} via ${entryPoint} (sms=${smsResult.sent ? 'sent' : smsResult.reason || 'skipped'}, email=${emailResult.sent ? 'sent' : emailResult.reason || 'skipped'})`);
  return { newExpiry, status: revivedStatus || estimate.status, smsResult, emailResult };
}

module.exports = {
  extendEstimate,
  computeExtensionExpiry,
  extensionStatusUpdate,
  EXTENDABLE_STATUSES,
};
