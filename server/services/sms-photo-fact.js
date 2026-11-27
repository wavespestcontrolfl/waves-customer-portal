'use strict';
// PHOTO CHECK (owner 2026-11-26 "BUILD 1-6", texting AI gap 6): the texting AI cannot see a customer's photo. The photo checker that already
// runs on inbound photo texts (photo-text-triage.js, GATE_PHOTO_TRIAGE: one admin pest assessment per photo text, its own daily cap) stores
// what it read: the pest_identifications row (source 'auto_triage') named by the photo_triage draft it parks on the same inbound sms_log row.
// This module READS that stored result (no vision call, no paid call) and turns it into ONE finished sentence the texting AI may copy word
// for word, e.g. "From your photo, it looks like a German cockroach. Your technician will confirm at the visit."
//
// What may be said, and only this:
//   - a pest assessment only (lawn and tree & shrub results say nothing here), whose species is in the pest library allowlist
//     (pest-identification.js PEST_LIBRARY) AND in PHOTO_PHRASES below, read at the checker's own bar: the confidence the checker names a
//     species at (buildPestTeaser identified_specific: not low) and not contested between photos;
//   - always hedged ("it looks like") and always "Your technician will confirm at the visit", so only for a customer with a visit booked;
//   - ants, termites, anything the library marks a structural threat, and stinging or venomous species: NO species claim at all (termite
//     versus ant swarmers cannot be told apart from a photo, and a wrong "harmless" or "dangerous" read is a safety claim). The sentence then
//     says only that the technician will check it at the visit;
//   - never a health, medical, bite, safety or price claim, never "safe", never "nothing to worry about" (a not-a-pest read says nothing).
// A low-confidence or unmatched read, an archived or relinked assessment, a photo_triage draft the owner rejected, or a triage that has not
// finished yet: no sentence (a person answers). A read that FAILED is null, never a guess.
//
// The send boundary (sms-amount-recheck.photoCheckStale) re-renders the sentence of the inbound text the decision answers from a fresh read:
// a copied sentence that is no longer rendered (the assessment archived or relinked, the draft rejected, the visit gone) refuses the send.

const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');

// How far back an unbound read looks (the drafter and the send recheck always bind to one inbound text).
const PHOTO_CHECK_LOOKBACK_DAYS = 14;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USABLE_STATUSES = new Set(['analyzed', 'sent']);

// The species a photo may be named as, by library slug, in customer words. A slug not listed here is never named (a new library entry says
// nothing until it is added here on purpose). Ants, termites, structural threats and stinging/venomous species are deliberately absent:
// they get CHECK_AT_VISIT_SENTENCE (see photoCheckKind).
const PHOTO_PHRASES = {
  'american-roach': 'an American cockroach (palmetto bug)',
  'german-roach': 'a German cockroach',
  'wolf-spider': 'a wolf spider',
  mosquito: 'a mosquito',
  'chinch-bug': 'chinch bugs',
  'sod-webworm': 'sod webworms or armyworms',
  'white-grub': 'white grubs',
  flea: 'a flea',
  tick: 'a tick',
  'bed-bug': 'a bed bug',
  silverfish: 'a silverfish',
  earwig: 'an earwig',
  millipede: 'a millipede',
  centipede: 'a centipede',
  'stink-bug': 'a stink bug',
  rodent: 'signs of rodents',
  whitefly: 'whiteflies',
  'aphid-scale': 'aphids or scale insects',
};
// The library groups whose photo read never names a species (termite versus ant swarmers).
const NO_SPECIES_GROUPS = new Set(['ants', 'termites']);

const NAMED_SENTENCE_START = 'From your photo, it looks like ';
const NAMED_SENTENCE_END = '. Your technician will confirm at the visit.';
const CHECK_AT_VISIT_SENTENCE = 'Your technician will check what is in your photo at the visit.';

let librarySlugs = null;
function libraryBySlug() {
  if (!librarySlugs) librarySlugs = new Map(require('./pest-identification').PEST_LIBRARY.map((entry) => [entry.slug, entry]));
  return librarySlugs;
}

function parseJson(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

/**
 * What a stored reading may say: 'named' (the species, hedged), 'check' (no species: the technician checks it at the visit) or null (nothing).
 * Pure: reads the stored report_contract's identification only.
 */
function photoCheckKind(check) {
  const ident = check?.identification || {};
  const item = ident.slug ? libraryBySlug().get(ident.slug) : null;
  if (!item) return null;
  if (ident.category === 'not_a_pest' || item.category === 'not_a_pest') return null;
  const safety = item.safety || {};
  if (NO_SPECIES_GROUPS.has(item.group) || safety.structural_threat || safety.stinging || safety.venomous) return { kind: 'check' };
  // the checker's own bar: a species is named only above low confidence and when the photos agree
  if (ident.contested || !['moderate', 'high'].includes(ident.confidence)) return null;
  const phrase = PHOTO_PHRASES[item.slug];
  return phrase ? { kind: 'named', phrase } : null;
}

/** The ONE sentence a stored reading renders ('' = none). A customer with no visit booked gets none: the sentence promises the visit. */
function photoCheckSentence(check, { hasUpcomingVisit = false } = {}) {
  if (!hasUpcomingVisit) return '';
  const verdict = photoCheckKind(check);
  if (!verdict) return '';
  return verdict.kind === 'check' ? CHECK_AT_VISIT_SENTENCE : `${NAMED_SENTENCE_START}${verdict.phrase}${NAMED_SENTENCE_END}`;
}

// Every sentence this module can render (tests and the send recheck's staff-edit form).
function allRenderableSentences() {
  return [CHECK_AT_VISIT_SENTENCE, ...Object.values(PHOTO_PHRASES).map((phrase) => `${NAMED_SENTENCE_START}${phrase}${NAMED_SENTENCE_END}`)];
}

/**
 * The stored photo-checker readings for this customer's inbound photo texts: [{ smsLogId, assessmentId, identification }], newest first.
 * `smsLogId` narrows to that one inbound text (the drafter and the send recheck); without it, the last PHOTO_CHECK_LOOKBACK_DAYS.
 * Only a pest assessment the checker ran (source auto_triage) on this customer's text, still linked to this customer, not archived, whose
 * photo_triage draft the owner did not reject. [] when there is none (or the checker has not finished); null when the read failed.
 */
async function loadPhotoChecks(customerId, { db, smsLogId = null, now = new Date() } = {}) {
  if (!customerId || !db) return null;
  try {
    let query = db('message_drafts')
      .where({ intent: 'photo_triage', customer_id: customerId })
      .whereNot('status', 'rejected')
      .whereNotNull('sms_log_id');
    query = smsLogId
      ? query.where('sms_log_id', smsLogId)
      : query.where('created_at', '>=', new Date(now.getTime() - PHOTO_CHECK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
    const drafts = await query.orderBy('created_at', 'desc').select('sms_log_id', 'flags');
    const links = drafts
      .map((row) => ({ smsLogId: row.sms_log_id, flags: parseJson(row.flags) }))
      .filter(({ flags }) => flags.assessment_type === 'pest' && UUID_RE.test(String(flags.assessment_id || '')))
      .map(({ smsLogId: id, flags }) => ({ smsLogId: id, assessmentId: String(flags.assessment_id) }));
    if (!links.length) return [];
    const rows = await db('pest_identifications')
      .whereIn('id', [...new Set(links.map((link) => link.assessmentId))])
      .select('id', 'source', 'customer_id', 'status', 'archived_at', 'report_contract');
    const byId = new Map(rows.map((row) => [row.id, row]));
    return links.flatMap((link) => {
      const row = byId.get(link.assessmentId);
      if (!row || row.source !== 'auto_triage' || row.customer_id !== customerId || row.archived_at || !USABLE_STATUSES.has(row.status)) return [];
      return [{ smsLogId: link.smsLogId, assessmentId: row.id, identification: parseJson(row.report_contract).identification || {} }];
    });
  } catch (err) {
    logger.warn(`[sms-photo-fact] photo check unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// The sentence for a drafting context: "a visit booked" = the context's upcoming services list is not empty. The send recheck renders through
// this same function over a fresh context.
function sentenceForContext(context, check) {
  return check ? photoCheckSentence(check, { hasUpcomingVisit: Array.isArray(context?.upcomingServices) && context.upcomingServices.length > 0 }) : '';
}

/**
 * The drafter's one read: the stored reading of THIS inbound photo text, or null. Real answers on, a photo on the text, its sms_log row and
 * a customer only; a failed read is no reading. No wait: the checker runs beside the draft, so one still running gives no sentence.
 */
async function draftPhotoCheck({ hasMedia, smsLogId, customer, db }) {
  const customerId = customer?.id;
  if (!hasMedia || !smsLogId || !customerId || !gateEnvValue('GATE_SMS_REAL_ANSWERS')) return null;
  const checks = await loadPhotoChecks(customerId, { db, smsLogId });
  return checks?.[0] || null;
}

// ---- The model's own photo wording ----------------------------------------------------------------------------------------------------
// The texting AI may say what is in a photo only by copying the PHOTO CHECK sentence. A sentence of the reply that identifies, names or
// judges what a photo shows in its own words is held: an identification cue ("looks like", "appears to be", "identified", "that's a",
// "those are", "harmless", "dangerous", "safe") together with a pest or condition word, in a sentence that names the photo (or, for a reply
// to a text that carried a photo, in any sentence). "Thanks for the photo" or "send us a picture of the bugs" carry no cue and pass.
const PHOTO_NOUN_RE = /\b(?:photos?|pictures?|pics?|images?|snapshots?|screenshots?)\b/i;
const ID_CUE_RE = /\b(?:looks?|looked|appears?|appeared|seems?|seemed)\s+(?:like|to\s+be)\b|\b(?:shows?|showing|showed|pictured)\b|\bis\s+an?\b|\bidentif\w*|\b(?:it|that|this|these|those|they)(?:'s|’s|'re|’re|\s+is|\s+are|\s+was|\s+were)\b|\b(?:harmless|dangerous|venomous|poisonous|safe|nothing\s+to\s+worry)\b/i;
// A direct declaration of a pest ("those are fire ants", "it's a German cockroach", "that's a termite"), plural or singular.
// One pest and condition vocabulary for every check here (a pest word in a sentence, a direct declaration of one).
const PEST_WORDS = String.raw`bugs?|insects?|pests?|roach(?:es)?|cockroach(?:es)?|palmetto|ants?|termites?|swarmers?|spiders?|widow|recluse|wasps?|hornets?|bees?|yellow ?jackets?|mosquito(?:e?s)?|fleas?|ticks?|bed ?bugs?|rodents?|rats?|mouse|mice|droppings|beetles?|weevils?|silverfish|earwigs?|millipedes?|centipedes?|stink ?bugs?|whitefl(?:y|ies)|aphids?|scale|grubs?|webworms?|armyworms?|chinch|caterpillars?|moths?|fl(?:y|ies)|gnats?|larva[e]?|scorpions?|snakes?|lizards?|frogs?|nests?|mounds?|frass|fungus|disease|mold|mildew|weeds?|damage|species`;
const PEST_WORD_RE = new RegExp(String.raw`\b(?:${PEST_WORDS})\b`, 'i');
const DECLARED_PEST = String.raw`(?:definitely\s+|probably\s+|likely\s+)?(?:an?\s+|some\s+)?(?:[a-z]+\s+)?(?:${PEST_WORDS})\b`;
const STRONG_CUE_RE = new RegExp(String.raw`\b(?:looks?|looked|appears?|appeared|seems?|seemed)\s+(?:like|to\s+be)\b|\b(?:shows?|showing|showed|pictured)\b|\bidentif\w*|\b(?:harmless|dangerous|venomous|poisonous|nothing\s+to\s+worry)\b|\b(?:those|these|they)(?:'re|\s+are)\s+${DECLARED_PEST}|\b(?:it|that|this)(?:'s|\s+is|\s+was)\s+${DECLARED_PEST}`, 'i');

// A safety judgment on its own ("It's harmless.", "Totally safe."): on a photo text it is a judgment of the photo even with no pest word.
const SAFETY_JUDGMENT_RE = /\b(?:harmless|safe|dangerous|nothing\s+to\s+worry\s+about)\b/i;
// The one text form both reply checks read: whitespace flattened, curly apostrophes straightened.
function flatReply(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/[\u2018\u2019]/g, "'");
}

// The label-facts wording a reply may carry on any text (a LABEL FACTS re-entry or rainfast sentence, the sanctioned "safe once dry" +
// technician idiom) is not a judgment of a photo: it is removed before the photo checks read the reply. The label-facts module's own
// sentence forms and idiom rule decide what counts (sms-label-facts.labelSentencesIn / sanctionSafeOnceDry).
function withoutLabelWording(text) {
  const labelFacts = require('./sms-label-facts');
  // (guarded: partial test doubles of sms-label-facts omit these helpers; the text is then judged whole, the stricter reading)
  if (typeof labelFacts.sanctionSafeOnceDry !== 'function' || typeof labelFacts.labelSentencesIn !== 'function') return text;
  return sentencesOf(labelFacts.sanctionSafeOnceDry(text))
    .filter((sentence) => !labelFacts.labelSentencesIn(`- ${sentence}`).length)
    .join(' ')
    .replace(/\bSANCTIONED_IDIOM\b/g, ' ');
}

function sentencesOf(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether `text` (with the allowed verbatim sentences removed) still says what a photo shows in its own words.
 * `inboundHasPhoto`: the text it answers carried a photo, so an identification with no photo word counts too.
 */
function photoClaimInOwnWords(text, { allowed = [], inboundHasPhoto = false } = {}) {
  let rest = withoutLabelWording(flatReply(text));
  for (const sentence of allowed.filter(Boolean)) rest = rest.split(sentence).join(' ');
  // with no photo word in the sentence, only a strong cue counts ("it's on Friday" in a reply about an ant visit is not an identification)
  return sentencesOf(rest).some((sentence) => (inboundHasPhoto && SAFETY_JUDGMENT_RE.test(sentence)) || (PEST_WORD_RE.test(sentence)
    && (PHOTO_NOUN_RE.test(sentence) ? ID_CUE_RE.test(sentence) : inboundHasPhoto && STRONG_CUE_RE.test(sentence))));
}

/**
 * The drafter's verdict on a reply (gate on only; gate off = nothing): `held` = it says what a photo shows in its own words, or carries a
 * PHOTO CHECK sentence form this draft's facts did not render for this inbound text (kept a shadow row); `copies` = it carries the rendered
 * sentence; `snapshot` = the intended_actions key naming the reading the facts rendered ({} = none). Whether the draft may auto-send is not
 * decided here: a reply to a text with a photo (or an unknown media state) never auto-sends (the drafter's review rule and claimAutoSend).
 */
function replyPhotoVerdict({ reply, context, photoCheck, inboundHasPhoto }) {
  if (!gateEnvValue('GATE_SMS_REAL_ANSWERS')) return { copies: false, held: false, snapshot: {} };
  const sentence = sentenceForContext(context, photoCheck);
  const flat = flatReply(reply);
  const unbacked = claimsPhotoCheck(sentence ? flat.split(sentence).join(' ') : flat);
  const held = unbacked || photoClaimInOwnWords(reply, { allowed: [sentence], inboundHasPhoto: Boolean(inboundHasPhoto) });
  if (held) logger.warn(`[sms-photo-fact] draft states a photo reading the facts did not give — kept shadow (customer=${context?.customer?.id || 'unknown'})`);
  return {
    copies: Boolean(sentence) && flat.includes(sentence),
    held,
    snapshot: sentence ? { photo_check: { sms_log_id: photoCheck.smsLogId, assessment_id: photoCheck.assessmentId } } : {},
  };
}

// A body that carries (or edits) a PHOTO CHECK sentence: the send recheck judges it.
const claimsPhotoCheck = (text) => {
  const flat = String(text || '').replace(/\s+/g, ' ');
  return flat.includes(NAMED_SENTENCE_START.trim()) || flat.includes(CHECK_AT_VISIT_SENTENCE);
};

module.exports = {
  PHOTO_CHECK_LOOKBACK_DAYS,
  PHOTO_PHRASES,
  NAMED_SENTENCE_START,
  CHECK_AT_VISIT_SENTENCE,
  photoCheckKind,
  photoCheckSentence,
  sentenceForContext,
  draftPhotoCheck,
  replyPhotoVerdict,
  allRenderableSentences,
  loadPhotoChecks,
  photoClaimInOwnWords,
  claimsPhotoCheck,
};
