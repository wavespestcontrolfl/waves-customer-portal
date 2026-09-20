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

const crypto = require('crypto');
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
  // owner_reply: no template — the body is the owner's own words
  // (dashboard inbox reply / composer); message_type job_owner_reply.
  owner_reply: null,
};
// Stage → sendCustomerMessage purpose (policy.js). Every stage except the
// owner-authored reply is its own purpose name.
const STAGE_PURPOSE = {
  application_received: 'application_received',
  interview_invite: 'interview_invite',
  interview_confirmation: 'interview_confirmation',
  owner_reply: 'applicant_reply',
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

// The ONE sender number for applicant texts — resolved through the same
// derivation services/twilio.js applies to a send with no customer location
// (deriveOutboundNumber → the Bradenton outbound line), then used for the
// durable ledger entry, the immediate send (metadata.fromNumber) and any
// queued replay row (from_phone), so the number an applicant replies TO is
// by construction the number the reply classifier compares against.
async function outboundNumberForApplicants() {
  try {
    const TwilioService = require('./twilio');
    const derived = await TwilioService.deriveOutboundNumber({});
    if (derived) return derived;
  } catch { /* fall through to the config default */ }
  try {
    return require('../config/twilio-numbers').getOutboundNumber('bradenton') || null;
  } catch {
    return null;
  }
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

async function sendRawEmail({ app, stage, to, subject, html, text, beforeProvider }) {
  const templateKey = `job_${stage}`;
  let messageRow = null;
  // Fresh per send attempt and echoed in SendGrid custom_args, so a
  // complaint/unsubscribe/bounce webhook that lands before the post-send
  // provider_message_id update can still correlate the event to THIS row
  // (the tracked-email handoff email-template-library.js uses — Codex r2 P1).
  const sendAttemptToken = crypto.randomUUID();
  try {
    const rows = await db('email_messages').insert({
      provider: 'sendgrid',
      send_attempt_token: sendAttemptToken,
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
    // Fail closed (Codex P1): the ledger row is what a bounce/complaint/
    // unsubscribe webhook and the reply classifier correlate a later event
    // back to. A send with no row to correlate against is untracked evidence
    // — refuse the send rather than let SendGrid dispatch it blind.
    logger.error(`[recruiting-comms] email_messages insert failed (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
    return { outcome: 'failed', code: 'ledger_write_failed' };
  }

  // Honor the suppression ledger BEFORE SendGrid — this direct-insert path
  // (unlike the templated email-template-library senders) previously had no
  // suppression check at all, so a bounced/unsubscribed applicant email
  // would still be sent (codex P1).
  let suppression;
  try {
    suppression = await activeSuppressionFor(RECRUITING_SUPPRESSION_TEMPLATE, to, RECRUITING_SUPPRESSION_GROUP_KEY);
  } catch (err) {
    // Pre-provider failure: fail closed (no send) AND settle the ledger row
    // we already own so it never sits 'queued' forever (Codex r6 P2).
    if (messageRow) {
      await db('email_messages').where({ id: messageRow.id, status: 'queued', send_attempt_token: sendAttemptToken }).update({
        status: 'failed',
        error_message: `suppression lookup failed: ${errorSummary(err)}`.slice(0, 500),
        updated_at: new Date(),
      }).catch(() => {});
    }
    logger.warn(`[recruiting-comms] suppression lookup failed (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
    return { outcome: 'failed', code: 'suppression_lookup_failed' };
  }
  if (suppression) {
    if (messageRow) {
      await db('email_messages').where({ id: messageRow.id, status: 'queued', send_attempt_token: sendAttemptToken }).update({
        status: 'blocked',
        error_message: `Suppressed: ${suppression.suppression_type}${suppression.group_key ? ` (${suppression.group_key})` : ''}`.slice(0, 500),
        updated_at: new Date(),
      }).catch(() => {});
    }
    logger.info(`[recruiting-comms] email blocked by suppression (application ${app.id}, stage ${stage})`);
    return { outcome: 'blocked', code: 'email_suppressed' };
  }

  // Eligibility immediately before SendGrid (Codex r9 P2): the ledger insert
  // and suppression lookup above are awaits during which the application can
  // change; a stale one settles its ledger row and sends nothing.
  if (typeof beforeProvider === 'function' && (await beforeProvider()) === false) {
    if (messageRow) {
      await db('email_messages').where({ id: messageRow.id, status: 'queued', send_attempt_token: sendAttemptToken }).update({
        status: 'failed', error_message: 'stale: application changed before the provider handoff', updated_at: new Date(),
      }).catch(() => {});
    }
    return { outcome: 'stale', code: 'recruiting_stale' };
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
      // The body carries the bearer interview link — never let SendGrid
      // rewrite it through its click-tracking redirect (Codex r2 P2).
      disableTracking: true,
      customArgs: messageRow
        ? { email_message_id: messageRow.id, send_attempt_token: sendAttemptToken }
        : { send_attempt_token: sendAttemptToken },
    });
    if (messageRow) {
      await db('email_messages').where({ id: messageRow.id, status: 'queued', send_attempt_token: sendAttemptToken }).update({
        status: 'sent',
        provider_message_id: result && result.messageId ? result.messageId : null,
        sent_at: new Date(),
        updated_at: new Date(),
      }).catch(() => {});
    }
    return { outcome: 'sent', code: null };
  } catch (err) {
    // A definite 4xx rejection (sendgrid.isDefiniteRejection — the same
    // canonical classification the other SendGrid callers use) really was
    // never accepted: 'failed'. A network error or 5xx/timeout (no status,
    // or ambiguous) may have gone out before the response — the ledger
    // status column has no CHECK constraint, so 'uncertain' is a real value,
    // not a euphemism for 'failed' (Codex P2).
    const definite = sendgrid.isDefiniteRejection(err);
    const status = definite ? 'failed' : 'uncertain';
    if (messageRow) {
      await db('email_messages').where({ id: messageRow.id, status: 'queued', send_attempt_token: sendAttemptToken }).update({
        status,
        error_message: String((err && err.message) || 'send failed').slice(0, 500),
        updated_at: new Date(),
      }).catch(() => {});
    }
    logger.warn(`[recruiting-comms] SendGrid send failed (application ${app.id}, stage ${stage}, status ${(err && err.status) || 'unknown'}, outcome ${status})`);
    return { outcome: status, code: err && err.status ? `sendgrid_${err.status}` : 'send_failed' };
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
    id: crypto.randomUUID(),
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

// Patch ONE existing comms_history entry in place (by its id) — used to
// reconcile a pre-handoff 'handoff' entry with the provider outcome. Constant
// SQL, parameterized bindings only.
async function finalizeCommsHistoryEntry(applicationId, entryId, patch, conn = db) {
  await conn('job_applications')
    .where({ id: applicationId })
    .update({
      comms_history: conn.raw(
        "COALESCE((SELECT jsonb_agg(CASE WHEN e->>'id' = ? THEN e || ?::jsonb ELSE e END) FROM jsonb_array_elements(COALESCE(comms_history, '[]'::jsonb)) AS e), '[]'::jsonb)",
        [entryId, JSON.stringify(patch)],
      ),
      updated_at: new Date(),
    });
}

// Outcome-CONDITIONAL reconcile: patch the entry only when its current
// outcome is one of the listed states — evidence is only ever moved
// forward, never downgraded (a 'handoff'/'uncertain'/'sent' entry is proof
// the applicant may hold the text and stays owner-only reply context).
// `transitions` = { <currentOutcome>: patch, ... }. Constant SQL, bound
// triples (id, outcome, patch).
async function reconcileCommsHistoryEntryByOutcome(applicationId, entryId, transitions, conn = db) {
  const entries = Object.entries(transitions || {});
  if (!entries.length) return;
  const cases = entries.map(() => "WHEN e->>'id' = ? AND e->>'outcome' = ? THEN e || ?::jsonb").join(' ');
  const bindings = entries.flatMap(([outcome, patch]) => [entryId, outcome, JSON.stringify(patch)]);
  await conn('job_applications')
    .where({ id: applicationId })
    .update({
      comms_history: conn.raw(
        `COALESCE((SELECT jsonb_agg(CASE ${cases} ELSE e END) FROM jsonb_array_elements(COALESCE(comms_history, '[]'::jsonb)) AS e), '[]'::jsonb)`,
        bindings,
      ),
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
  // Authoritative eligibility immediately before EACH provider leg
  // (Codex r8 P2): the caller's check re-reads the application so a stage
  // change during the (long) SMS leg can never let the email leg deliver an
  // invite whose link already 404s.
  const legEligible = async () => {
    if (typeof opts.stillEligible !== 'function') return true;
    try { return (await opts.stillEligible()) !== false; } catch { return false; }
  };

  if (wantSms) {
    if (!(await legEligible())) {
      result.sms = 'stale';
    } else if (!contact.phone) {
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
        // Classification evidence BEFORE the provider handoff (local audit
        // P0): recruiting-inbound.js ties an applicant's reply to the
        // application through this ledger, so the entry must exist — durably
        // — before the text can possibly be answered. A failed evidence write
        // refuses the send (fail closed) rather than texting untracked.
        const handoffEntry = historyEntry({ stage, channel: 'sms', to: contact.phone, outcome: 'handoff', code: null, body, by });
        // The number the text goes out from — durable routing evidence the
        // reply classifier compares the inbound `To` against, so it never
        // depends on the post-acceptance (best-effort) sms_log row.
        // A reply goes back out on the line the applicant texted (opts.fromNumber);
        // automated stages use the resolved applicant line.
        const applicantFromNumber = opts.fromNumber || await outboundNumberForApplicants();
        handoffEntry.from_number = applicantFromNumber;
        try {
          await appendCommsHistory(app.id, [handoffEntry]);
        } catch (err) {
          logger.error(`[recruiting-comms] pre-handoff evidence write failed (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
          result.sms = 'failed';
          entries.push(historyEntry({ stage, channel: 'sms', to: contact.phone, outcome: 'failed', code: 'evidence_write_failed', body, by }));
          return await finishStage();
        }
        let sendRes;
        try {
          sendRes = await sendCustomerMessage({
          to: contact.phone,
          body,
          channel: 'sms',
          audience: 'applicant',
          purpose: STAGE_PURPOSE[stage] || stage,
          entryPoint: opts.entryPoint || 'recruiting_comms',
          identityTrustLevel: 'phone_provided_unverified',
          consentBasis: { status: 'transactional_allowed', source: 'job_application' },
          // Authoritative eligibility at the ACTUAL provider boundary (Codex r9
          // P2): the pipeline runs this right before Twilio, after every validator.
          ...(typeof opts.stillEligible === 'function' ? {
            preSendCheck: async () => ((await legEligible())
              ? { ok: true }
              : { ok: false, code: 'RECRUITING_STALE', reason: 'application changed before the provider handoff' }),
          } : {}),
          ...(opts.by && opts.by !== 'system' && opts.by !== 'applicant' ? { operatorInitiated: true } : {}),
          metadata: { original_message_type: `job_${stage}`, job_application_id: app.id, ...(opts.by && opts.by !== 'system' && opts.by !== 'applicant' ? { adminUserId: opts.by } : {}), ...(applicantFromNumber ? { fromNumber: applicantFromNumber } : {}) },
          });
        } catch (err) {
          // Channel isolation: a throw here must not lose the email leg's
          // outcome (or vice versa) — record it as a failed attempt.
          logger.error(`[recruiting-comms] sms leg threw (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
          // The pipeline can throw AFTER provider acceptance (e.g. audit
          // persistence) and attaches err.providerOutcome — keep that
          // evidence; a throw with no provider outcome is 'uncertain', never
          // 'failed', because the applicant may already hold the text and a
          // reply must stay owner-only (local audit P0).
          const po = err && err.providerOutcome && typeof err.providerOutcome === 'object' ? err.providerOutcome : null;
          if (po && (po.sent === true || po.deliveryOutcome === 'accepted' || po.deliveryOutcome === 'sent')) {
            sendRes = { ...po, sent: true, blocked: false, code: po.code || `threw_after_accept:${errorSummary(err)}` };
          } else {
            sendRes = { ...(po || {}), sent: false, blocked: false, deliveryOutcome: 'uncertain', code: (po && po.code) || `threw:${errorSummary(err)}` };
          }
        }
        let outcome = sendRes.sent
          ? 'sent'
          : (sendRes.blocked ? 'blocked' : (sendRes.deliveryOutcome === 'uncertain' ? 'uncertain' : 'failed'));
        let deferredUntil = null;
        // A newer invite retires any invite still queued for this application
        // — one stable token must never reach the applicant twice — but only
        // once the replacement EXISTS (sent, or its queue row persisted), so a
        // failed replacement never strands the applicant with no invite at
        // all (Codex r8 P2). The replay rail's own supersession (a newer
        // ledger attempt) covers rows the worker already claimed.
        const retireQueuedInvites = async (exceptRowId) => {
          if (stage !== 'interview_invite') return;
          try {
            await db('sms_log')
              .where({ status: 'scheduled', message_type: 'job_interview_invite' })
              .whereRaw("metadata->>'job_application_id' = ?", [app.id])
              .modify((q) => { if (exceptRowId) q.whereNot('id', exceptRowId); })
              .update({ status: 'cancelled', updated_at: new Date() });
          } catch (err) {
            logger.warn(`[recruiting-comms] retiring queued invites failed (application ${app.id}): ${errorSummary(err)}`);
          }
        };
        if (sendRes.sent) await retireQueuedInvites(null);
        if (!sendRes.sent && sendRes.retryable && sendRes.nextAllowedAt) {
          // Held by the send window (8am–8pm ET): queue the text on the
          // scheduled-SMS rail the cron replays (services/scheduler.js) —
          // an applicant who applies or books overnight still gets the text
          // when the window opens (Codex r5 P1). The rail re-derives the
          // applicant policy from the metadata stamped here.
          try {
            const inserted = await db('sms_log').insert({
              customer_id: null,
              direction: 'outbound',
              from_phone: applicantFromNumber,
              to_phone: contact.phone,
              message_body: body,
              status: 'scheduled',
              scheduled_for: new Date(sendRes.nextAllowedAt),
              message_type: `job_${stage}`,
              metadata: JSON.stringify({
                entry_point: 'recruiting_comms_deferred',
                audience: 'applicant',
                purpose: stage,
                job_application_id: app.id,
                stage,
                // Replay contract (messaging/deferred-replay-registry.js
                // recruiting_comms_deferred): the ledger entry the cron
                // reconciles on send, and the application version the
                // recheck pins so a withdrawn/rebooked applicant never gets
                // an obsolete invite or confirmation.
                ledger_entry_id: handoffEntry.id,
                interview_token: app.interview_token || null,
                interview_at: app.interview_at ? new Date(app.interview_at).toISOString() : null,
                interview_mode: app.interview_mode || null,
                original_message_type: `job_${stage}`,
                consent_basis: { status: 'transactional_allowed', source: 'job_application' },
                original_block_code: sendRes.code || null,
              }),
            }).returning('id');
            const queuedRowId = Array.isArray(inserted) ? (inserted[0] && (inserted[0].id || inserted[0])) : null;
            outcome = 'deferred';
            deferredUntil = new Date(sendRes.nextAllowedAt).toISOString();
            await retireQueuedInvites(queuedRowId);
          } catch (err) {
            logger.error(`[recruiting-comms] deferred queue insert failed (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
          }
        }
        result.sms = outcome;
        // Reconcile the handoff entry in place; if this fails the entry stays
        // 'handoff', which the reply classifier still treats as a sent text.
        try {
          await finalizeCommsHistoryEntry(app.id, handoffEntry.id, {
            outcome, code: sendRes.code || null, finalized_at: new Date().toISOString(),
            ...(deferredUntil ? { scheduled_for: deferredUntil } : {}),
          });
        } catch (err) {
          logger.error(`[recruiting-comms] handoff reconcile failed (application ${app.id}, stage ${stage}): ${errorSummary(err)}`);
        }
      }
    }
  }

  return finishStage();

  async function finishStage() {
  if (wantEmail) {
    if (!(await legEligible())) {
      result.email = 'stale';
    } else if (!contact.email) {
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
        sendRes = await sendRawEmail({ app, stage, to: contact.email, subject, html, text, beforeProvider: legEligible });
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
}

/**
 * Owner-authored reply to an applicant from a shared surface (dashboard
 * inbox / composer): rides the recruiting rail — job_owner_reply message
 * type (hidden from non-admin readers), handoff evidence with the reply
 * line's number, so the applicant's NEXT reply still classifies owner-only.
 * @returns {Promise<{ outcome: string, applicationId: string|null }>}
 */
async function sendOwnerReply({ applicationId, body, by, fromNumber }) {
  const text = String(body || '').trim();
  if (!applicationId || !text) return { outcome: 'skipped', applicationId: applicationId || null };
  const app = await db('job_applications').where({ id: applicationId }).first();
  if (!app) return { outcome: 'skipped', applicationId };
  // Same eligibility the reply classifier applies (recruiting-inbound.js
  // OPEN_STATUSES): a text to a rejected/withdrawn/hired applicant would
  // invite a reply the classifier no longer protects (local audit P0).
  if (!['new', 'reviewed', 'interview', 'offer'].includes(String(app.status || ''))) {
    return { outcome: 'closed', applicationId };
  }
  // Provider-boundary guard, same as every other recruiting send (Codex r10
  // P1): the application must still be open when Twilio is actually called.
  const stillEligible = async () => {
    const now = await db('job_applications').where({ id: applicationId }).first('status');
    return Boolean(now && ['new', 'reviewed', 'interview', 'offer'].includes(String(now.status || '')));
  };
  const result = await sendStageComms(app, 'owner_reply', {
    sms: true, email: false, by: by || 'system', smsBody: text, fromNumber: fromNumber || undefined, entryPoint: 'recruiting_owner_reply',
    stillEligible,
  });
  return { outcome: result.sms, applicationId };
}

// The open application a shared-surface text to this phone belongs to
// (most recently updated open one). Applicants are never customers, so
// this is the only linkage a composer has.
async function openApplicationIdForPhone(phone) {
  const { phoneMatchDigits } = require('../utils/phone');
  const variants = phoneMatchDigits(String(phone || ''));
  if (!variants.length) return null;
  // The application that OWNS the recruiting evidence (Codex r10 P2): among
  // the open applications on this phone, the one with the newest SMS
  // attempt in its ledger — the same selection the reply classifier makes —
  // never merely the most recently updated row.
  const rows = await db('job_applications')
    .whereRaw("regexp_replace(COALESCE(contact_snapshot->>'phone', ''), '[^0-9]', '', 'g') = ANY (?::text[])", [variants])
    .whereIn('status', ['new', 'reviewed', 'interview', 'offer'])
    .select('id', 'comms_history', 'updated_at');
  let best = null;
  for (const r of rows) {
    const history = Array.isArray(r.comms_history) ? r.comms_history : [];
    for (const e of history) {
      if (!e || e.channel !== 'sms' || !['handoff', 'sent', 'uncertain', 'deferred'].includes(e.outcome)) continue;
      const at = Date.parse(e.at || '');
      if (!Number.isFinite(at)) continue;
      if (!best || at > best.at) best = { at, id: r.id };
    }
  }
  return best ? best.id : null;
}

module.exports = {
  openApplicationIdForPhone,
  sendOwnerReply,
  STAGE_PURPOSE,
  reconcileCommsHistoryEntryByOutcome,
  outboundNumberForApplicants,
  finalizeCommsHistoryEntry,
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
