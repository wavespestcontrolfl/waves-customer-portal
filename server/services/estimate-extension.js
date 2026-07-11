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
        }
      }
    } catch (err) {
      logger.error(`[estimate-extension] post-write SMS step failed for estimate ${estimate.id}: ${err.message}`);
      smsResult = { sent: false, reason: 'sms_error' };
    }
  }

  logger.info(`[estimate-extension] Extended estimate ${estimate.id} by ${parsedDays}d to ${newExpiry.toISOString()} via ${entryPoint} (sms=${smsResult.sent ? 'sent' : smsResult.reason || 'skipped'})`);
  return { newExpiry, status: revivedStatus || estimate.status, smsResult };
}

module.exports = {
  extendEstimate,
  computeExtensionExpiry,
  extensionStatusUpdate,
  EXTENDABLE_STATUSES,
};
