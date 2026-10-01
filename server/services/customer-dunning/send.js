'use strict';

/**
 * The leg senders `sendReminderChannels` calls (§5 step 9). Everything a leg
 * does, in order: mint the pay link ONCE (only after that leg's policy
 * verdict and reservation claim, because sendReminderChannels only calls a
 * sender after both), render from the resolved set, then hand the message to
 * the rail with the boundary re-check wired into the rail's LAST hook.
 *
 * No leg ever uses a deferred queue. A quiet-hours / consent block comes back
 * `not_sent` retryable: the reservation is reopened by sendReminderChannels
 * and the leg retries at the next tick from a FRESH render (B-4).
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { redactContact } = require('../../utils/redact-contact');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const EmailTemplateLibrary = require('../email-template-library');
const { dispatchUnderBillingEmailAuthority } = require('../billing-channel-email-authority');
const {
  billingEmailRecipient, operatorEmailRecipient, billingEmailSendOutcome, billingEmailSendFailure,
} = require('../billing-email-sender');
const ContactLedger = require('../collections/contact-ledger');
const { isTerminalEmailRefusal } = require('../billing-reminder-delivery');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../short-url');
const { publicPortalUrl } = require('../../utils/portal-url');
const Boundary = require('./boundary');
const Render = require('./render');
const { SOURCE, emailIdempotencyKey, triggerEventId } = require('./constants');

const TABLE = 'customer_dunning_schedules';

// The short code's recorded channel for the legs that carry its link: { channel } for a lone email / sms leg, else {}.
function linkChannelFor(channels = []) {
  const legs = [...new Set(channels)];
  return legs.length === 1 && (legs[0] === 'email' || legs[0] === 'sms') ? { channel: legs[0] } : {};
}

// The cached link's identity: the set digest, and - when the code records a channel - that channel too, so a
// code minted for an email-only attempt is not reused for an SMS-only one (the recorded channel would be wrong).
// link_digest is char(64): a channel-specific key is re-hashed to the same width; a neutral link keeps the bare digest.
function linkCacheKey(digest, channel) {
  return channel ? crypto.createHash('sha256').update(`${digest}|${channel}`).digest('hex') : digest;
}

/**
 * MINT ONCE (B-6, B-13): a short code is written only when the schedule's
 * cached link is for a different set digest. The cache lives on the schedule
 * row (guarded by OUR claim); a retry with the same digest reuses it, a
 * changed set mints once more and the old code simply goes unused.
 */
async function ensureLink(ctx) {
  if (ctx.link) return ctx.link;
  const { schedule, set, customer } = ctx;
  const linkChannel = linkChannelFor(ctx.linkChannels || ctx.channels);
  const cacheKey = linkCacheKey(set.digest, linkChannel.channel);
  if (schedule.link_url && schedule.link_digest === cacheKey) {
    ctx.link = schedule.link_url;
    return ctx.link;
  }
  ctx.link = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${set.anchor.token}`, {
    kind: 'invoice',
    entityType: 'invoices',
    entityId: set.anchor.id,
    customerId: customer.id,
    // One shared link serves every leg of the touch: name its channel only when exactly one leg
    // (email or sms) will carry it; a touch on several legs, or an app push, stays neutral ('link' in the timeline).
    ...linkChannel,
    purpose: 'customer_dunning',
    codePrefix: invoiceShortCodePrefix(set.anchor),
  });
  try {
    await db(TABLE).where({ id: schedule.id, touch_claimed_at: ctx.claimStamp })
      .update({ link_url: ctx.link, link_digest: cacheKey, updated_at: db.fn.now() });
  } catch (err) {
    logger.warn(`[customer-dunning] could not cache the pay link for schedule ${schedule.id}: ${redactContact(err.message)}`);
  }
  return ctx.link;
}

const totalDue = (set) => (Number(set.totalCents) / 100).toFixed(2);

/** SMS or push leg. */
async function sendTextLeg(ctx, channel, ledger) {
  const { set, customer, step } = ctx;
  let body;
  try {
    const payUrl = await ensureLink(ctx);
    body = await Render.renderSms({ step, set, customer, payUrl });
  } catch (err) {
    // Nothing reached the provider: a definite, retryable non-send. Left to
    // throw, sendReminderChannels would read it as UNCERTAIN and hold the
    // reservation for good.
    logger.warn(`[customer-dunning] ${channel} leg for schedule ${ctx.schedule.id} not prepared: ${redactContact(err.message)}`);
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, code: 'REMINDER_PREPARATION_FAILED' };
  }
  if (!body) return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'TEMPLATE_UNAVAILABLE' };
  const boundary = Boundary.check(ctx.snapshot);
  return sendCustomerMessage({
    to: channel === 'sms' ? customer.phone : null,
    body,
    channel,
    audience: 'customer',
    purpose: 'payment_link',
    customerId: customer.id,
    invoiceId: set.anchor.id,
    entryPoint: 'invoice_followup_customer',
    hasEmailLeg: ctx.channels.includes('email'),
    // the office "send now" keeps its pay link through a plain dispute hold (a fallback hold still waits)
    ...(ctx.operatorInitiated ? { operatorInitiated: true, holdExempt: 'operator' } : {}),
    metadata: {
      original_message_type: 'invoice_followup',
      notificationEventKey: ctx.eventKey,
      billingDeliveryCategory: 'invoice',
      // The consent validator treats this marker as "the recipient's explicit billing
      // choice selected this leg" and refuses a default-channel or operator send that
      // carries it (BILLING_PREFERENCES_CHANGED, retried forever). Set it exactly as the
      // per-invoice ladder does: only for a non-operator send on an explicit selection.
      ...(ctx.explicit === true && !ctx.operatorInitiated ? { billingDeliveryLeg: channel } : {}),
      customer_dunning_schedule_id: ctx.schedule.id,
      rendered_amount: totalDue(set),
      collections_ledger_id: ledger.id,
      ...(channel === 'push' ? { appOnly: true } : {}),
    },
    preDispatchCheck: boundary,
    preSendCheck: boundary,
    // Twilio runs preSendCheck BEFORE its own asynchronous provider preparation (the annual-offer guard's
    // short_codes lookup for a shortened payment link). This one runs after it, immediately before
    // messages.create(): an invoice paid or a schedule paused during that lookup still vetoes the text
    // (retryable DUNNING_SET_CHANGED / DUNNING_SCHEDULE_CHANGED, the reservation reopened). It reads on the
    // handoff transaction when there is one, else the pool. The push rail needs no twin: its
    // shouldContinue (this same boundary) is re-run right after the OAuth fetch and before the FCM request.
    ...(channel === 'sms' ? { providerPreSendCheck: ({ dbi } = {}) => boundary({ database: dbi?.isTransaction ? dbi : undefined }) } : {}),
  });
}

const AUTHORITY_INPUT = (customerId) => ({
  customerId, invoiceId: null, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' },
});

// Every email - an operator's send-now included - goes through the ONE shared billing email authority: recipient
// re-resolution under the comms lock, the address lock, both suppression stores, the template check, the
// collections-hold check and this engine's boundary callback. The operator send differs in exactly two things the
// authority takes as explicit options: it skips the billing-preference / channel-selection gate (the deliberate
// bypass) and carries holdExempt 'operator' (a plain dispute hold is skipped, a wrong-party hold still waits).
function emailHandoff(ctx, to, templateKey, state) {
  return (dispatch) => dispatchUnderBillingEmailAuthority({
    input: AUTHORITY_INPUT(ctx.customer.id),
    recipientEmail: to,
    // the authority compares against its own lower-cased recipient; an operator address comes from the raw record
    authorityRecipientEmail: String(to).trim().toLowerCase(),
    templateKey,
    preSendCheck: Boundary.check(ctx.snapshot),
    dispatch,
    state,
    ...(ctx.operatorInitiated ? { operatorBypassPreferences: true, holdExempt: 'operator' } : {}),
  });
}

/**
 * A-11: an email on DEFAULT channels (no explicit choice) refused before it
 * reached the provider keeps `never_contacted`, so it does not use up the
 * frequency windows; the flag is cleared again at the start of every attempt
 * so a retried, delivered leg counts as the contact it is.
 */
async function stampNeverContacted(ledger, on) {
  try {
    if (on) {
      await ContactLedger.markSendFailed(ledger, { never_contacted: true });
    } else {
      // jsonb_exists, not the `?` operator: knex reads a bare `?` as a binding.
      await db('collections_contact_ledger').where({ id: ledger.id })
        .whereRaw("jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'never_contacted')")
        .update({ metadata: db.raw("metadata - 'never_contacted'") });
    }
    return true;
  } catch (err) {
    logger.warn(`[customer-dunning] never_contacted stamp failed for ledger ${ledger.id}: ${redactContact(err.message)}`);
    return false;
  }
}

async function resolveEmailRecipient(ctx) {
  return ctx.operatorInitiated
    ? operatorEmailRecipient(ctx.customer, 'customer-dunning')
    : billingEmailRecipient(AUTHORITY_INPUT(ctx.customer.id), 'customer-dunning');
}

async function deliverEmail(ctx, ledger, { recipient, to }) {
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  const log = async () => {};
  try {
    // Inside the try: a short-link, render or template-library failure before
    // the provider handoff is a definite non-send (billingEmailSendFailure maps
    // it to not_sent), never an uncertain one.
    const payUrl = await ensureLink(ctx);
    const { templateKey, payload } = Render.renderEmail({
      step: ctx.step, set: ctx.set, customer: ctx.customer, recipient, payUrl,
    });
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to,
      // The reservation's id rides in the stored payload: it is how an
      // accepted-but-unstamped email is bound back to THIS ledger row when the
      // process dies before markDelivered (billing-email-reservation.js).
      payload: { ...payload, collections_ledger_id: String(ledger.id) },
      recipientType: 'customer',
      recipientId: ctx.customer.id,
      triggerEventId: triggerEventId(ctx.schedule, ctx.step.id),
      idempotencyKey: emailIdempotencyKey(ctx.schedule, ctx.step.id),
      categories: ['invoice_followup_customer', ctx.step.id],
      suppressionGroupKey: 'transactional_required',
      // the template library must not log a raw provider error (SendGrid echoes the recipient address)
      suppressProviderErrorLog: true,
      withProviderHandoff: emailHandoff(ctx, to, templateKey, state),
    });
    return await billingEmailSendOutcome(result, state, log);
  } catch (err) {
    return billingEmailSendFailure(err, state.handoffStarted, log, {
      logTag: 'customer-dunning', label: `${ctx.step.id} for customer ${ctx.customer.id}`,
    });
  }
}

/** Email leg. */
async function sendEmailLeg(ctx, ledger) {
  // Every attempt starts clean: an earlier refusal's stamp must not outlive a
  // retry that reaches the customer, whatever the channel selection.
  const cleared = await stampNeverContacted(ledger, false);
  // A stale flag that cannot be removed would leave a DELIVERED row excluded from
  // the collections frequency window for good: do not send. A definite,
  // retryable non-send, like any other failure before the provider.
  if (!cleared && ledger.metadata?.never_contacted === true) {
    return { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'NEVER_CONTACTED_CLEAR_FAILED' };
  }
  const who = await resolveEmailRecipient(ctx);
  const result = who.refusal || await deliverEmail(ctx, ledger, who);
  // Only the decision to ADD the stamp depends on default channels: a definite
  // non-send (retryable refusal or a provider/preparation failure), not a
  // terminal refusal, used no frequency window.
  // (A collections-hold refusal is a WAIT: the reservation is released, so there is nothing to stamp.)
  const notSent = result?.deliveryOutcome === 'not_sent' && !isTerminalEmailRefusal(result)
    && !require('../collections/collection-hold').isHoldSuppression(result);
  if (!ctx.explicit && notSent) await stampNeverContacted(ledger, true);
  return result;
}

/** The `send(channel, ledger)` callback for sendReminderChannels. */
function makeSender(ctx) {
  return (channel, ledger, dispatchable) => {
    // The shared pay link is attributed to the legs this attempt will actually dispatch (pending AND permitted by the
    // collections policy), known only once the policy verdicts are in - so it is set here, before the first leg mints.
    if (Array.isArray(dispatchable)) ctx.linkChannels = dispatchable;
    return channel === 'email' ? sendEmailLeg(ctx, ledger) : sendTextLeg(ctx, channel, ledger);
  };
}

module.exports = { stampNeverContacted, makeSender, ensureLink, sendTextLeg, sendEmailLeg, SOURCE };
