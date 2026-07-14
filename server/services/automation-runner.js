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
const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const { wrapServiceEmail, ensureLegalTextFooter, blockPalette } = require('./email-template');

const ASM_UNSUBSCRIBE_URL = '<%asm_group_unsubscribe_raw_url%>';
const GLOBAL_SUPPRESSION_TYPES = new Set(['bounce', 'spam_complaint', 'do_not_email']);

function substitute(text, customer) {
  if (!text) return text;
  const first = customer.first_name || customer.firstName || '';
  const last = customer.last_name || customer.lastName || '';
  return text
    .replace(/\{\{\s*first_name\s*\}\}/g, first)
    .replace(/\{\{\s*last_name\s*\}\}/g, last)
    .replace(/\{\{\s*email\s*\}\}/g, customer.email || '')
    .replace(/\{first_name\}/g, first)          // also support single-brace for parity with SMS templates
    .replace(/\{last_name\}/g, last);
}

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

async function activeAutomationSuppressionFor(template, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const rows = await db('email_suppressions')
    .whereRaw('LOWER(email) = ?', [normalizedEmail])
    .where({ status: 'active' });
  return rows.find((row) => automationSuppressionMatches(template, row)) || null;
}

async function cancelEnrollmentForSuppression(enrollment, reason) {
  await db('automation_enrollments').where({ id: enrollment.id }).update({
    status: 'cancelled',
    next_send_at: null,
    completed_at: new Date(),
    metadata: db.raw("jsonb_set(COALESCE(metadata,'{}'::jsonb), '{cancel_reason}', ?::jsonb, true)", [JSON.stringify('email_suppressed')]),
    updated_at: new Date(),
  });
  logger.warn(`[automation-runner] cancelled enrollment=${enrollment.id} reason=${reason}`);
}

function renderAutomationStepContent({ template, htmlBody, textBody, customer, asmGroupId }) {
  const rawHtml = substitute(htmlBody || '', customer);
  const rawText = substitute(textBody || '', customer);
  const unsubscribeUrl = asmGroupId ? ASM_UNSUBSCRIBE_URL : null;
  // Every automation renders the service chrome — "The Waves Newsletter"
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
async function enrollCustomer({ templateKey, customer, dbh = db }) {
  const template = await dbh('automation_templates').where({ key: templateKey }).first();
  if (!template) throw new Error(`Unknown automation template: ${templateKey}`);
  if (!template.enabled) return { enrolled: false, reason: 'template disabled' };
  if (!customer?.email) return { enrolled: false, reason: 'no email' };
  const normalizedEmail = String(customer.email || '').trim().toLowerCase();
  if (!normalizedEmail) return { enrolled: false, reason: 'no email' };

  const steps = await dbh('automation_steps')
    .where({ template_key: templateKey, enabled: true })
    .orderBy('step_order', 'asc');
  if (!steps.length) return { enrolled: false, reason: 'no steps' };

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

async function sendStep(enrollmentId, { testRecipient } = {}) {
  const enrollment = await db('automation_enrollments').where({ id: enrollmentId }).first();
  if (!enrollment) throw new Error('enrollment not found');
  if (enrollment.status !== 'active') throw new Error(`enrollment status is ${enrollment.status}`);

  const template = await db('automation_templates').where({ key: enrollment.template_key }).first();
  if (!template) throw new Error('template missing');

  const steps = await db('automation_steps')
    .where({ template_key: enrollment.template_key, enabled: true })
    .orderBy('step_order', 'asc');

  const step = steps[enrollment.current_step];
  if (!step) {
    // No step at this index — treat as completed.
    await db('automation_enrollments').where({ id: enrollmentId }).update({
      status: 'completed', completed_at: new Date(), next_send_at: null, updated_at: new Date(),
    });
    return { done: true };
  }
  if (!step.html_body && !step.text_body) {
    // Empty step — skip and advance.
    return advanceEnrollment(enrollment, steps);
  }

  const personal = {
    first_name: enrollment.first_name || '',
    last_name: enrollment.last_name || '',
    email: enrollment.email,
  };

  const subject = substitute(step.subject || `(${template.name})`, personal);
  const asmGroupId = automationAsmGroupId(template);
  const fromEmail = normalizeAutomationFromEmail(step.from_email);
  const { html, text } = renderAutomationStepContent({
    template,
    htmlBody: step.html_body,
    textBody: step.text_body,
    customer: personal,
    asmGroupId,
  });

  const recipient = testRecipient || enrollment.email;

  const sendRow = await db('automation_step_sends').insert({
    enrollment_id: enrollment.id,
    step_id: step.id,
    step_order: step.step_order,
    email: recipient,
    status: 'queued',
  }).returning('*').then((rows) => rows[0]);

  if (!testRecipient) {
    const suppression = await activeAutomationSuppressionFor(template, recipient);
    if (suppression) {
      const reason = automationSuppressionReason(suppression);
      await db('automation_step_sends').where({ id: sendRow.id }).update({
        status: 'blocked',
        failure_reason: reason.slice(0, 500),
        updated_at: new Date(),
      });
      await cancelEnrollmentForSuppression(enrollment, reason);
      return { sent: false, blocked: true, reason };
    }
  }

  try {
    const res = await sendgrid.sendOne({
      to: recipient,
      fromEmail,
      fromName: step.from_name,
      replyTo: step.reply_to,
      subject: testRecipient ? `[TEST] ${subject}` : subject,
      html: html || undefined,
      text: text || undefined,
      categories: ['automation', `template_${template.key}`, `step_${step.step_order}`],
      asmGroupId,
    });

    await db('automation_step_sends').where({ id: sendRow.id }).update({
      status: 'sent',
      sendgrid_message_id: res.messageId,
      sent_at: new Date(),
      updated_at: new Date(),
    });

    // For test sends we don't advance the enrollment — only real sends do.
    if (testRecipient) return { sent: true, messageId: res.messageId, test: true };

    await stampPrepSentForSequence(enrollment, step, steps);

    return advanceEnrollment(enrollment, steps);
  } catch (err) {
    logger.error(`[automation-runner] send failed enrollment=${enrollment.id} step=${step.step_order}: ${err.message}`);
    await db('automation_step_sends').where({ id: sendRow.id }).update({
      status: 'failed',
      failure_reason: err.message.slice(0, 500),
      updated_at: new Date(),
    });
    if (testRecipient) throw err;

    // Mark enrollment failed so it stops retrying. Operator can re-enroll later.
    await db('automation_enrollments').where({ id: enrollment.id }).update({
      status: 'failed', next_send_at: null, updated_at: new Date(),
    });
    return { sent: false, error: err.message };
  }
}

async function advanceEnrollment(enrollment, steps) {
  const nextIdx = enrollment.current_step + 1;
  if (nextIdx >= steps.length) {
    await db('automation_enrollments').where({ id: enrollment.id }).update({
      status: 'completed',
      completed_at: new Date(),
      last_sent_at: new Date(),
      next_send_at: null,
      current_step: nextIdx,
      updated_at: new Date(),
    });
    return { sent: true, done: true };
  }
  const nextStep = steps[nextIdx];
  const nextSendAt = new Date(Date.now() + (nextStep.delay_hours || 0) * 3600 * 1000);
  await db('automation_enrollments').where({ id: enrollment.id }).update({
    current_step: nextIdx,
    last_sent_at: new Date(),
    next_send_at: nextSendAt,
    updated_at: new Date(),
  });
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
  processDueSteps,
  testSequence,
  substitute,
  normalizeAutomationFromEmail,
  automationAsmGroupId,
  renderAutomationStepContent,
  automationSuppressionGroupKey,
  automationSuppressionMatches,
  activeAutomationSuppressionFor,
};
