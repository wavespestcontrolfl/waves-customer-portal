/**
 * Photo-text auto-triage (GATE_PHOTO_TRIAGE, dark by default).
 *
 * An inbound customer text that carries a photo and reads like a
 * lawn/plant/pest "what is this / what's wrong" question runs through the
 * admin photo-assessment pipeline (services/photo-assessment-create.js,
 * source 'auto_triage') and parks ONE pending reply draft in the existing
 * owner-approval queue (message_drafts, intent 'photo_triage', anchored to
 * the inbound sms_log row so an approved send credits the customer's
 * question). This lane NEVER sends: the draft is the terminal artifact and
 * only an owner's Approve in /admin/drafts puts a message on the wire.
 *
 * Called fire-and-forget from the Twilio inbound webhook AFTER the TwiML ack.
 * Every guard runs before any paid call:
 *   - gate off → fully inert (no DB read, no model call);
 *   - no image media, tech lines, and the AI assistant line are skipped;
 *   - internal senders (a Waves number, the owner's phone, a technician's
 *     phone) are skipped;
 *   - an opted-out / suppressed number is skipped (the canonical
 *     messaging_suppression check + notification_prefs.sms_enabled); an
 *     unknown suppression state fails closed;
 *   - a conversation that already has a pending draft is skipped, and the
 *     check is repeated atomically with the draft insert under a per-contact
 *     advisory lock (two photo texts finishing together park one draft);
 *   - one triage per message (messages.photo_triage_at claim) and at most
 *     PHOTO_TRIAGE_DAILY_CAP claims (= vision runs) per ET day, both decided
 *     in one transaction under an advisory lock.
 *
 * Draft copy is built ONLY from the customer-safe teaser allowlists the
 * public funnels already publish pre-capture — lawn: buildTeaser's gated
 * first finding (routes/public-lawn-assessment.js); pest: buildPestTeaser's
 * library-generic label (services/pest-identification.js). Never raw model
 * observations, never product names, never a link (the report link exists
 * only after an admin clicks Send report / Get link).
 */

const db = require('../models/db');
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { gateEnvValue } = require('../config/feature-gates');
const { classifyPhotoDiagnosisIntent } = require('./sms-service-intent');
const {
  createAdminAssessment,
  MAX_PHOTOS,
  MESSAGE_PHOTO_ALLOWED_MIME,
} = require('./photo-assessment-create');
const { isSignableStoredMediaKey } = require('./sms-media');
const { loadSuppressionState, checkSuppression } = require('./messaging/validators/suppression');
const { countSegments } = require('./messaging/segment-counter');
const { buildPestTeaser } = require('./pest-identification');
const { safePublicFirstName } = require('../utils/public-report-egress');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

const GATE = 'GATE_PHOTO_TRIAGE';
const DRAFT_INTENT = 'photo_triage';
const ASSESSMENT_SOURCE = 'auto_triage';
const DEFAULT_DAILY_CAP = 20;
const MAX_DRAFT_SEGMENTS = 2;
const CAP_LOCK_KEY = 'photo_triage_daily_cap';
const CONTACT_LOCK_KEY = 'photo_triage_contact';
const LAST10_SQL = (column) => `RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10)`;

function dailyCap() {
  const parsed = Number.parseInt(process.env.PHOTO_TRIAGE_DAILY_CAP, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_CAP;
}

function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

// The inbound media entries the assessment pipeline can actually load: a
// stored S3 key under the signable prefix with an allowed image type.
function imageMedia(media) {
  return (Array.isArray(media) ? media : [])
    .filter((item) => item && isSignableStoredMediaKey(item.key)
      && MESSAGE_PHOTO_ALLOWED_MIME.has(String(item.contentType || item.mimeType || '').toLowerCase()))
    .slice(0, MAX_PHOTOS);
}

async function isInternalSender(from) {
  const key = phoneKey(from);
  if (!key || TWILIO_NUMBERS.findByNumber(from)) return true;
  if (key === phoneKey(process.env.ADAM_PHONE)) return true;
  const tech = await db('technicians').whereRaw(`${LAST10_SQL('phone')} = ?`, [key]).first('id');
  return Boolean(tech);
}

// Reuses the canonical send-side suppression check (messaging_suppression:
// STOP keyword / natural-language opt-out / wrong number / DNC / landline).
// Unknown suppression state (lookup failed, table missing) fails CLOSED.
async function isOptedOut(from, customerId) {
  const state = await loadSuppressionState({ to: from }, {});
  if (state.suppressionLoaded !== true) return true;
  const verdict = await checkSuppression({ channel: 'sms', to: from }, null, state);
  if (!verdict.ok) return true;
  if (!customerId) return false;
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first('sms_enabled');
  return prefs?.sms_enabled === false;
}

// Any pending draft already queued for this contact: one anchored to an
// inbound text from this phone, one whose flags name this phone, or one on
// the same customer. One pending draft per conversation.
async function hasPendingDraft(from, customerId, conn = db) {
  const key = phoneKey(from);
  const row = await conn('message_drafts as md')
    .leftJoin('sms_log as sl', 'sl.id', 'md.sms_log_id')
    .where('md.status', 'pending')
    .where(function sameContact() {
      this.whereRaw(`${LAST10_SQL('sl.from_phone')} = ?`, [key])
        .orWhereRaw(`${LAST10_SQL("COALESCE(md.flags->>'toPhone', md.flags->>'phone')")} = ?`, [key]);
      if (customerId) this.orWhere('md.customer_id', customerId);
    })
    .first('md.id');
  return Boolean(row);
}

// One transaction under a global advisory lock: count today's claims (ET
// day), refuse at the cap, otherwise stamp THIS message — a message that is
// already stamped is never analyzed twice.
async function claimTriage(messageId) {
  const cap = dailyCap();
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAP_LOCK_KEY]);
    const dayStart = parseETDateTime(`${etDateString()}T00:00`);
    const [{ n }] = await trx('messages')
      .where('channel', 'sms')
      .where('created_at', '>=', new Date(dayStart.getTime() - 24 * 60 * 60 * 1000))
      .where('photo_triage_at', '>=', dayStart)
      .count('* as n');
    if (Number(n) >= cap) return 'cap_reached';
    const claimed = await trx('messages')
      .where({ id: messageId })
      .whereNull('photo_triage_at')
      .update({ photo_triage_at: db.fn.now() }, ['id']);
    return claimed.length ? 'claimed' : 'already_triaged';
  });
}

// The one customer-safe label the teaser allowlist publishes pre-capture.
function teaserFindingLabel(type, analysis) {
  if (type === 'lawn') {
    const { buildTeaser } = require('../routes/public-lawn-assessment');
    return buildTeaser(analysis).first_finding?.name || null;
  }
  const teaser = buildPestTeaser(JSON.parse(analysis.report_contract || '{}'));
  const match = /^We identified (.+)\.$/.exec(teaser.identified_teaser || '');
  return match ? match[1] : null;
}

// ≤ MAX_DRAFT_SEGMENTS SMS segments, no link. The first name is dropped
// before anything else when the copy would run long.
function buildDraftText({ firstName, findingLabel }) {
  const finding = findingLabel
    ? ` From what we can see, it looks like ${findingLabel}.`
    : ' We are taking a closer look now.';
  const close = " We'll send a full report link shortly. Want us to schedule a visit to take a look in person?";
  const compose = (name) => `Thanks for the photo${name ? `, ${name}` : ''}.${finding}${close}`;
  const named = compose(safePublicFirstName(firstName));
  return countSegments(named).segmentCount <= MAX_DRAFT_SEGMENTS ? named : compose(null);
}

// The final pending-draft check and the insert commit together under a
// per-contact advisory lock, so two photo texts from one contact whose vision
// calls finish at the same moment can never both park a draft. Returns the
// draft id, or null when a pending draft already exists.
async function parkDraftUnlessPending({ from, smsLogId, customer, body, text, created, messageId, method }) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [CONTACT_LOCK_KEY, phoneKey(from)]);
    if (await hasPendingDraft(from, customer?.id, trx)) return null;
    const [draft] = await trx('message_drafts').insert({
      sms_log_id: smsLogId,
      customer_id: customer?.id || null,
      inbound_message: body || null,
      draft_response: text,
      intent: DRAFT_INTENT,
      status: 'pending',
      context_summary: `Photo triage ran a ${created.type} assessment on this text's photo. Review the assessment before approving.`,
      flags: JSON.stringify({
        origin: DRAFT_INTENT,
        assessment_type: created.type,
        assessment_id: created.id,
        message_id: messageId,
        classifier_method: method,
      }),
    }).returning(['id']);
    return draft.id;
  });
}

async function runGuards({ messageId, smsLogId, from, numberType, isAiNumber, customer, images }) {
  if (!images.length) return 'no_image';
  if (!messageId || !smsLogId) return 'no_source_row';
  if (numberType === 'tech_line' || isAiNumber) return 'excluded_line';
  if (await isInternalSender(from)) return 'internal_sender';
  if (await isOptedOut(from, customer?.id)) return 'opted_out';
  return null;
}

/**
 * @returns {Promise<{ status: 'skipped', reason: string } | { status: 'drafted', draftId, assessmentId, type }>}
 */
async function triageInboundPhotoText({
  inboundTouchpoint, smsLogEntry, body, from, numberType, isAiNumber, customer, media,
}) {
  if (!gateEnvValue(GATE)) return { status: 'skipped', reason: 'gate_off' };
  const messageId = inboundTouchpoint?.message?.id || null;
  const smsLogId = smsLogEntry?.id || null;
  const images = imageMedia(media);

  const guard = await runGuards({ messageId, smsLogId, from, numberType, isAiNumber, customer, images });
  if (guard) return { status: 'skipped', reason: guard };

  const intent = await classifyPhotoDiagnosisIntent(body);
  if (intent.intent !== 'photo_diagnosis') return { status: 'skipped', reason: 'not_diagnosis' };
  if (await hasPendingDraft(from, customer?.id)) return { status: 'skipped', reason: 'pending_draft' };

  const claim = await claimTriage(messageId);
  if (claim !== 'claimed') {
    logger.info(`[photo-triage] message ${messageId} skipped: ${claim}`);
    return { status: 'skipped', reason: claim };
  }

  const created = await createAdminAssessment({
    type: intent.assessmentType,
    source: ASSESSMENT_SOURCE,
    message_photos: images.map((item) => ({ message_id: messageId, key: item.key })),
  });
  if (created.error) {
    logger.error(`[photo-triage] assessment failed for message ${messageId} (${created.status || 'error'})`);
    return { status: 'skipped', reason: 'assessment_failed' };
  }

  const text = buildDraftText({
    firstName: customer?.first_name,
    findingLabel: teaserFindingLabel(created.type, created.analysis),
  });
  // A second photo text from the same contact may have drafted while this
  // one's vision call ran — the assessment is kept, the draft is not.
  const draftId = await parkDraftUnlessPending({ from, smsLogId, customer, body, text, created, messageId, method: intent.method });
  if (!draftId) {
    logger.info(`[photo-triage] ${created.type} assessment ${created.id} kept; draft skipped (pending draft appeared)`);
    return { status: 'skipped', reason: 'pending_draft' };
  }
  logger.info(`[photo-triage] message ${messageId} → ${created.type} assessment ${created.id}, pending draft ${draftId}`);
  return { status: 'drafted', draftId, assessmentId: created.id, type: created.type };
}

module.exports = {
  triageInboundPhotoText,
  DRAFT_INTENT,
  _test: {
    dailyCap,
    imageMedia,
    isInternalSender,
    isOptedOut,
    hasPendingDraft,
    claimTriage,
    parkDraftUnlessPending,
    teaserFindingLabel,
    buildDraftText,
  },
};
