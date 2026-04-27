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
const { wrapNewsletter } = require('./email-template');

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
 * Enroll a customer into a template's sequence. Idempotent on
 * (template_key, customer_id) — existing active enrollment is a no-op.
 * If there are no enabled steps, returns { enrolled: false }.
 */
async function enrollCustomer({ templateKey, customer }) {
  const template = await db('automation_templates').where({ key: templateKey }).first();
  if (!template) throw new Error(`Unknown automation template: ${templateKey}`);
  if (!template.enabled) return { enrolled: false, reason: 'template disabled' };
  if (!customer?.email) return { enrolled: false, reason: 'no email' };

  const steps = await db('automation_steps')
    .where({ template_key: templateKey, enabled: true })
    .orderBy('step_order', 'asc');
  if (!steps.length) return { enrolled: false, reason: 'no steps' };

  // Dedupe: already-enrolled customer on this template is a no-op.
  if (customer.id) {
    const existing = await db('automation_enrollments')
      .where({ template_key: templateKey, customer_id: customer.id })
      .first();
    if (existing && existing.status === 'active') {
      return { enrolled: false, reason: 'already enrolled', enrollmentId: existing.id };
    }
  }

  const firstStep = steps[0];
  const nextSendAt = new Date(Date.now() + (firstStep.delay_hours || 0) * 3600 * 1000);

  const [row] = await db('automation_enrollments').insert({
    template_key: templateKey,
    customer_id: customer.id || null,
    email: customer.email,
    first_name: customer.first_name || null,
    last_name: customer.last_name || null,
    status: 'active',
    current_step: 0,
    next_send_at: nextSendAt,
  }).returning('*').onConflict(['template_key', 'customer_id']).merge({
    // If a completed/cancelled row exists, re-activate it.
    status: 'active',
    current_step: 0,
    next_send_at: nextSendAt,
    enrolled_at: new Date(),
    updated_at: new Date(),
  });

  return { enrolled: true, enrollmentId: row.id };
}

/**
 * Send one step for an enrollment. Advances the cursor on success,
 * marks the enrollment complete if it was the last step, or failed
 * if SendGrid rejects.
 */
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
  const rawHtml = substitute(step.html_body || '', personal);
  const text = substitute(step.text_body || '', personal);

  const asmGroupId = template.asm_group === 'newsletter'
    ? (parseInt(process.env.SENDGRID_ASM_GROUP_NEWSLETTER) || null)
    : (parseInt(process.env.SENDGRID_ASM_GROUP_SERVICE) || null);

  // Wrap operator-written body in branded chrome (same template the
  // newsletter campaigns use). For the unsubscribe URL we pass
  // SendGrid's per-send ASM substitution token — SendGrid replaces it
  // with a per-recipient suppression-group unsubscribe URL when
  // asm.group_id is set on the send.
  const html = rawHtml
    ? wrapNewsletter({
        body: rawHtml,
        unsubscribeUrl: asmGroupId ? '<%asm_group_unsubscribe_raw_url%>' : null,
      })
    : '';

  const recipient = testRecipient || enrollment.email;

  const sendRow = await db('automation_step_sends').insert({
    enrollment_id: enrollment.id,
    step_id: step.id,
    step_order: step.step_order,
    email: recipient,
    status: 'queued',
  }).returning('*').then((rows) => rows[0]);

  try {
    const res = await sendgrid.sendOne({
      to: recipient,
      fromEmail: step.from_email,
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

  const due = await db('automation_enrollments')
    .where({ status: 'active' })
    .where('next_send_at', '<=', new Date())
    .orderBy('next_send_at', 'asc')
    .limit(50);

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

  const asmGroupId = template.asm_group === 'newsletter'
    ? (parseInt(process.env.SENDGRID_ASM_GROUP_NEWSLETTER) || null)
    : (parseInt(process.env.SENDGRID_ASM_GROUP_SERVICE) || null);

  const fake = { first_name: 'Test', last_name: 'User', email: toEmail };
  const results = [];

  for (const step of steps) {
    if (!step.html_body && !step.text_body) { results.push({ step: step.step_order, skipped: 'empty' }); continue; }
    try {
      const res = await sendgrid.sendOne({
        to: toEmail,
        fromEmail: step.from_email,
        fromName: step.from_name,
        replyTo: step.reply_to,
        subject: `[TEST step ${step.step_order}] ${substitute(step.subject || template.name, fake)}`,
        html: substitute(step.html_body || '', fake) || undefined,
        text: substitute(step.text_body || '', fake) || undefined,
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

module.exports = { hasLocalContent, enrollCustomer, sendStep, processDueSteps, testSequence, substitute };
