/**
 * Automation runner — local replacement for Beehiiv automation sequences.
 * Every minute the scheduler calls processDueSteps(), which pulls
 * enrollments with status='active' AND next_send_at <= now(), sends the
 * next step via SendGrid, advances the cursor, and schedules the next
 * step or marks the enrollment complete.
 *
 * Personalization: step bodies can include {{first_name}} / {{last_name}} /
 * {{email}} placeholders. More can be added in substitute() below.
 *
 * ASM group: templates declare 'service' (transactional — welcomes,
 * renewals) or 'newsletter' (promotional — cold lead, referral nudge).
 * SendGrid's suppression groups handle unsub semantics correctly.
 */

const db = require('../models/db');
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
const { lockCustomerComms, tryLockCustomerComms } = require('../utils/customer-comms-lock');
const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const { wrapServiceEmail, ensureLegalTextFooter, blockPalette } = require('./email-template');

const ASM_UNSUBSCRIBE_URL = '<%asm_group_unsubscribe_raw_url%>';
const GLOBAL_SUPPRESSION_TYPES = new Set(['bounce', 'spam_complaint', 'do_not_email']);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Names and emails come from lead forms and calls, so in the HTML arm they are
// escaped: a form that puts a link in the name field and a stranger's address
// in the email field must not make Waves send that stranger a live link
// (sweep #4616 B2). Text bodies and subjects are plain text and stay raw.
// Replacer functions, not strings: a value holding `$&` or `$'` must not pull
// template text back in.
function substitute(text, customer, { html = false } = {}) {
  if (!text) return text;
  const value = html ? escapeHtml : String;
  // 'there' for a customer with no first name on file (call-created on a last
  // name alone): never "Hi  —".
  const first = value(customer.first_name || customer.firstName || 'there');
  const last = value(customer.last_name || customer.lastName || '');
  const email = value(customer.email || '');
  return text
    .replace(/\{\{\s*first_name\s*\}\}/g, () => first)
    .replace(/\{\{\s*last_name\s*\}\}/g, () => last)
    .replace(/\{\{\s*email\s*\}\}/g, () => email)
    .replace(/\{first_name\}/g, () => first)          // also support single-brace for parity with SMS templates
    .replace(/\{last_name\}/g, () => last);
}

// The consultation-booking placeholders, whitespace-tolerant like every
// other {{merge}} field here. ONE definition for the preflight (does this
// step need the block built?) and the render (where does it go?).
// Each swallows the ONE separator newline the placeholder migration wrote
// after it, and the render puts it back only when the block is non-empty —
// so a hidden block leaves the email byte-identical to the pre-placeholder
// body instead of a stray blank line (Codex #4821 r1 P2).
const CONSULTATION_HTML_RE = /\{\{\s*consultation_booking\s*\}\}\n?/g;
const CONSULTATION_TEXT_RE = /\{\{\s*consultation_booking_text\s*\}\}\n?/g;
function withSeparator(block) {
  return block ? `${block}\n` : '';
}
const CONSULTATION_PLACEHOLDER_RE = /\{\{\s*consultation_booking(?:_text)?\s*\}\}/;

const AUTOMATION_FROM_ALLOWLIST = (process.env.AUTOMATION_FROM_ALLOWLIST
  || 'automations@wavespestcontrol.com,newsletter@wavespestcontrol.com,events@wavespestcontrol.com,weekly@wavespestcontrol.com'
).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function normalizeAutomationFromEmail(email) {
  const lc = String(email || 'automations@wavespestcontrol.com').trim().toLowerCase();
  if (!AUTOMATION_FROM_ALLOWLIST.includes(lc)) {
    throw new Error(`automation from_email is not allowed: ${lc}`);
  }
  return lc;
}

function automationAsmGroupId(template) {
  const group = String(template.asm_group || 'service').trim().toLowerCase();
  if (group === 'newsletter') return parseInt(process.env.SENDGRID_ASM_GROUP_NEWSLETTER) || null;
  if (group === 'service') return parseInt(process.env.SENDGRID_ASM_GROUP_SERVICE) || null;
  throw new Error(`invalid automation asm_group: ${template.asm_group}`);
}

function isNewsletterAutomation(template) {
  return String(template?.asm_group || 'service').trim().toLowerCase() === 'newsletter';
}

function automationSuppressionGroupKey(template) {
  return isNewsletterAutomation(template) ? 'marketing_newsletter' : 'service_operational';
}

function automationSuppressionMatches(template, suppression) {
  if (!suppression) return false;
  const groupKey = String(suppression.group_key || '').trim();
  const suppressionType = String(suppression.suppression_type || '').trim().toLowerCase();
  const automationGroupKey = automationSuppressionGroupKey(template);
  return (
    !groupKey ||
    groupKey === automationGroupKey ||
    GLOBAL_SUPPRESSION_TYPES.has(suppressionType)
  );
}

function automationSuppressionReason(suppression) {
  return `Suppressed: ${suppression.suppression_type}${suppression.group_key ? ` (${suppression.group_key})` : ''}`;
}

async function activeAutomationSuppressionFor(template, email, database = db) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const rows = await database('email_suppressions')
    .where(require('../utils/email-equivalence').suppressionCoversEmail(normalizedEmail))
    .where({ status: 'active' });
  return rows.find((row) => automationSuppressionMatches(template, row)) || null;
}

async function blockSendAndCancelEnrollment({ enrollment, sendId, reason, cancelReason }) {
  await db('automation_step_sends').where({ id: sendId }).update({
    status: 'blocked',
    failure_reason: reason.slice(0, 500),
    updated_at: new Date(),
  });
  await db('automation_enrollments').where({ id: enrollment.id }).update({
    status: 'cancelled',
    next_send_at: null,
    completed_at: new Date(),
    metadata: db.raw("jsonb_set(COALESCE(metadata,'{}'::jsonb), '{cancel_reason}', ?::jsonb, true)", [JSON.stringify(cancelReason)]),
    updated_at: new Date(),
  });
  logger.warn(`[automation-runner] cancelled enrollment=${enrollment.id} reason=${reason}`);
  return { sent: false, blocked: true, reason };
}

// OWNER RULING (2026-07-13, renewal-reminder.js): "renewal" language is
// reserved for termite bonds, so the service_renewal sequence reaches only
// customers with a termite_renewal_date on file — checked at enrollment, at
// delivery, and in the Automations-tab segment query.
function requiresTermiteBond(templateKey) {
  return templateKey === 'service_renewal';
}

// OWNER RULING (2026-10-29, "fix estimate email"): the estimate_sent
// follow-up ("did your estimate land? any questions?") stops once the
// customer accepts; 19 of 90 in 60 days had gone to customers who already
// had. Read at delivery, so every accept path counts (public accept,
// one-tap, Mark accepted): the estimate whose send enrolled this episode
// (metadata.estimate_id, also when the accept landed mid-send, before the
// enrollment existed), or any estimate for this customer or address
// accepted since the episode began (another estimate in the same send, or
// an enrollment without the stamp: queued before it, or a manual trigger).
async function estimateAcceptedForFollowUp(enrollment) {
  const estimateId = enrollment.metadata?.estimate_id || null;
  const email = String(enrollment.email || '').trim().toLowerCase();
  // Without a customer or an address the "since" half has no one to match,
  // and an empty group would match every customer's accepted estimate.
  const since = enrollment.enrolled_at && (enrollment.customer_id || email) ? enrollment.enrolled_at : null;
  if (!estimateId && !since) return false;
  const accepted = await db('estimates')
    .whereNotNull('accepted_at')
    .where((q) => {
      if (estimateId) q.orWhere('id', estimateId);
      if (since) {
        q.orWhere((episode) => episode
          .where('accepted_at', '>=', since)
          .where((who) => {
            if (enrollment.customer_id) who.orWhere('customer_id', enrollment.customer_id);
            if (email) who.orWhereRaw('lower(trim(customer_email)) = ?', [email]);
          }));
      }
    })
    .first('id');
  return !!accepted;
}

async function automationDeliveryBlock({ enrollment, template, recipient, sendId, testRecipient, billingSend }) {
  if (testRecipient) return null;
  // A billing send checks suppression for the CURRENT billing recipient,
  // inside the shared billing email authority under its recipient lock; the
  // address snapshotted at enrollment may no longer be the one it goes to.
  const suppression = billingSend ? null : await activeAutomationSuppressionFor(template, recipient);
  if (suppression) {
    const reason = automationSuppressionReason(suppression);
    return blockSendAndCancelEnrollment({ enrollment, sendId, reason, cancelReason: 'email_suppressed' });
  }
  if (requiresTermiteBond(template.key)) {
    // Same termite-bond rule as enrollCustomer, re-read at delivery: an
    // enrollment queued before that gate, or a bond cleared since, is
    // cancelled here instead of sent.
    const bond = enrollment.customer_id
      ? await db('customers').where({ id: enrollment.customer_id }).first('termite_renewal_date')
      : null;
    if (bond?.termite_renewal_date) return null;
    return blockSendAndCancelEnrollment({ enrollment, sendId,
      reason: 'No termite bond on file', cancelReason: 'not_termite_bond' });
  }
  if (template.key === 'estimate_sent' && await estimateAcceptedForFollowUp(enrollment)) {
    return blockSendAndCancelEnrollment({ enrollment, sendId,
      reason: 'The customer accepted the estimate', cancelReason: 'estimate_accepted' });
  }
  return null;
}

// A payment-failed notice is billing mail, so it goes through the shared
// billing email authority (owner ruling 2026-09-27): only to the customer's
// CURRENT billing recipient, with the switch, the payment-issue channel
// choice, the recipient and suppressions (this automation's own group
// included) rechecked under the authority's locks and held through the
// provider request. A billing recipient changed since enrollment re-points
// the enrollment, and the step is re-rendered for them on the next tick.
async function sendPaymentFailedThroughBillingAuthority({ enrollment, template, recipient, sendId, dispatch }) {
  const { loadBillingEmailContext, dispatchUnderBillingEmailAuthority, blocked } = require('./billing-channel-email-authority');
  // Collections DISPUTE hold (owner ruling 2026-09-30): the payment-failed email carries an
  // update-card / pay CTA. Checked here and again under the authority's locks right before the
  // provider request (fail closed); a hold leaves the step due (retryable) - it goes out after
  // the release, never during the dispute.
  const holdCollections = require('./collections/collection-hold');
  const holdBlock = (held) => blocked('COLLECTION_HOLD_DEFER', held.reason === 'lookup_failed'
    ? 'The collections dispute-hold lookup failed; payment-failed email deferred'
    : 'Customer has an active collections dispute hold; payment-failed email deferred', { retryable: true });
  const upFront = await holdCollections.messagingHeldByCollectionHold(enrollment.customer_id);
  if (upFront.held) return settlePaymentFailedRefusal({ enrollment, sendId, block: holdBlock(upFront) });
  const input = {
    customerId: enrollment.customer_id, channel: 'email',
    metadata: { billingDeliveryCategory: 'payment_issue' },
  };
  let context;
  try {
    context = await loadBillingEmailContext(input);
  } catch (err) {
    logger.warn(`[automation-runner] payment-failed billing email context unavailable enrollment=${enrollment.id}: ${err.message}`);
    context = { error: blocked('BILLING_EMAIL_RECHECK_FAILED', 'Billing email authority could not be verified', { retryable: true }) };
  }
  if (context.error) return settlePaymentFailedRefusal({ enrollment, sendId, block: context.error });
  const normalizedEmail = (value) => String(value || '').trim().toLowerCase();
  if (normalizedEmail(context.recipientEmail) !== normalizedEmail(recipient)) {
    return repointPaymentFailedEnrollment({ enrollment, sendId, current: context.recipient, email: context.recipientEmail });
  }
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  let res;
  await dispatchUnderBillingEmailAuthority({
    input,
    recipientEmail: context.recipientEmail,
    // The hold rides the authority's preSendCheck, which the authority re-runs at the FINAL
    // provider boundary (after SendGrid's request preparation, right before the fetch) as well
    // as before dispatch - a hold committed while the request is prepared is caught there, not
    // only at this one-time pre-dispatch read. Refusals are the retryable COLLECTION_HOLD_DEFER.
    preSendCheck: async ({ database } = {}) => {
      const heldNow = await holdCollections.messagingHeldByCollectionHold(enrollment.customer_id, database);
      if (!heldNow.held) return { ok: true };
      const refusal = holdBlock(heldNow);
      return { ok: false, code: refusal.code, reason: refusal.reason, retryable: true };
    },
    emailSuppression: async (trx, email) => {
      const suppression = await activeAutomationSuppressionFor(template, email, trx);
      return suppression ? blocked('EMAIL_SUPPRESSED', automationSuppressionReason(suppression)) : null;
    },
    // The authority's final check runs inside sendOne, after its own
    // provider preparation and right before the request.
    dispatch: async (_trx, providerBoundaryCheck) => { res = await dispatch(providerBoundaryCheck); },
    state,
  });
  if (state.boundaryBlock) return settlePaymentFailedRefusal({ enrollment, sendId, block: state.boundaryBlock });
  return res;
}

// A collections dispute hold is a WAIT (owner ruling 2026-09-30): the step is not attempted, so
// it leaves no failed step-send row (a queued row already inserted for it is removed) and the
// enrollment moves to a bounded recheck time instead of staying overdue - an overdue held
// enrollment would be re-picked every minute and could fill the runner's 50-row page ahead of
// unrelated automations. After the release the next tick past that time sends it.
async function deferPaymentFailedForHold({ enrollment, sendId = null, reason }) {
  if (sendId) await db('automation_step_sends').where({ id: sendId }).del();
  await db('automation_enrollments').where({ id: enrollment.id, status: 'active' }).update({
    next_send_at: new Date(Date.now() + require('./collections/collection-hold').HOLD_DEFER_MS),
    updated_at: new Date(),
  });
  return { sent: false, deferred: true, held: true, reason };
}

// A refusal that stands until the customer's record changes cancels the
// enrollment, as before. One the authority marks retryable (a recheck that
// could not run, a recipient that moved mid-send) leaves the step due for
// the next tick. A deselected Email is final here: a routed billing leg
// re-reads it as a schedulable hold, but nothing re-reads it for this step.
async function settlePaymentFailedRefusal({ enrollment, sendId, block }) {
  const reason = String(block.reason || block.code || 'Billing email refused');
  if (block.code === 'COLLECTION_HOLD_DEFER') return deferPaymentFailedForHold({ enrollment, sendId, reason });
  if (block.retryable === true && block.code !== 'BILLING_PREFERENCES_CHANGED') {
    await db('automation_step_sends').where({ id: sendId }).update({
      status: 'failed', failure_reason: reason.slice(0, 500), updated_at: new Date(),
    });
    return { sent: false, deferred: true, reason };
  }
  const cancelReason = block.code === 'BILLING_PREFERENCES_CHANGED'
    ? 'billing_email_deselected' : String(block.code || 'billing_email_refused').toLowerCase();
  return blockSendAndCancelEnrollment({ enrollment, sendId, reason, cancelReason });
}

async function repointPaymentFailedEnrollment({ enrollment, sendId, current, email }) {
  const parts = String(current?.name || '').trim().split(/\s+/).filter(Boolean);
  await db('automation_step_sends').where({ id: sendId }).update({
    status: 'blocked', failure_reason: 'Billing recipient changed since enrollment', updated_at: new Date(),
  });
  await db('automation_enrollments').where({ id: enrollment.id, current_step: enrollment.current_step }).update({
    email,
    ...(parts.length ? { first_name: parts[0], last_name: parts.slice(1).join(' ') || null } : {}),
    updated_at: new Date(),
  });
  logger.warn(`[automation-runner] enrollment=${enrollment.id} re-pointed to the current billing recipient`);
  return { sent: false, deferred: true, reason: 'billing_recipient_changed' };
}

// {{consultation_booking}} / {{consultation_booking_text}} — the new_lead
// email's recurring-lead booking block (lead-consultation-email-block.js).
// Defaulted to '' so every existing caller (testSequence, and any step
// whose body never carries the placeholder) renders byte-identical to
// before these params existed.
function renderAutomationStepContent({ template, htmlBody, textBody, customer, asmGroupId, consultationHtml = '', consultationText = '' }) {
  const rawHtml = substitute(htmlBody || '', customer, { html: true }).replace(CONSULTATION_HTML_RE, withSeparator(consultationHtml));
  const rawText = substitute(textBody || '', customer).replace(CONSULTATION_TEXT_RE, withSeparator(consultationText));
  const unsubscribeUrl = asmGroupId ? ASM_UNSUBSCRIBE_URL : null;
  // Every automation renders the service chrome — "Waves Newsletter"
  // header is reserved for actual newsletter sends (owner call 2026-07-10;
  // the new_lead intro was going out dressed as the newsletter). Marketing-
  // stream automations (asm_group='newsletter') stay on the marketing ASM/
  // suppression group, so the visible unsubscribe link must survive the
  // wrapper swap — same pattern as referral.invite in email-template-library.
  const unsubFooter = isNewsletterAutomation(template) && unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:${blockPalette().footerLink};text-decoration:underline;">Unsubscribe</a> from these emails.`
    : null;
  const html = rawHtml
    ? wrapServiceEmail({ body: rawHtml, footerNote: unsubFooter })
    : '';
  const text = isNewsletterAutomation(template)
    ? ensureLegalTextFooter(rawText, { unsubscribeUrl })
    : rawText;
  return { html, text };
}

/**
 * Does this template have *any* enabled step with an html or text body?
 * Used by the cutover gate in email-automations.js — if yes, the local
 * sender runs; if no, Beehiiv handles it (legacy fallback).
 */
async function hasLocalContent(templateKey) {
  const row = await db('automation_steps')
    .where({ template_key: templateKey, enabled: true })
    .where(function () { this.whereNotNull('html_body').orWhereNotNull('text_body'); })
    .where(function () { this.whereRaw("coalesce(html_body,'') <> ''").orWhereRaw("coalesce(text_body,'') <> ''"); })
    .first();
  return !!row;
}

/**
 * Enroll a customer into a template's sequence. Idempotent on customer id
 * when present, otherwise on normalized lead email for lead-only estimates.
 * If there are no enabled steps, returns { enrolled: false }.
 * `dbh` lets a caller run the whole enrollment on its own transaction (the
 * appointment tagger holds a per-customer advisory lock and must not need a
 * second pooled connection while doing so).
 */
async function enrollCustomer({ templateKey, customer, dbh = db, commsLockMode = 'block', context = {} }) {
  const template = await dbh('automation_templates').where({ key: templateKey }).first();
  if (!template) throw new Error(`Unknown automation template: ${templateKey}`);
  if (!template.enabled) return { enrolled: false, reason: 'template disabled' };
  if (!customer?.email) return { enrolled: false, reason: 'no email' };
  const normalizedEmail = String(customer.email || '').trim().toLowerCase();
  if (!normalizedEmail) return { enrolled: false, reason: 'no email' };
  // A lead-email-only enrollment has no customer row, so it can have no
  // termite bond (see the post-lock check in runEnrollment).
  if (requiresTermiteBond(templateKey) && !customer.id) return { enrolled: false, reason: 'not_termite_bond' };

  const steps = await dbh('automation_steps')
    .where({ template_key: templateKey, enabled: true })
    .orderBy('step_order', 'asc');
  if (!steps.length) return { enrolled: false, reason: 'no steps' };

  const leadId = await enrollmentLeadIdFor({ templateKey, customer, normalizedEmail, context });
  // Whose address this enrollment mails, when the enqueue resolved it to an
  // on-location contact (project-email.js resolveProjectEmailRecipientForSend
  // role): the step's dispatch-time contact recheck reads it back (codex
  // #6363 r10 P1). Absent for the holder's and third-party addresses.
  const recipientRole = require('./customer-contact').isServiceContactRole(context.recipientRole) ? String(context.recipientRole) : null;
  // The estimate whose send enrolled this episode (estimate_sent): the
  // delivery check reads it back (estimateAcceptedForFollowUp).
  const estimateId = context.estimateId ? String(context.estimateId) : null;

  // Customer-linked enrollment mutations serialize with a concurrent
  // merge-undo (r21): the undo's active-enrollment absence probe runs
  // under `customer-comms:<id>`, and an unfenced insert/reactivation
  // carrying an inherited email/name snapshot could commit AFTER the undo
  // cleared those fields — the scheduler would then send the winner's
  // sequence to the restored loser's mailbox. The active-row read and the
  // insert/reactivation ride one locked transaction; a caller-provided
  // transaction (the appointment tagger) takes the same key inline.
  // Lead-email-only enrollments (no customer id) stay unfenced — the
  // undo's probes are winner-scoped.
  const runEnrollment = async (conn) => {
    // Post-lock revalidation (r22 — resolve → lock → re-resolve): the
    // caller's customer snapshot may predate an undo this acquisition just
    // waited out. Callers legitimately pass addresses that differ from the
    // customers row (a public-quote requester's email, a fresh call
    // capture), so the row's value is NOT blindly adopted — instead, the
    // resolveRecipientUnderLock rule: an address that NOW belongs to a
    // live customer OTHER than this one is someone else's registered
    // mailbox (typically the restored loser holding back the inherited
    // email) and must not be enrolled. True third-party addresses are not
    // customer rows and fall through unchanged.
    let enrollTarget = customer;
    if (customer.id) {
      const fresh = await conn('customers')
        .where({ id: customer.id })
        .first('id', 'email', 'first_name', 'last_name', 'deleted_at', 'termite_renewal_date');
      if (!fresh || fresh.deleted_at) return { enrolled: false, reason: 'customer gone' };
      // Every enrollment path (manual trigger, segment send, executeAutomation)
      // passes here. The bond is read off this post-lock row, not the caller's
      // snapshot, which may not carry the column at all.
      if (requiresTermiteBond(templateKey) && !fresh.termite_renewal_date) {
        return { enrolled: false, reason: 'not_termite_bond' };
      }
      const liveEmail = String(fresh.email || '').trim().toLowerCase();
      if (normalizedEmail !== liveEmail) {
        // Merge-specific evidence only (r30), checked across EVERY live
        // holder of the address (r31 — sampling one arbitrary holder could
        // pick a spouse/tenant and miss the restored loser sharing the
        // same mailbox): one joined existence query — any live customer at
        // this address who is the LOSER of an UNDONE merge whose winner is
        // this customer blocks; shared household addresses and
        // different-by-design recipients still enroll. Unreadable → block
        // (conservative posture).
        let undoneHolder = { id: 'unverifiable' };
        try {
          undoneHolder = await conn('customers as c')
            .join('customer_merge_journal as j', function joinUndone() {
              this.on('j.loser_customer_id', 'c.id');
            })
            .where('j.winner_customer_id', customer.id)
            .whereNotNull('j.undone_at')
            .whereRaw('lower(c.email) = ?', [normalizedEmail])
            .whereNot('c.id', customer.id)
            .where('c.active', true)
            .whereNull('c.deleted_at')
            .first('c.id');
        } catch { /* keep the conservative block */ }
        if (undoneHolder) {
          return { enrolled: false, reason: 'address was restored to the merged-away customer by an undo (stale pre-undo address)' };
        }
      }
      // Names come from the POST-LOCK row when it has them (r23 P2): the
      // caller's snapshot can carry a merge-loser name an undo just
      // restored away, and the scheduler renders greetings from the
      // STORED enrollment fields. The snapshot only fills a blank row
      // (fresh call captures naming a customer the row never had).
      enrollTarget = {
        ...customer,
        first_name: fresh.first_name || customer.first_name || null,
        last_name: fresh.last_name || customer.last_name || null,
      };
    }
    return enrollCustomerLocked({ conn, templateKey, customer: enrollTarget, normalizedEmail, steps, leadId, recipientRole, estimateId });
  };
  if (!customer.id) return runEnrollment(dbh);
  if (dbh.isTransaction) {
    // TRY-lock ONLY for callers that declare it (r33 — the r23 blanket
    // try-lock silently dropped enrollments for transactional callers with
    // no retry path, e.g. the appointment tagger's first-treatment
    // sequence): a caller holding undo-contended row locks (the
    // first-touch release holds its hold row FOR UPDATE, which the undo
    // reverse-repoints) passes commsLockMode:'try' and handles the
    // retryable customer_comms_busy result. Everyone else gets the safe
    // BLOCKING acquire — their transactions hold only fresh/uncontended
    // rows, and waiting out a brief undo is exactly right.
    if (commsLockMode === 'try') {
      if (!(await tryLockCustomerComms(dbh, customer.id))) {
        return { enrolled: false, reason: 'customer_comms_busy', retryable: true };
      }
    } else {
      await lockCustomerComms(dbh, customer.id);
    }
    return runEnrollment(dbh);
  }
  return db.transaction(async (trx) => {
    await lockCustomerComms(trx, customer.id);
    return runEnrollment(trx);
  });
}

// Lead-aware callers (lead-webhook, public-quote, public-newsletter,
// lead-first-touch-resume, call-recording-processor) always pass the
// `leadId` key — even as null/undefined — and own that decision. Every other
// new_lead enroll (admin manual + bulk trigger, the email-automations
// dispatcher, automation-enroll) knows only the customer, so the
// consultation block would render empty. For those, the lead is the
// customer's newest non-deleted, still-open lead whose email is this
// recipient — the same newest-open-lead rule as composer-customer-links.js's
// buildConsultationLink, narrowed to the recipient because the block only
// renders for the lead's own address. The block re-checks the lead at send
// time, so this lookup is a pointer, not a trust decision. Runs on the
// shared pool before the comms lock (new_lead has no transactional caller)
// and fails soft: no lead id, email unchanged.
async function enrollmentLeadIdFor({ templateKey, customer, normalizedEmail, context }) {
  if (Object.prototype.hasOwnProperty.call(context, 'leadId')) return context.leadId;
  if (templateKey !== 'new_lead' || !customer.id) return undefined;
  try {
    const { applyOpenLeadPredicate } = require('./lead-statuses');
    const lead = await applyOpenLeadPredicate(
      db('leads')
        .where({ customer_id: customer.id })
        .whereNull('deleted_at')
        .whereRaw('lower(email) = ?', [normalizedEmail])
    )
      .orderBy('created_at', 'desc')
      .first('id');
    return lead?.id || undefined;
  } catch (err) {
    logger.warn(`[automation] new_lead lead lookup failed for customer ${customer.id}: ${err.message}`);
    return undefined;
  }
}

async function enrollCustomerLocked({ conn: dbh, templateKey, customer, normalizedEmail, steps, leadId, recipientRole = null, estimateId = null }) {
  const existingQuery = dbh('automation_enrollments').where({ template_key: templateKey });
  if (customer.id) {
    existingQuery.where({ customer_id: customer.id });
  } else {
    existingQuery.whereNull('customer_id').whereRaw('lower(email) = ?', [normalizedEmail]);
  }
  const existing = await existingQuery
    .orderByRaw("CASE WHEN status = 'active' THEN 0 ELSE 1 END")
    .orderBy('updated_at', 'desc')
    .first();
  if (existing && existing.status === 'active') {
    return { enrolled: false, reason: 'already enrolled', enrollmentId: existing.id };
  }

  const firstStep = steps[0];
  const nextSendAt = new Date(Date.now() + (firstStep.delay_hours || 0) * 3600 * 1000);
  const reactivatePayload = {
    status: 'active',
    current_step: 0,
    next_send_at: nextSendAt,
    enrolled_at: new Date(),
    updated_at: new Date(),
    // A reactivation starts a NEW episode: nothing has sent in it yet, so the
    // delivery stamp resets with the cursor. Leaving the old last_sent_at in
    // place made a later fail-before-send read as delivered coverage in the
    // event-enrollment dedupe (automation-enroll.js) and suppressed the
    // transactional dunning fallback.
    last_sent_at: null,
    // Refresh the denormalized contact fields on reactivation — the scheduler
    // sends to the ROW's email, so re-enrolling a customer who changed their
    // address must not keep queueing steps to the stale one.
    email: normalizedEmail,
    first_name: customer.first_name || null,
    last_name: customer.last_name || null,
  };
  // The enrolling lead id (new_lead's consultation-booking block reads
  // `metadata.lead_id` at send time) — merged in, never a whole-object
  // overwrite, so a pre-existing metadata key (e.g. cancel_reason from a
  // prior cancelled episode) survives a reactivation.
  // A context-free reactivation (manual/admin or generic enroll) must NOT
  // inherit a prior episode's lead — the block would mint that lead's link
  // for an enrollment that is supposed to render it empty (Codex #4813 r1
  // P2). Drop just the key; unrelated metadata survives.
  // Table-qualified (Codex #4813 r4 P1): the same payload is the
  // ON CONFLICT ... DO UPDATE merge below, where a bare `metadata` is
  // ambiguous between the target row and EXCLUDED and fails the insert.
  // The recipient_role stamp (whose address this episode mails — codex
  // #6363 r10 P1) is this episode's fact too: set when the enqueue resolved
  // an on-location contact, dropped otherwise. So is estimate_id: the
  // estimate whose send started this episode, never a prior episode's. So
  // is the sequence cursor (passed_step_*): the new episode starts again at
  // the first step.
  const stamps = {
    ...(leadId ? { lead_id: leadId } : {}),
    ...(recipientRole ? { recipient_role: recipientRole } : {}),
    ...(estimateId ? { estimate_id: estimateId } : {}),
  };
  reactivatePayload.metadata = dbh.raw(
    "(COALESCE(automation_enrollments.metadata,'{}'::jsonb) - 'lead_id' - 'recipient_role' - 'estimate_id' - 'passed_step_order' - 'passed_step_id' - 'passed_step_ids') || ?::jsonb",
    [JSON.stringify(stamps)],
  );
  if (existing) {
    const [reactivated] = await dbh('automation_enrollments')
      .where({ id: existing.id })
      .update(reactivatePayload)
      .returning('*');
    return { enrolled: true, enrollmentId: reactivated.id };
  }

  const payload = {
    template_key: templateKey,
    customer_id: customer.id || null,
    email: normalizedEmail,
    first_name: customer.first_name || null,
    last_name: customer.last_name || null,
    status: 'active',
    current_step: 0,
    next_send_at: nextSendAt,
    ...(Object.keys(stamps).length ? { metadata: JSON.stringify(stamps) } : {}),
  };

  let row;
  if (customer.id) {
    [row] = await dbh('automation_enrollments')
      .insert(payload)
      .returning('*')
      .onConflict(['template_key', 'customer_id'])
      .merge(reactivatePayload);
  } else {
    try {
      [row] = await dbh('automation_enrollments').insert(payload).returning('*');
    } catch (err) {
      if (err.code !== '23505') throw err;
      [row] = await dbh('automation_enrollments')
        .where({ template_key: templateKey })
        .whereNull('customer_id')
        .whereRaw('lower(email) = ?', [normalizedEmail])
        .update(reactivatePayload)
        .returning('*');
    }
  }

  return { enrolled: true, enrollmentId: row.id };
}

// Where an enrollment is in its sequence (owner 2026-10-31, weekly sweep #4616
// B1, option A). The place is the last step the enrollment PASSED: sent, settled
// by a manual prep delivery (prep-guide-sender), or an empty step moved past. It
// is kept in metadata.passed_step_order / passed_step_id, with every passed step
// id in passed_step_ids. The next step is the first enabled step after it, in
// (step_order, id) order, that this episode has not passed. Before, the place
// was a count of enabled steps, so turning a step off, turning an old one back
// on, deleting one or moving one shifted every customer partway through: they
// skipped an email or got one twice. current_step stays the index of the next
// step in the enabled list (prep-guide-sender reads 0 as "awaiting the first
// step"). An enrollment last advanced before this change has no metadata cursor:
// its place is the enabled step just before current_step, which is the step it
// would have sent next anyway.
function enabledSequenceSteps(templateKey) {
  return db('automation_steps')
    .where({ template_key: templateKey, enabled: true })
    .orderBy('step_order', 'asc')
    .orderBy('id', 'asc');
}

const stepKey = (step) => [Number(step.step_order), String(step.id)];
const keyAfter = ([order, id], [anchorOrder, anchorId]) => order > anchorOrder || (order === anchorOrder && id > anchorId);

function enrollmentMetadata(enrollment) {
  const raw = enrollment.metadata;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

function sequenceCursor(enrollment, steps) {
  const meta = enrollmentMetadata(enrollment);
  const passedIds = Array.isArray(meta.passed_step_ids) ? meta.passed_step_ids.map(String) : [];
  const order = meta.passed_step_order;
  if (order !== null && order !== undefined && order !== '' && Number.isFinite(Number(order))) {
    return { anchor: [Number(order), String(meta.passed_step_id ?? '')], passedIds };
  }
  const index = Number(enrollment.current_step) || 0;
  const legacy = index >= 1 ? steps[Math.min(index, steps.length) - 1] : null;
  return { anchor: legacy ? stepKey(legacy) : null, passedIds };
}

function firstStepAfter(steps, anchor, passedIds) {
  const passed = new Set(passedIds);
  return steps.find((s) => !passed.has(String(s.id)) && (!anchor || keyAfter(stepKey(s), anchor))) || null;
}

function nextSequenceStep(enrollment, steps) {
  const { anchor, passedIds } = sequenceCursor(enrollment, steps);
  return firstStepAfter(steps, anchor, passedIds);
}

/**
 * Send one step for an enrollment. Advances the cursor on success,
 * marks the enrollment complete if it was the last step, or failed
 * if SendGrid rejects.
 */
// Treatment-sequence templates whose FIRST enabled step carries the prep
// guide. When that step actually sends, the enrolled customer's token-bearing
// visit rows (minted by the appointment tagger at enroll time) get their
// prep_sent_at confirmed-delivery stamp — the tracker's prep link gates on
// it. Fail-soft: a stamp hiccup never fails a step that already sent.
const PREP_TEMPLATE_BY_SEQUENCE_KEY = Object.freeze({
  bed_bug: 'prep.bed_bug',
  cockroach: 'prep.cockroach',
  flea: 'prep.flea',
});

async function stampPrepSentForSequence(enrollment, step, steps) {
  const prepKey = PREP_TEMPLATE_BY_SEQUENCE_KEY[enrollment.template_key];
  if (!prepKey || !enrollment.customer_id) return;
  if (!steps.length || step.id !== steps[0].id) return;
  try {
    await db('scheduled_services')
      .where({ customer_id: enrollment.customer_id, prep_template_key: prepKey })
      .whereNotNull('prep_token')
      .whereNull('prep_sent_at')
      .update({ prep_sent_at: db.fn.now() });
  } catch (err) {
    logger.warn(`[automation-runner] prep_sent_at stamp failed for enrollment ${enrollment.id}: ${err.message}`);
  }
}

// A customer-linked step runs under the customer's prep-send lock — the one
// the manual sender, the composer's prep-link text and the executor's prep
// step hold while they deliver and settle (prep-guide-sender
// settleHeldEnrollment advances the cursor). Without it a settle can land
// between this read and the send, so the step goes out twice and a later
// failure write marks the advanced enrolment failed (pre-push Codex P1 on
// 2256101b7). Held lease = not this tick: the row stays due and the next
// tick retries. The tick already holds the runner's own lock, so this nests
// on its session (try-lock, never a wait).
async function sendStep(enrollmentId, { testRecipient } = {}) {
  const pre = await db('automation_enrollments').where({ id: enrollmentId }).first();
  if (!pre) throw new Error('enrollment not found');
  if (pre.status !== 'active') throw new Error(`enrollment status is ${pre.status}`);
  // No customer, no settler to race: the row just read is the row.
  if (!pre.customer_id) return sendStepLocked(pre, { testRecipient });
  const outcome = await runExclusive(`prep-send:${pre.customer_id}`, async () => {
    // Re-read under the lock: a row a settle just advanced or finished is
    // not this step any more.
    const enrollment = await db('automation_enrollments').where({ id: enrollmentId }).first();
    if (!enrollment) throw new Error('enrollment not found');
    if (enrollment.status !== 'active') throw new Error(`enrollment status is ${enrollment.status}`);
    // …and still due: a settle that advanced it since the tick's pick
    // scheduled the follow-up from its own delay — that step is not sent
    // now. An explicit test send ignores the schedule as it always did.
    if (!testRecipient && enrollment.next_send_at && new Date(enrollment.next_send_at).getTime() > Date.now()) {
      return { sent: false, skipped: true, reason: 'not_due' };
    }
    return sendStepLocked(enrollment, { testRecipient });
  }, { recordHealth: false, waitForSlot: false });
  if (wasLockSkipped(outcome)) {
    logger.info(`[automation-runner] enrollment ${enrollmentId} skipped this tick: customer prep lock ${outcome.reason}`);
    return { sent: false, skipped: true, reason: outcome.reason };
  }
  return outcome;
}

const EMPTY_CONSULTATION_BLOCK = { html: '', text: '' };

// The enrolling lead id stamped by enrollCustomer's `context.leadId`
// (automation_enrollments.metadata jsonb). node-pg parses jsonb columns to
// plain objects, but a defensive string-parse matches the rest of this
// codebase's metadata readers (e.g. inspection-public.js's
// latestProvenance) in case a caller ever hands this a raw driver row.
function enrollmentLeadId(enrollment) {
  const meta = enrollment?.metadata;
  if (!meta) return null;
  const obj = typeof meta === 'string' ? (() => { try { return JSON.parse(meta); } catch { return null; } })() : meta;
  return obj?.lead_id || null;
}

// Only bothers building the consultation block when the step's own body
// actually carries a placeholder for it — every other template/step skips
// the lead lookup and availability query entirely. Never throws: a lead id
// with no eligible lead, or any downstream error, is buildConsultationEmailBlock's
// own fail-closed '' — this wrapper's only job is the cheap skip.
async function resolveConsultationBlock(step, enrollment, recipient) {
  const body = `${step.html_body || ''}${step.text_body || ''}`;
  // Same whitespace-tolerant shape the renderer replaces (Codex #4813 r4
  // P2) — `{{ consultation_booking }}` must build the block too.
  if (!CONSULTATION_PLACEHOLDER_RE.test(body)) return EMPTY_CONSULTATION_BLOCK;
  const leadId = enrollmentLeadId(enrollment);
  if (!leadId) return EMPTY_CONSULTATION_BLOCK;
  const { buildConsultationEmailBlock } = require('./lead-consultation-email-block');
  // The ACTUAL recipient rides along (testRecipient || enrollment.email —
  // the address the mail goes to, pre-push audit P1): the block mints a
  // bearer link only when that address is the lead's OWN email, so an
  // operator test-send to another inbox gets the block empty.
  return buildConsultationEmailBlock({ leadId, recipientEmail: recipient });
}

// The address a step goes to: the enrollment's, unless it is the slot-1
// on-location contact's and that contact has turned their email off since
// enqueue (contact-notification-prefs.js rerouteForContactEmailOptOut) —
// then the account holder's, or a blocked send + cancelled enrollment when
// the holder has none. Test sends are never re-pointed.
async function stepRecipientAfterContactOptOut(enrollment, step, testRecipient) {
  const recipient = testRecipient || enrollment.email;
  if (testRecipient || !enrollment.customer_id) return { recipient };
  // Whose address the enrollment carries is the enqueue's stamp
  // (metadata.recipient_role), never inferred from the address (codex
  // #6363 r10 P1): an enrollment mailing a third party keeps its address.
  const reroute = await require('./contact-notification-prefs')
    .rerouteForContactEmailOptOut(enrollment.customer_id, recipient, { recipientRole: enrollment.metadata?.recipient_role || null });
  if (!reroute.rerouted) return { recipient };
  if (reroute.email) return { recipient: reroute.email };
  const sendRow = await db('automation_step_sends').insert({
    enrollment_id: enrollment.id, step_id: step.id, step_order: step.step_order, email: recipient, status: 'queued',
  }).returning('*').then((rows) => rows[0]);
  const blocked = await blockSendAndCancelEnrollment({ enrollment, sendId: sendRow.id,
    reason: 'The on-location contact turned email off and the account holder has no email address', cancelReason: 'email_suppressed' });
  return { blocked };
}

// The SAME contact recheck again at the FINAL provider boundary (codex #6363
// r30 P2): stepRecipientAfterContactOptOut runs before the render, and a
// contact who turns email off, or whom the holder removes, during the
// delivery checks and SendGrid's own request preparation would still be
// mailed. sendOne runs this after every one of its awaits, immediately
// before the request; a changed answer throws CONTACT_RECIPIENT_CHANGED,
// which sendStepLocked turns into a held step (nothing sent). An unreadable
// row propagates the same way as the early check's. null for a test send or
// an enrollment with no customer (nothing to re-resolve). The payment-failed
// step rides the billing authority's own boundary check instead.
const CONTACT_RECIPIENT_CHANGED = 'CONTACT_RECIPIENT_CHANGED';
function contactRecipientBoundaryCheck(enrollment, recipient, testRecipient) {
  if (testRecipient || !enrollment.customer_id) return null;
  return async () => {
    const again = await require('./contact-notification-prefs')
      .rerouteForContactEmailOptOut(enrollment.customer_id, recipient, { recipientRole: enrollment.metadata?.recipient_role || null });
    if (again.rerouted) {
      throw Object.assign(new Error('the on-location contact\'s address or email choice changed before the provider handoff'), {
        code: CONTACT_RECIPIENT_CHANGED, providerBoundaryBlocked: true,
      });
    }
    return { ok: true };
  };
}

// A non-billing step's provider request under that check. A step held there
// sent nothing: its queued row goes and the step stays due — the next tick
// re-resolves it (the holder, or a blocked send when the holder has no
// address). Every other failure is the caller's as before.
async function dispatchUnderContactBoundary({ dispatch, enrollment, step, recipient, testRecipient, sendId }) {
  try {
    return await dispatch(contactRecipientBoundaryCheck(enrollment, recipient, testRecipient));
  } catch (err) {
    if (err.code !== CONTACT_RECIPIENT_CHANGED) throw err;
    logger.info(`[automation-runner] enrollment ${enrollment.id} step ${step.step_order} held at the provider boundary: ${err.message}`);
    await db('automation_step_sends').where({ id: sendId }).del();
    return { sent: false, deferred: true, reason: err.message };
  }
}

async function sendStepLocked(enrollment, { testRecipient } = {}) {
  const enrollmentId = enrollment.id;
  const template = await db('automation_templates').where({ key: enrollment.template_key }).first();
  if (!template) throw new Error('template missing');

  const steps = await enabledSequenceSteps(enrollment.template_key);

  const step = nextSequenceStep(enrollment, steps);
  if (!step) {
    // No step left after the last one passed — treat as completed.
    await db('automation_enrollments').where({ id: enrollmentId }).update({
      status: 'completed', completed_at: new Date(), next_send_at: null, updated_at: new Date(),
    });
    return { done: true };
  }
  if (!step.html_body && !step.text_body) {
    // Empty step — skip and advance.
    return advanceEnrollment(enrollment, steps, step);
  }

  const personal = {
    first_name: enrollment.first_name || '',
    last_name: enrollment.last_name || '',
    email: enrollment.email,
  };

  const subject = substitute(step.subject || `(${template.name})`, personal);
  const asmGroupId = automationAsmGroupId(template);
  const fromEmail = normalizeAutomationFromEmail(step.from_email);
  // Dispatch-time recheck (codex #6363 r7 P1): an enrollment addressed to
  // the slot-1 on-location contact follows that contact's email switch — off
  // since enqueue means the step goes to the account holder, or is blocked
  // when the holder has no address. Test sends are never re-pointed.
  const routed = await stepRecipientAfterContactOptOut(enrollment, step, testRecipient);
  if (routed.blocked) return routed.blocked;
  const { recipient } = routed;
  const consultationBlock = await resolveConsultationBlock(step, enrollment, recipient);
  const { html, text } = renderAutomationStepContent({
    template,
    htmlBody: step.html_body,
    textBody: step.text_body,
    customer: personal,
    asmGroupId,
    consultationHtml: consultationBlock.html,
    consultationText: consultationBlock.text,
  });

  const billingSend = template.key === 'payment_failed' && !!enrollment.customer_id && !testRecipient;
  // Collections DISPUTE hold: read BEFORE the step-send row is inserted, so a held step leaves no
  // row at all (sendPaymentFailedThroughBillingAuthority re-checks under the authority's locks).
  if (billingSend) {
    const upFront = await require('./collections/collection-hold').messagingHeldByCollectionHold(enrollment.customer_id);
    if (upFront.held) {
      return deferPaymentFailedForHold({ enrollment, reason: upFront.reason === 'lookup_failed'
        ? 'The collections dispute-hold lookup failed; payment-failed email deferred'
        : 'Customer has an active collections dispute hold; payment-failed email deferred' });
    }
  }

  const sendRow = await db('automation_step_sends').insert({
    enrollment_id: enrollment.id,
    step_id: step.id,
    step_order: step.step_order,
    email: recipient,
    status: 'queued',
  }).returning('*').then((rows) => rows[0]);

  const deliveryBlock = await automationDeliveryBlock({ enrollment, template, recipient,
    sendId: sendRow.id, testRecipient, billingSend });
  if (deliveryBlock) return deliveryBlock;

  const dispatch = (providerBoundaryCheck) => sendgrid.sendOne({
    to: recipient,
    fromEmail,
    fromName: step.from_name,
    replyTo: step.reply_to,
    subject: testRecipient ? `[TEST] ${subject}` : subject,
    html: html || undefined,
    text: text || undefined,
    categories: ['automation', `template_${template.key}`, `step_${step.step_order}`],
    asmGroupId,
    ...(providerBoundaryCheck ? { providerBoundaryCheck } : {}),
  });
  try {
    const res = billingSend
      ? await sendPaymentFailedThroughBillingAuthority({ enrollment, template, recipient, sendId: sendRow.id, dispatch })
      : await dispatchUnderContactBoundary({ dispatch, enrollment, step, recipient, testRecipient, sendId: sendRow.id });
    if (res?.sent === false) return res;

    await db('automation_step_sends').where({ id: sendRow.id }).update({
      status: 'sent',
      sendgrid_message_id: res.messageId,
      sent_at: new Date(),
      updated_at: new Date(),
    });

    // For test sends we don't advance the enrollment — only real sends do.
    if (testRecipient) return { sent: true, messageId: res.messageId, test: true };

    await stampPrepSentForSequence(enrollment, step, steps);

    return advanceEnrollment(enrollment, steps, step);
  } catch (err) {
    logger.error(`[automation-runner] send failed enrollment=${enrollment.id} step=${step.step_order}: ${err.message}`);
    await db('automation_step_sends').where({ id: sendRow.id }).update({
      status: 'failed',
      failure_reason: err.message.slice(0, 500),
      updated_at: new Date(),
    });
    if (testRecipient) throw err;

    // Mark enrollment failed so it stops retrying. Operator can re-enroll
    // later. Fenced on the step this attempt was for.
    await db('automation_enrollments').where({ id: enrollment.id, current_step: enrollment.current_step }).update({
      status: 'failed', next_send_at: null, updated_at: new Date(),
    });
    return { sent: false, error: err.message };
  }
}

// Moves an enrolment past a step: the one it just delivered or skipped (the
// runner passes it), or, when the caller names none (prep-guide-sender's
// settleHeldEnrollment after a manual prep delivery), the step it was due to
// send next. The next step is scheduled from its own delay, or the enrolment
// completes when none remain. Fenced on the cursor the caller saw (current_step
// and the last passed step id), so two settlers of one step (the tick and a
// manual / composer prep delivery) cannot advance it twice. Steps are loaded
// when the caller has none.
async function advanceEnrollment(enrollment, steps = null, passedStep = null) {
  if (!steps) steps = await enabledSequenceSteps(enrollment.template_key);
  const { passedIds } = sequenceCursor(enrollment, steps);
  const passed = passedStep || nextSequenceStep(enrollment, steps);
  const next = passed ? firstStepAfter(steps, stepKey(passed), [...passedIds, String(passed.id)]) : null;
  const priorPassedId = String(enrollmentMetadata(enrollment).passed_step_id ?? '');
  const cursor = passed ? {
    passed_step_order: Number(passed.step_order),
    passed_step_id: String(passed.id),
    passed_step_ids: [...new Set([...passedIds, String(passed.id)])],
  } : null;
  const write = (patch) => db('automation_enrollments')
    .where({ id: enrollment.id, current_step: enrollment.current_step })
    .whereRaw("COALESCE(metadata->>'passed_step_id', '') = ?", [priorPassedId])
    .update({
      ...patch,
      ...(cursor ? { metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(cursor)]) } : {}),
      last_sent_at: new Date(),
      updated_at: new Date(),
    });
  if (!next) {
    await write({ status: 'completed', completed_at: new Date(), next_send_at: null, current_step: steps.length });
    return { sent: true, done: true };
  }
  const nextSendAt = new Date(Date.now() + (next.delay_hours || 0) * 3600 * 1000);
  await write({ current_step: steps.indexOf(next), next_send_at: nextSendAt });
  return { sent: true, done: false, nextSendAt };
}

/**
 * Scheduler tick — process all enrollments whose next step is due.
 */
async function processDueSteps() {
  if (!sendgrid.isConfigured()) return { processed: 0, reason: 'sendgrid not configured' };

  // Enabled templates only: toggling an automation off in the Automations tab
  // must HOLD its in-flight enrollments immediately, not just block new ones.
  // next_send_at stays in the past, so re-enabling resumes on the next tick.
  // (Operator test-sends bypass this on purpose — testSequence renders and
  // sends directly, so a disabled sequence can be proofed before enabling.)
  const due = await db('automation_enrollments as e')
    .join('automation_templates as t', 't.key', 'e.template_key')
    .where('e.status', 'active')
    .where('t.enabled', true)
    .where('e.next_send_at', '<=', new Date())
    // A payment-failed enrollment for a customer under an active collections dispute hold is a
    // wait: it stays out of the page (never starving unrelated automations) and is picked up on
    // the first tick after the release. The step itself re-checks the hold (fail closed).
    .where((q) => q.whereNot('e.template_key', 'payment_failed')
      .orWhereNotExists(function heldPaymentFailed() {
        require('./collections/collection-hold').collectionHoldExistsSql(this, 'e.customer_id');
      }))
    .orderBy('e.next_send_at', 'asc')
    .limit(50)
    .select('e.id');

  if (!due.length) return { processed: 0 };

  logger.info(`[automation-runner] ${due.length} enrollment(s) due`);
  let processed = 0;
  for (const row of due) {
    try {
      await sendStep(row.id);
      processed++;
    } catch (err) {
      logger.error(`[automation-runner] enrollment ${row.id} step failed: ${err.message}`);
    }
  }
  return { processed };
}

/**
 * Test-send the entire sequence to one address, ignoring delays. Each step
 * fires immediately, ~1s apart, prefixed [TEST]. Does not advance or
 * persist an enrollment.
 */
async function testSequence({ templateKey, toEmail }) {
  const template = await db('automation_templates').where({ key: templateKey }).first();
  if (!template) throw new Error('template not found');
  const steps = await db('automation_steps')
    .where({ template_key: templateKey, enabled: true })
    .orderBy('step_order', 'asc');
  if (!steps.length) throw new Error('no steps to send');

  const asmGroupId = automationAsmGroupId(template);

  const fake = { first_name: 'Test', last_name: 'User', email: toEmail };
  const results = [];

  for (const step of steps) {
    if (!step.html_body && !step.text_body) { results.push({ step: step.step_order, skipped: 'empty' }); continue; }
    try {
      const rendered = renderAutomationStepContent({
        template,
        htmlBody: step.html_body,
        textBody: step.text_body,
        customer: fake,
        asmGroupId,
      });
      const res = await sendgrid.sendOne({
        to: toEmail,
        fromEmail: normalizeAutomationFromEmail(step.from_email),
        fromName: step.from_name,
        replyTo: step.reply_to,
        subject: `[TEST step ${step.step_order}] ${substitute(step.subject || template.name, fake)}`,
        html: rendered.html || undefined,
        text: rendered.text || undefined,
        categories: ['automation_test', `template_${template.key}`],
        asmGroupId,
      });
      results.push({ step: step.step_order, sent: true, messageId: res.messageId });
    } catch (err) {
      results.push({ step: step.step_order, sent: false, error: err.message });
    }
  }
  return { template: template.key, to: toEmail, results };
}

module.exports = {
  hasLocalContent,
  enrollCustomer,
  sendStep,
  advanceEnrollment,
  nextSequenceStep,
  processDueSteps,
  testSequence,
  substitute,
  normalizeAutomationFromEmail,
  automationAsmGroupId,
  renderAutomationStepContent,
  automationSuppressionGroupKey,
  automationSuppressionMatches,
  activeAutomationSuppressionFor,
  requiresTermiteBond,
};
