/**
 * Recruiting comms (GATE_RECRUITING_COMMS) — applicant-facing SMS/email:
 * the submit confirmation, the interview self-scheduling invite + its
 * booked/rebooked confirmation, and whatever the admin stage-change
 * "notify" modal sends. Applicants are never customers or leads (the
 * call-pipeline job_applicant rule) — every send goes through
 * sendCustomerMessage with audience:'applicant' and an explicit
 * transactional_allowed consentBasis; SMS never calls twilio.sendSMS
 * directly, and email never goes through the templated
 * email-template-library (raw sendgrid-mail.sendOne + our own
 * email_messages ledger row, mirroring the contract-signed-email /
 * service-report direct-insert pattern).
 *
 * Routes stay thin: every render/send/eligibility decision lives here so
 * admin-careers.js and public-careers.js only wire HTTP shape.
 */

const db = require('../models/db');
const logger = require('./logger');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { loadSuppressionState } = require('./messaging/validators/suppression');
const { activeSuppressionFor } = require('./email-template-library');
const sendgrid = require('./sendgrid-mail');
const { isEnabled } = require('../config/feature-gates');
const { portalUrl } = require('../utils/portal-url');
const { formatETTime } = require('../utils/datetime-et');
const { WAVES_ADDRESS_LINE, WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const FROM_EMAIL = 'contact@wavespestcontrol.com';
const FROM_NAME = 'Waves Pest Control';

// stage -> sms_templates base key (see the migration's TEMPLATES table).
const STAGE_KEYS = {
  application_received: 'job_application_received',
  interview_invite: 'job_interview_invite',
  interview_confirmation: 'job_interview_confirmation',
};

const INTERVIEW_LINK_PLACEHOLDER = '[interview link]';

// Mirror the service.report_ready direct-send fallback's suppression
// semantics (server/services/service-report/email-delivery.js) — this is
// the same style of direct sendgrid.sendOne + own email_messages ledger row
// that bypasses the templated send path, so it must honor the same
// email_suppressions rows the templated path checks on its own.
const RECRUITING_SUPPRESSION_GROUP_KEY = 'recruiting_operational';
const RECRUITING_SUPPRESSION_TEMPLATE = {
  send_stream: 'recruiting_operational',
  suppression_group_key: 'recruiting_operational',
};

// ---------------------------------------------------------------- masking

// Log-safe error summary: Knex query errors interpolate their bindings into
// err.message (recipient email, message body, the bearer interview URL), so
// anything that may have thrown from a query logs only its class + code.
function errorSummary(err) {
  if (!err) return 'unknown';
  const name = err.name || 'Error';
  return err.code ? `${name} ${err.code}` : name;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  if (digits.length !== 10) return '***';
  return `(${digits.slice(0, 3)}) ***-${digits.slice(6)}`;
}

function maskEmail(email) {
  const text = String(email || '').trim();
  const [local, domain] = text.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain.toLowerCase()}`;
}

// ------------------------------------------------------------- contact/vars

function contactOf(app) {
  let snap = app && app.contact_snapshot;
  if (typeof snap === 'string') {
    try { snap = JSON.parse(snap); } catch { snap = {}; }
  }
  snap = snap || {};
  return {
    name: snap.name || '',
    phone: snap.phone || null,
    email: snap.email || null,
    city: snap.city || null,
  };
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function interviewUrlFor(token) {
  if (!token) return null;
  return portalUrl(`/careers/interview/${token}`);
}

// "Tue Sep 22 at 4:30 PM ET" — the ET calendar day + wall-clock time of the
// slot instant. Kept in English abbreviated form regardless of applicant
// language (matches the single example the copy spec gives for both the
// en and es template rows, which share this same rendered value).
function formatInterviewWhen(startIso) {
  if (!startIso) return '';
  const d = startIso instanceof Date ? startIso : new Date(startIso);
  if (Number.isNaN(d.getTime())) return '';
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  return `${weekday} ${monthDay} at ${formatETTime(d)} ET`;
}

function interviewModeLine(mode, language) {
  if (language === 'es') {
    return mode === 'in_person'
      ? `Te esperamos en ${WAVES_ADDRESS_LINE} el`
      : 'Te llamaremos a este numero el';
  }
  return mode === 'in_person'
    ? `See you at ${WAVES_ADDRESS_LINE} on`
    : "We'll call you at this number on";
}

function languageOf(app) {
  return app && app.language === 'es' ? 'es' : 'en';
}

function buildVars(app, stage) {
  const contact = contactOf(app);
  const first = firstNameOf(contact.name);
  if (stage === 'application_received') {
    return { first_name: first };
  }
  if (stage === 'interview_invite') {
    return { first_name: first, interview_url: interviewUrlFor(app.interview_token) || '' };
  }
  if (stage === 'interview_confirmation') {
    const language = languageOf(app);
    return {
      interview_mode_line: interviewModeLine(app.interview_mode, language),
      interview_when: formatInterviewWhen(app.interview_at),
      interview_url: interviewUrlFor(app.interview_token) || '',
    };
  }
  return {};
}

// ------------------------------------------------------------------- SMS

async function renderStageSmsBody(app, stage, vars) {
  const baseKey = STAGE_KEYS[stage];
  if (!baseKey) return { body: null, templateKey: null };
  const language = languageOf(app);
  const context = { workflow: baseKey, entity_type: 'job_application', entity_id: app.id };
  if (language === 'es') {
    const esBody = await renderSmsTemplate(`${baseKey}_es`, vars, context);
    if (esBody) return { body: esBody, templateKey: `${baseKey}_es` };
  }
  const body = await renderSmsTemplate(baseKey, vars, context);
  return { body: body || null, templateKey: baseKey };
}

// --------------------------------------------------------------- email copy

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapEmailHtml({ heading, paragraphs, buttonUrl, buttonLabel }) {
  const parts = [
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">',
    `<h2 style="font-size:18px;margin:0 0 16px;">${escapeHtml(heading)}</h2>`,
  ];
  for (const p of paragraphs) {
    parts.push(`<p style="font-size:14px;line-height:1.5;margin:0 0 12px;">${escapeHtml(p)}</p>`);
  }
  if (buttonUrl) {
    parts.push(
      `<p style="margin:20px 0;"><a href="${escapeHtml(buttonUrl)}" style="background:#0b5c3f;color:#ffffff;` +
      `padding:12px 20px;border-radius:6px;text-decoration:none;font-size:14px;display:inline-block;">` +
      `${escapeHtml(buttonLabel || buttonUrl)}</a></p>`,
    );
    parts.push(`<p style="font-size:12px;color:#666;word-break:break-all;">${escapeHtml(buttonUrl)}</p>`);
  }
  parts.push('</div>');
  return parts.join('\n');
}

function buildEmailContent(app, stage, vars) {
  const language = languageOf(app);
  const first = firstNameOf(contactOf(app).name);
  const isEs = language === 'es';

  if (stage === 'application_received') {
    const subject = isEs ? 'Recibimos tu solicitud' : 'We received your application';
    const intro = isEs
      ? `Hola ${first}, gracias por postularte a Waves Pest Control. Revisamos cada solicitud y te contactaremos en un plazo de 2 dias habiles.`
      : `Hi ${first}, thanks for applying to Waves Pest Control. We read every application and will reach out within 2 business days.`;
    const contactLine = isEs
      ? `Si tienes preguntas, responde a este correo o llama al ${WAVES_SUPPORT_PHONE_DISPLAY}.`
      : `If you have questions, reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`;
    return {
      subject,
      html: wrapEmailHtml({ heading: subject, paragraphs: [intro, contactLine] }),
      text: `${intro}\n\n${contactLine}`,
    };
  }

  if (stage === 'interview_invite') {
    const subject = isEs ? 'Programemos tu entrevista con Waves' : "Let's set up your interview with Waves";
    const intro = isEs
      ? `Hola ${first}, Waves Pest Control quisiera entrevistarte. Elige un horario por telefono o en persona que te convenga:`
      : `Hi ${first}, Waves Pest Control would like to interview you. Pick a phone or in-person time that works for you:`;
    const explain = isEs
      ? 'El enlace te permite elegir una llamada telefonica o una visita en persona a nuestra oficina en Bradenton.'
      : 'The link lets you choose a phone call or an in-person visit at our Bradenton office.';
    const buttonLabel = isEs ? 'Elegir horario' : 'Pick a time';
    return {
      subject,
      html: wrapEmailHtml({ heading: subject, paragraphs: [intro, explain], buttonUrl: vars.interview_url, buttonLabel }),
      text: `${intro}\n\n${vars.interview_url}\n\n${explain}`,
    };
  }

  if (stage === 'interview_confirmation') {
    const subject = isEs
      ? `Entrevista confirmada: ${vars.interview_when}`
      : `Interview confirmed: ${vars.interview_when}`;
    const line1 = isEs
      ? `Listo. ${vars.interview_mode_line} ${vars.interview_when}.`
      : `You're set. ${vars.interview_mode_line} ${vars.interview_when}.`;
    const changeLine = isEs
      ? 'Necesitas cambiarlo? Usa el mismo enlace:'
      : 'Need to change it? Use the same link:';
    const paragraphs = [line1, changeLine];
    if (app.interview_mode === 'in_person') {
      paragraphs.push(WAVES_ADDRESS_LINE);
      paragraphs.push(isEs ? 'Trae tu licencia de conducir.' : 'Bring your driver\'s license.');
    }
    const buttonLabel = isEs ? 'Cambiar horario' : 'Change time';
    return {
      subject,
      html: wrapEmailHtml({ heading: subject, paragraphs, buttonUrl: vars.interview_url, buttonLabel }),
      text: `${paragraphs.join('\n\n')}\n\n${vars.interview_url}`,
    };
  }

  return { subject: '', html: '', text: '' };
}

async function sendRawEmail({ app, stage, to, subject, html, text }) {
  const templateKey = `job_${stage}`;
  let messageRow = null;
  try {
    const rows = await db('email_messages').insert({
      provider: 'sendgrid',
      template_key: templateKey,
      recipient_type: 'job_application',
      recipient_id: app.id,
      recipient_email_snapshot: to,
      from_name_snapshot: FROM_NAME,
      from_email_snapshot: FROM_EMAIL,
      reply_to_snapshot: CONTACT_EMAIL,
      subject_snapshot: subject,
      html_snapshot: html,
      text_snapshot: text,
      categories: JSON.stringify([templateKey]),
      status: 'queued',
      queued_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
    messageRow = rows && rows[0];
  } catch (err) {
    logger.warn(`[recruiting-comms] email_messages insert failed (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
  }

  // Honor the suppression ledger BEFORE SendGrid — this direct-insert path
  // (unlike the templated email-template-library senders) previously had no
  // suppression check at all, so a bounced/unsubscribed applicant email
  // would still be sent (codex P1).
  const suppression = await activeSuppressionFor(RECRUITING_SUPPRESSION_TEMPLATE, to, RECRUITING_SUPPRESSION_GROUP_KEY);
  if (suppression) {
    if (messageRow) {
      await db('email_messages').where({ id: messageRow.id, status: 'queued' }).update({
        status: 'blocked',
        error_message: `Suppressed: ${suppression.suppression_type}${suppression.group_key ? ` (${suppression.group_key})` : ''}`.slice(0, 500),
        updated_at: new Date(),
      }).catch(() => {});
    }
    logger.info(`[recruiting-comms] email blocked by suppression (application ${app.id}, stage ${stage})`);
    return { outcome: 'blocked', code: 'email_suppressed' };
  }

  try {
    const result = await sendgrid.sendOne({
      to,
      fromEmail: FROM_EMAIL,
      fromName: FROM_NAME,
      replyTo: CONTACT_EMAIL,
      subject,
      html,
      text,
      categories: [templateKey],
      suppressErrorLog: true,
    });
    if (messageRow) {
      await db('email_messages').where({ id: messageRow.id, status: 'queued' }).update({
        status: 'sent',
        provider_message_id: result && result.messageId ? result.messageId : null,
        sent_at: new Date(),
        updated_at: new Date(),
      }).catch(() => {});
    }
    return { outcome: 'sent', code: null };
  } catch (err) {
    if (messageRow) {
      await db('email_messages').where({ id: messageRow.id, status: 'queued' }).update({
        status: 'failed',
        error_message: String((err && err.message) || 'send failed').slice(0, 500),
        updated_at: new Date(),
      }).catch(() => {});
    }
    logger.warn(`[recruiting-comms] SendGrid send failed (application ${app.id}, stage ${stage}, status ${(err && err.status) || 'unknown'})`);
    return { outcome: 'failed', code: err && err.status ? `sendgrid_${err.status}` : 'send_failed' };
  }
}

// The interview_confirmation SMS is applicant-triggered (fire-and-forget off
// the public book route), unlike interview_invite's owner-initiated send —
// so it stays gated on real consent: either the applicant checked the SMS
// box on their application, or the owner already texted this applicant by
// hand (a prior 'sent' sms row in comms_history — the owner-initiated leg
// is allowed regardless of sms_consent, so this is real evidence of an
// established texting relationship, not a bypass).
function confirmationSmsEligible(app, { priorSmsSent = false } = {}) {
  return app.sms_consent === true || priorSmsSent === true;
}

// ------------------------------------------------------------- eligibility

async function channelEligibility(app) {
  const contact = contactOf(app);
  let sms = { available: false, to: null, reason: 'no_phone' };
  if (contact.phone) {
    sms = { available: true, to: maskPhone(contact.phone), reason: null };
    try {
      const state = await loadSuppressionState({ to: contact.phone }, {});
      if (state && state.suppression) {
        sms = { available: false, to: maskPhone(contact.phone), reason: 'suppressed' };
      }
    } catch (err) {
      // Preview is informational only — a lookup hiccup must not crash the
      // stage-preview endpoint. The real send still runs the authoritative
      // suppression check inside sendCustomerMessage.
      logger.warn(`[recruiting-comms] suppression lookup failed for preview (application ${app.id}): ${errorSummary(err)}`);
    }
  }
  const email = contact.email
    ? { available: true, to: maskEmail(contact.email), reason: null }
    : { available: false, to: null, reason: 'no_email' };
  return { sms, email };
}

// ------------------------------------------------------------- history log

function historyEntry({ stage, channel, to, outcome, code, body, by }) {
  return {
    at: new Date().toISOString(),
    stage,
    channel,
    to: channel === 'sms' ? maskPhone(to) : maskEmail(to),
    outcome,
    code: code || null,
    body: body || '',
    by: by || 'system',
  };
}

async function appendCommsHistory(applicationId, entries, conn = db) {
  if (!entries || !entries.length) return;
  await conn('job_applications')
    .where({ id: applicationId })
    .update({
      comms_history: db.raw("COALESCE(comms_history, '[]'::jsonb) || ?::jsonb", [JSON.stringify(entries)]),
      updated_at: new Date(),
    });
}

// -------------------------------------------------------- edited-body link

function bodyKeepsInterviewLink(body, interviewUrl) {
  if (typeof body !== 'string' || !body) return false;
  if (body.includes(INTERVIEW_LINK_PLACEHOLDER)) return true;
  return !!interviewUrl && body.includes(interviewUrl);
}

function substituteInterviewLinkPlaceholder(body, interviewUrl) {
  if (typeof body !== 'string') return body;
  return body.split(INTERVIEW_LINK_PLACEHOLDER).join(interviewUrl || '');
}

// ----------------------------------------------------------------- sending

/**
 * @param {object} app - job_applications row (fresh: must already carry
 *   any interview_token/mode/at the stage needs).
 * @param {'application_received'|'interview_invite'|'interview_confirmation'} stage
 * @param {object} opts
 * @param {boolean} opts.sms - attempt the SMS leg
 * @param {boolean} opts.email - attempt the email leg
 * @param {string} [opts.by] - technicianId | 'system' | 'applicant'
 * @param {string} [opts.smsBody] - admin-edited override (already
 *   link-guard-validated and placeholder-substituted by the caller)
 * @param {string} [opts.emailSubject] - admin-edited override
 * @param {string} [opts.emailBody] - admin-edited override (plain text;
 *   rendered into the same wrapper as the default copy)
 * @returns {Promise<{ sms: string, email: string }>}
 */
async function sendStageComms(app, stage, opts = {}) {
  const by = opts.by || 'system';
  const wantSms = opts.sms === true;
  const wantEmail = opts.email === true;
  const result = { sms: 'not_requested', email: 'not_requested' };

  if (!wantSms && !wantEmail) return result;

  if (!isEnabled('recruitingComms')) {
    if (wantSms) result.sms = 'disabled';
    if (wantEmail) result.email = 'disabled';
    return result;
  }

  const contact = contactOf(app);
  const vars = buildVars(app, stage);
  const entries = [];

  if (wantSms) {
    if (!contact.phone) {
      result.sms = 'skipped';
    } else {
      let body = opts.smsBody;
      if (!body) {
        const rendered = await renderStageSmsBody(app, stage, vars);
        body = rendered.body;
      }
      if (!body) {
        result.sms = 'skipped';
        entries.push(historyEntry({ stage, channel: 'sms', to: contact.phone, outcome: 'skipped', code: 'template_disabled', body: '', by }));
      } else {
        let sendRes;
        try {
          sendRes = await sendCustomerMessage({
          to: contact.phone,
          body,
          channel: 'sms',
          audience: 'applicant',
          purpose: stage,
          entryPoint: 'recruiting_comms',
          identityTrustLevel: 'phone_provided_unverified',
          consentBasis: { status: 'transactional_allowed', source: 'job_application' },
          metadata: { original_message_type: `job_${stage}`, job_application_id: app.id },
          });
        } catch (err) {
          // Channel isolation: a throw here must not lose the email leg's
          // outcome (or vice versa) — record it as a failed attempt.
          logger.error(`[recruiting-comms] sms leg threw (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
          sendRes = { sent: false, blocked: false, deliveryOutcome: 'not_sent', code: `threw:${errorSummary(err)}` };
        }
        const outcome = sendRes.sent
          ? 'sent'
          : (sendRes.blocked ? 'blocked' : (sendRes.deliveryOutcome === 'uncertain' ? 'uncertain' : 'failed'));
        result.sms = outcome;
        entries.push(historyEntry({ stage, channel: 'sms', to: contact.phone, outcome, code: sendRes.code || null, body, by }));
      }
    }
  }

  if (wantEmail) {
    if (!contact.email) {
      result.email = 'skipped';
    } else {
      const built = buildEmailContent(app, stage, vars);
      const subject = opts.emailSubject || built.subject;
      const text = opts.emailBody || built.text;
      // The default html is only valid for the default copy: once the owner
      // edited either half, re-wrap the plain text so html and text legs
      // carry the same message.
      const html = (opts.emailSubject || opts.emailBody)
        ? wrapEmailHtml({ heading: subject, paragraphs: String(text).split(/\n{2,}/) })
        : built.html;
      let sendRes;
      try {
        sendRes = await sendRawEmail({ app, stage, to: contact.email, subject, html, text });
      } catch (err) {
        logger.error(`[recruiting-comms] email leg threw (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
        sendRes = { outcome: 'failed', code: `threw:${errorSummary(err)}` };
      }
      result.email = sendRes.outcome;
      entries.push(historyEntry({
        stage, channel: 'email', to: contact.email, outcome: sendRes.outcome, code: sendRes.code,
        body: `${subject}\n\n${text}`, by,
      }));
    }
  }

  // Always persist whatever completed — a history write failure is logged,
  // never allowed to mask an outcome the caller already has.
  if (entries.length) {
    try {
      await appendCommsHistory(app.id, entries);
    } catch (err) {
      logger.error(`[recruiting-comms] comms_history append failed (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
    }
  }
  return result;
}

module.exports = {
  errorSummary,
  STAGE_KEYS,
  INTERVIEW_LINK_PLACEHOLDER,
  maskPhone,
  maskEmail,
  contactOf,
  firstNameOf,
  interviewUrlFor,
  formatInterviewWhen,
  interviewModeLine,
  buildVars,
  buildEmailContent,
  renderStageSmsBody,
  channelEligibility,
  confirmationSmsEligible,
  bodyKeepsInterviewLink,
  substituteInterviewLinkPlaceholder,
  appendCommsHistory,
  historyEntry,
  sendStageComms,
  // exposed for tests
  _internals: { renderStageSmsBody, sendRawEmail },
};
