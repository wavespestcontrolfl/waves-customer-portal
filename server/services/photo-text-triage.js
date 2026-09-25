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
 * Two steps, both called from the Twilio inbound webhook AFTER the TwiML ack:
 *   assessPhotoTriageCandidacy — every cheap guard, then the intent check
 *     (regex fast path; the paid FAST classifier only with budget left).
 *     Awaited once, BEFORE the legacy AI draft step, whose gate reads the
 *     result (legacyAiDraftsAllowed): a triage candidate never also gets a
 *     legacy draft that would then block its own photo-triage draft.
 *     A candidate has already RESERVED its vision slot, so suppressing the
 *     legacy draft always leaves the text with a triage run.
 *   runPhotoTriage — takes that candidacy (the classifier is never re-run),
 *     runs the assessment, parks the draft. A failure before the paid
 *     analysis starts clears the stamp again (released, logged at error);
 *     once the analysis started the stamp stays spent, and a later failure
 *     is logged at error (naming the kept assessment when one exists).
 * Every guard runs before any paid call:
 *   - gate off → fully inert (no DB read, no model call);
 *   - no image media, tech lines, and the AI assistant line are skipped;
 *   - internal senders (a Waves number, the owner's phone, a technician's
 *     phone) are skipped;
 *   - an opted-out / suppressed number is skipped (the canonical
 *     messaging_suppression check + notification_prefs.sms_enabled); an
 *     unknown suppression state fails closed;
 *   - a conversation that already has a pending draft is skipped (before
 *     any model call), and the
 *     check is repeated atomically with the draft insert under a per-contact
 *     advisory lock (two photo texts finishing together park one draft);
 *   - no model call at all once today's vision budget is spent (a
 *     non-consuming read of the count);
 *   - the paid classifier (captions the regex can't place) is bounded by its
 *     own per-message claim (messages.photo_triage_classified_at) and
 *     PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP per ET day (default = the vision cap);
 *   - one triage per message (messages.photo_triage_at claim) and at most
 *     PHOTO_TRIAGE_DAILY_CAP claims (= vision runs) per ET day, both decided
 *     in one transaction under an advisory lock. A classifier "no" never
 *     burns a vision slot.
 *
 * Draft copy is built ONLY from the customer-safe teaser allowlists the
 * public funnels already publish pre-capture — lawn: buildTeaser's gated
 * first finding (routes/public-lawn-assessment.js); pest: buildPestTeaser's
 * library-generic label (services/pest-identification.js); tree_shrub: its
 * own worst_signal (photo-triage-opportunity.js). Never raw model
 * observations, never product names, never a link (the report link exists
 * only after an admin clicks Send report / Get link).
 *
 * What the draft SAYS beyond the finding — advise / offer a compute-only
 * quote / ask for an in-person visit — is decided by the opportunity gauge
 * (photo-triage-opportunity.js#gaugeOpportunity, owner ruling 2026-09-25):
 * it reads the finding, the caption, and the customer's own record to pick
 * one of three modes, minimizing on-site visits in favor of advice or a
 * quote wherever the numbers support one.
 */

const db = require('../models/db');
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { gateEnvValue, isEnabled } = require('../config/feature-gates');
const { classifyPhotoDiagnosisIntent } = require('./sms-service-intent');
const {
  createAdminAssessment,
  MAX_PHOTOS,
  MESSAGE_PHOTO_ALLOWED_MIME,
} = require('./photo-assessment-create');
const { isSignableStoredMediaKey } = require('./sms-media');
const { loadSuppressionState, checkSuppression } = require('./messaging/validators/suppression');
const { countSegments } = require('./messaging/segment-counter');
const { gaugeOpportunity, teaserOutcome } = require('./photo-triage-opportunity');
const { safePublicFirstName } = require('../utils/public-report-egress');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

const GATE = 'GATE_PHOTO_TRIAGE';
const DRAFT_INTENT = 'photo_triage';
const ASSESSMENT_SOURCE = 'auto_triage';
const DEFAULT_DAILY_CAP = 20;
const MAX_DRAFT_SEGMENTS = 2;
// Per-message stamp column → its own ET-day cap. Vision runs and paid
// classifier calls are budgeted separately.
const SLOTS = {
  vision: { column: 'photo_triage_at', lockKey: 'photo_triage_daily_cap', taken: 'already_triaged', full: 'cap_reached' },
  classifier: { column: 'photo_triage_classified_at', lockKey: 'photo_triage_classifier_cap', taken: 'already_classified', full: 'classifier_cap_reached' },
};
const CONTACT_LOCK_KEY = 'photo_triage_contact';
const LAST10_SQL = (column) => `RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10)`;

function capFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function dailyCap(slot = 'vision') {
  const vision = capFromEnv('PHOTO_TRIAGE_DAILY_CAP', DEFAULT_DAILY_CAP);
  return slot === 'vision' ? vision : capFromEnv('PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP', vision);
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

// Stamps of `column` taken since the start of this ET day. Only inbound SMS
// rows are ever stamped; the direction + channel + created_at range (two
// days covers every same-day stamp) matches the existing
// messages (direction, channel, created_at) index.
function slotsTakenToday(conn, column) {
  const dayStart = parseETDateTime(`${etDateString()}T00:00`);
  return conn('messages')
    .where('direction', 'inbound')
    .where('channel', 'sms')
    .where('created_at', '>=', new Date(dayStart.getTime() - 24 * 60 * 60 * 1000))
    .where(column, '>=', dayStart)
    .count('* as n')
    .then(([row]) => Number(row.n));
}

// Non-consuming: is any of today's vision budget left? Read before any
// model call so a spent budget costs nothing further.
async function visionBudgetLeft() {
  return (await slotsTakenToday(db, SLOTS.vision.column)) < dailyCap('vision');
}

// One transaction under the slot's advisory lock: count today's stamps,
// refuse at the cap, otherwise stamp THIS message — a message already
// stamped for the slot is never charged (or analyzed) twice.
async function claimSlot(slot, messageId) {
  const { column, lockKey, taken, full } = SLOTS[slot];
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [lockKey]);
    if ((await slotsTakenToday(trx, column)) >= dailyCap(slot)) return full;
    const claimed = await trx('messages')
      .where({ id: messageId })
      .whereNull(column)
      .update({ [column]: db.fn.now() }, ['id']);
    return claimed.length ? 'claimed' : taken;
  });
}

// Hands a vision slot back: a run that failed after its claim leaves the
// message unstamped (eligible for a later triage) and the failed run off
// today's budget. Best-effort — a failed release only costs one slot.
async function releaseVisionSlot(messageId) {
  await db('messages').where({ id: messageId }).update({ [SLOTS.vision.column]: null })
    .catch((err) => logger.error(`[photo-triage] vision slot release failed for message ${messageId}: ${err.message}`));
}

// tree_shrub has no customer-safe teaser label of its own (see
// photo-triage-opportunity.js#treeShrubOutcome) — this phrase map mirrors
// TREE_SHRUB_SIGNAL_PHRASE there, sized for "it's {label}." in a text.
const TREE_SHRUB_LABEL = {
  water_heat_mechanical_stress: 'water or heat stress',
  pest_activity: 'pest-pressure signals',
  disease_leaf_spot: 'leaf-spot signals',
  foliage_fullness: 'thin foliage',
  leaf_color_vigor: 'uneven leaf color',
};
const TREE_SHRUB_HEALTHY_LABEL = 'no major visible stress';

// One short piece of fixed advice per tree/shrub worst_signal — never model
// text, so the copy can't drift or overclaim. Empty for lawn/pest (their own
// teaser label already carries the finding) and for signals with no simple
// fixed tip.
const TREE_SHRUB_ADVICE = {
  water_heat_mechanical_stress: 'Pull mulch a few inches back from the trunk and water deep and even.',
};

// "it's {label}." — lawn/pest reuse the allowlisted teaser label
// (photo-triage-opportunity.js#teaserOutcome); tree_shrub has no teaser
// builder yet, so its worst_signal maps to a fixed phrase above. A pest
// outcome of kind 'none' (nothing nameable) returns null — the caller falls
// back to the old bare "want us to take a look?" copy for that case only.
function messageLabel(type, analysis) {
  if (type === 'tree_shrub') {
    const worst = analysis?.worst_signal || null;
    return worst ? (TREE_SHRUB_LABEL[worst] || 'a few things worth a look') : TREE_SHRUB_HEALTHY_LABEL;
  }
  const teaser = teaserOutcome(type, analysis);
  return teaser.label || null;
}

function messageAdvice(type, analysis) {
  if (type !== 'tree_shrub') return '';
  return TREE_SHRUB_ADVICE[analysis?.worst_signal] || '';
}

function joinSentences(parts) {
  return parts.filter(Boolean).join(' ');
}

const QUOTE_SERVICE_LABEL = { tree_shrub: 'tree & shrub', lawn_care: 'lawn', pest_control: 'pest control' };

// The sentences after the greeting, keyed by the opportunity gauge's mode
// (owner ruling 2026-09-25 — see photo-triage-opportunity.js). Fixed copy +
// an allowlisted label/advice/quote only, and nothing Approve does not
// deliver: approving sends only this text (no report, no link — staff mint
// the report link from the draft's View assessment link). Pure — takes the
// already-resolved label/advice rather than re-deriving them, so it (and the
// "every real label fits in two segments" regression tests) never need a
// real photo-analysis fixture.
function composeBody({ label, advice, opportunity }) {
  if (label === null) return 'Want us to take a look?';

  const lead = `From what we can see, it's ${label}.`;

  if (opportunity.mode === 'onsite') {
    return joinSentences([
      lead,
      "With that much to cover we'd rather see it in person before quoting. What day this week works for a quick visit?",
    ]);
  }

  if (opportunity.mode === 'quote' && opportunity.quote) {
    const serviceLabel = QUOTE_SERVICE_LABEL[opportunity.quote.service] || 'service';
    const monthly = Math.round(Number(opportunity.quote.monthly) || 0);
    const quoteLine = `Our ${opportunity.quote.frequency}-visit ${serviceLabel} program at your home is about $${monthly}/mo. Want me to add it?`;
    return joinSentences([lead, advice, quoteLine]);
  }

  // advise
  const harmless = opportunity.reasons.includes('harmless');
  return joinSentences([lead, advice, harmless ? 'No treatment is needed.' : "Reply if you'd like a quote."]);
}

function draftBodyText({ type, analysis, opportunity }) {
  return composeBody({ label: messageLabel(type, analysis), advice: messageAdvice(type, analysis), opportunity });
}

// ≤ MAX_DRAFT_SEGMENTS SMS segments, no link. The first name is dropped
// before anything else when the copy would run long. Takes an
// already-composed body (see composeBody/draftBodyText) so the name +
// segment-cap logic has exactly one implementation.
function composeDraft({ firstName, bodyText }) {
  const compose = (name) => `Thanks for the photo${name ? `, ${name}` : ''}. ${bodyText}`;
  const named = compose(safePublicFirstName(firstName));
  return countSegments(named).segmentCount <= MAX_DRAFT_SEGMENTS ? named : compose(null);
}

function buildDraftText({ firstName, type, analysis, opportunity }) {
  return composeDraft({ firstName, bodyText: draftBodyText({ type, analysis, opportunity }) });
}

// The final pending-draft check and the insert commit together under a
// per-contact advisory lock, so two photo texts from one contact whose vision
// calls finish at the same moment can never both park a draft. Returns the
// draft id, or null when a pending draft already exists.
// The one pending-draft dedupe path for this lane's writers — the photo
// triage draft and its legacy AI draft fallback: the final check and the
// insert commit together under a per-contact advisory lock, so no two
// pending drafts can land for one conversation. Returns the draft id, or
// null when a pending draft already exists.
async function insertDraftUnlessPending({ from, customer }, row) {
  return db.transaction(async (trx) => {
    // Keyed like hasPendingDraft's widest match: the customer when the text
    // resolved to one (two stored numbers are one conversation), else the
    // phone.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [CONTACT_LOCK_KEY, customer?.id ? `customer:${customer.id}` : phoneKey(from)]);
    if (await hasPendingDraft(from, customer?.id, trx)) return null;
    const [draft] = await trx('message_drafts').insert(row).returning(['id']);
    return draft.id;
  });
}

async function parkDraftUnlessPending({ from, smsLogId, customer, body, text, created, messageId, method, opportunity }) {
  return insertDraftUnlessPending({ from, customer }, {
    sms_log_id: smsLogId,
    customer_id: customer?.id || null,
    inbound_message: body || null,
    draft_response: text,
    intent: DRAFT_INTENT,
    status: 'pending',
    context_summary: `Photo triage ran a ${created.type} assessment on this text's photo and gauged it as ${opportunity.mode}`
      + ` (${opportunity.reasons.join(', ') || 'no signals'}). Review the assessment before approving.`,
    flags: JSON.stringify({
      origin: DRAFT_INTENT,
      assessment_type: created.type,
      assessment_id: created.id,
      message_id: messageId,
      classifier_method: method,
      opportunity_mode: opportunity.mode,
      opportunity_reasons: opportunity.reasons,
      quote: opportunity.quote,
    }),
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

const notCandidate = (reason) => ({ candidate: false, reason });

// Cheap guards first, then the intent check; the paid classifier runs only
// with vision budget left AND a classifier slot claimed for this message.
// Never throws past the caller's catch; never writes except the classifier
// slot stamp.
async function assessPhotoTriageCandidacy({
  inboundTouchpoint, smsLogEntry, body, from, numberType, isAiNumber, customer, media,
}) {
  if (!gateEnvValue(GATE)) return notCandidate('gate_off');
  const messageId = inboundTouchpoint?.message?.id || null;
  const smsLogId = smsLogEntry?.id || null;
  const images = imageMedia(media);

  const guard = await runGuards({ messageId, smsLogId, from, numberType, isAiNumber, customer, images });
  if (guard) return notCandidate(guard);
  if (await hasPendingDraft(from, customer?.id)) return notCandidate('pending_draft');
  if (!(await visionBudgetLeft())) return notCandidate(SLOTS.vision.full);

  let classifierClaim = null;
  const intent = await classifyPhotoDiagnosisIntent(body, {
    allowModel: async () => {
      classifierClaim = await claimSlot('classifier', messageId);
      return classifierClaim === 'claimed';
    },
  });
  if (intent.intent !== 'photo_diagnosis') {
    return notCandidate(classifierClaim && classifierClaim !== 'claimed' ? classifierClaim : 'not_diagnosis');
  }
  // Reserve the vision slot HERE, before this result suppresses the legacy
  // draft: a message is a candidate only when its assessment is guaranteed
  // a slot, so losing the last slot to a concurrent text falls back to the
  // legacy path instead of leaving the customer with no draft at all.
  const visionClaim = await claimSlot('vision', messageId);
  if (visionClaim !== 'claimed') return notCandidate(visionClaim);
  return { candidate: true, intent, messageId, smsLogId, images, body, from, customer };
}

// The legacy AI draft step's gate. A photo-triage candidate's own draft is
// the reply for that text; a legacy draft on the same inbound would sit in
// the queue first and make the triage skip as "pending draft".
function legacyAiDraftsAllowed(candidacy) {
  if (!isEnabled('legacyAiDrafts')) return false;
  if (candidacy?.candidate) {
    logger.info(`[photo-triage] legacy AI draft deferred to photo triage for message ${candidacy.messageId}`);
    return false;
  }
  return true;
}

// Draft for a finished assessment (the paid vision already ran).
async function parkForAssessment({ intent, messageId, smsLogId, body, from, customer, images }, created) {
  const opportunity = await gaugeOpportunity({ type: created.type, analysis: created.analysis, customer, body, images });
  const text = buildDraftText({
    firstName: customer?.first_name,
    type: created.type,
    analysis: created.analysis,
    opportunity,
  });
  // A second photo text from the same contact may have drafted while this
  // one's vision call ran — the assessment is kept (its slot stays spent),
  // the draft is not.
  const draftId = await parkDraftUnlessPending({ from, smsLogId, customer, body, text, created, messageId, method: intent.method, opportunity });
  if (!draftId) {
    logger.info(`[photo-triage] ${created.type} assessment ${created.id} kept; draft skipped (pending draft appeared)`);
    return { status: 'skipped', reason: 'pending_draft' };
  }
  logger.info(`[photo-triage] message ${messageId} → ${created.type} assessment ${created.id}, pending draft ${draftId}`);
  return { status: 'drafted', draftId, assessmentId: created.id, type: created.type };
}

/**
 * @returns {Promise<{ status: 'skipped', reason: string } | { status: 'drafted', draftId, assessmentId, type }>}
 */
async function runPhotoTriage(candidacy, { legacyFallback = null } = {}) {
  if (!candidacy?.candidate) return { status: 'skipped', reason: candidacy?.reason || 'not_candidate' };
  const result = await assessAndDraft(candidacy);
  // A candidate suppressed the legacy AI draft; a terminal failure hands the
  // text back to it so the customer still gets a reply draft to approve.
  // The fallback parks through the same contact-locked dedupe as the
  // triage draft, so it never lands beside another pending draft.
  if (FALLBACK_REASONS.has(result.reason) && legacyFallback) {
    logger.info(`[photo-triage] message ${candidacy.messageId} ${result.reason}; parking the legacy AI draft instead`);
    await legacyFallback({ park: (row) => insertDraftUnlessPending(candidacy, row) });
  }
  return result;
}

const FALLBACK_REASONS = new Set(['assessment_failed', 'draft_failed']);

async function assessAndDraft(candidacy) {
  const { intent, messageId, images } = candidacy;

  // A failure BEFORE the paid analysis started (photo fetch / validation)
  // clears the reservation: the message is not marked triaged and the
  // failure is off today's budget. Once the analysis started the stamp
  // stays spent whatever happens next — releasing it would let repeated
  // failures exceed PHOTO_TRIAGE_DAILY_CAP.
  let created;
  try {
    created = await createAdminAssessment({
      type: intent.assessmentType,
      source: ASSESSMENT_SOURCE,
      message_photos: images.map((item) => ({ message_id: messageId, key: item.key })),
    });
  } catch (err) {
    created = { error: err.message, analysisStarted: err.analysisStarted === true };
  }
  if (created.error) {
    const spent = created.analysisStarted === true;
    logger.error(`[photo-triage] assessment failed for message ${messageId}; vision slot ${spent ? 'kept (analysis started)' : 'released'}: ${created.error}`);
    if (!spent) await releaseVisionSlot(messageId);
    return { status: 'skipped', reason: 'assessment_failed' };
  }

  // The assessment exists and its paid analysis ran: the slot stays spent
  // (clearing it would let repeated draft failures exceed the daily cap and
  // re-analyze the same photos). The assessment is on the assessments page.
  try {
    return await parkForAssessment(candidacy, created);
  } catch (err) {
    logger.error(`[photo-triage] draft failed for message ${messageId}; ${created.type} assessment ${created.id} kept: ${err.message}`);
    return { status: 'skipped', reason: 'draft_failed' };
  }
}

module.exports = {
  assessPhotoTriageCandidacy,
  legacyAiDraftsAllowed,
  runPhotoTriage,
  DRAFT_INTENT,
  _test: {
    dailyCap,
    imageMedia,
    isInternalSender,
    isOptedOut,
    hasPendingDraft,
    claimSlot,
    visionBudgetLeft,
    releaseVisionSlot,
    parkDraftUnlessPending,
    insertDraftUnlessPending,
    teaserOutcome,
    buildDraftText,
    messageLabel,
    messageAdvice,
    draftBodyText,
    composeBody,
    composeDraft,
  },
};
