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

const db = require('../../models/db');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const EmailTemplateLibrary = require('../email-template-library');
const { dispatchUnderBillingEmailAuthority, blocked } = require('../billing-channel-email-authority');
const {
  billingEmailRecipient, operatorEmailRecipient, billingEmailSendOutcome, billingEmailSendFailure,
} = require('../billing-email-sender');
const ContactLedger = require('../collections/contact-ledger');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../short-url');
const { publicPortalUrl } = require('../../utils/portal-url');
const { withCustomerCommsLock } = require('../../utils/customer-comms-lock');
const Boundary = require('./boundary');
const Render = require('./render');
const { SOURCE, emailIdempotencyKey, triggerEventId } = require('./constants');

const TABLE = 'customer_dunning_schedules';

/**
 * MINT ONCE (B-6, B-13): a short code is written only when the schedule's
 * cached link is for a different set digest. The cache lives on the schedule
 * row (guarded by OUR claim); a retry with the same digest reuses it, a
 * changed set mints once more and the old code simply goes unused.
 */
async function ensureLink(ctx) {
  if (ctx.link) return ctx.link;
  const { schedule, set, customer } = ctx;
  if (schedule.link_url && schedule.link_digest === set.digest) {
    ctx.link = schedule.link_url;
    return ctx.link;
  }
  ctx.link = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${set.anchor.token}`, {
    kind: 'invoice',
    entityType: 'invoices',
    entityId: set.anchor.id,
    customerId: customer.id,
    channel: 'sms',
    purpose: 'customer_dunning',
    codePrefix: invoiceShortCodePrefix(set.anchor),
  });
  try {
    await (ctx.database || db)(TABLE).where({ id: schedule.id, touch_claimed_at: ctx.claimStamp })
      .update({ link_url: ctx.link, link_digest: set.digest, updated_at: (ctx.database || db).fn.now() });
  } catch (err) {
    logger.warn(`[customer-dunning] could not cache the pay link for schedule ${schedule.id}: ${err.message}`);
  }
  return ctx.link;
}

const totalDue = (set) => (Number(set.totalCents) / 100).toFixed(2);

/** SMS or push leg. */
async function sendTextLeg(ctx, channel, ledger) {
  const { set, customer, step } = ctx;
  const payUrl = await ensureLink(ctx);
  const body = await Render.renderSms({ step, set, customer, payUrl });
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
    ...(ctx.operatorInitiated ? { operatorInitiated: true } : {}),
    metadata: {
      original_message_type: 'invoice_followup',
      notificationEventKey: ctx.eventKey,
      billingDeliveryCategory: 'invoice',
      billingDeliveryLeg: channel,
      customer_dunning_schedule_id: ctx.schedule.id,
      rendered_amount: totalDue(set),
      collections_ledger_id: ledger.id,
      ...(channel === 'push' ? { appOnly: true } : {}),
    },
    preDispatchCheck: boundary,
    preSendCheck: boundary,
  });
}

/**
 * The operator send's provider handoff: a customer-comms transaction that runs
 * the boundary on ITS handle, then dispatches (the analogue of
 * billing-email-sender's selfPayOnlyHandoff). Fail-closed.
 */
function boundaryOnlyHandoff(snapshot, state) {
  return async (dispatch) => {
    return withCustomerCommsLock(db, snapshot.customerId, async (trx) => {
      const verdict = await Boundary.check(snapshot)({ database: trx });
      if (verdict.ok !== true) {
        state.boundaryBlock = blocked(verdict.code, verdict.reason, { retryable: verdict.retryable === true });
        return { ok: false };
      }
      state.handoffStarted = true;
      await dispatch();
      return { ok: true };
    });
  };
}

const AUTHORITY_INPUT = (customerId) => ({
  customerId, invoiceId: null, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' },
});

function emailHandoff(ctx, to, templateKey, state) {
  if (ctx.operatorInitiated) return boundaryOnlyHandoff(ctx.snapshot, state);
  return (dispatch) => dispatchUnderBillingEmailAuthority({
    input: AUTHORITY_INPUT(ctx.customer.id),
    recipientEmail: to,
    templateKey,
    preSendCheck: Boundary.check(ctx.snapshot),
    dispatch,
    state,
  });
}

/**
 * A-11: an email on DEFAULT channels (no explicit choice) refused before it
 * reached the provider keeps `never_contacted`, so it does not use up the
 * frequency windows; the flag is cleared again at the start of every attempt
 * so a retried, delivered leg counts as the contact it is.
 */
async function stampNeverContacted(ledger, on, database = db) {
  try {
    if (on) {
      await ContactLedger.markSendFailed(ledger, { never_contacted: true });
    } else {
      // jsonb_exists, not the `?` operator: knex reads a bare `?` as a binding.
      await database('collections_contact_ledger').where({ id: ledger.id })
        .whereRaw("jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'never_contacted')")
        .update({ metadata: database.raw("metadata - 'never_contacted'") });
    }
  } catch (err) {
    logger.warn(`[customer-dunning] never_contacted stamp failed for ledger ${ledger.id}: ${err.message}`);
  }
}

async function resolveEmailRecipient(ctx) {
  return ctx.operatorInitiated
    ? operatorEmailRecipient(ctx.customer, 'customer-dunning')
    : billingEmailRecipient(AUTHORITY_INPUT(ctx.customer.id), 'customer-dunning');
}

async function deliverEmail(ctx, ledger, { recipient, to }) {
  const payUrl = await ensureLink(ctx);
  const { templateKey, payload } = Render.renderEmail({
    step: ctx.step, set: ctx.set, customer: ctx.customer, recipient, payUrl,
  });
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  const log = async () => {};
  try {
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
  if (!ctx.explicit) await stampNeverContacted(ledger, false);
  const who = await resolveEmailRecipient(ctx);
  const result = who.refusal || await deliverEmail(ctx, ledger, who);
  const preProvider = result?.retryable === true && result.deliveryOutcome === 'not_sent';
  if (!ctx.explicit && preProvider) await stampNeverContacted(ledger, true);
  return result;
}

/** The `send(channel, ledger)` callback for sendReminderChannels. */
function makeSender(ctx) {
  return (channel, ledger) => (channel === 'email' ? sendEmailLeg(ctx, ledger) : sendTextLeg(ctx, channel, ledger));
}

module.exports = { stampNeverContacted, makeSender, ensureLink, sendTextLeg, sendEmailLeg, boundaryOnlyHandoff, SOURCE };
