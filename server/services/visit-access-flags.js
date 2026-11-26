/**
 * Visit access flags on the technician's Visit Brief (GATE_VISIT_ACCESS_FLAGS=on).
 *
 * The hourly sweep (typed-decisions/visit-access-shadow.js) stores, per visit,
 * the redacted state the providers read (visit_access_states) and one
 * decision_reviews row per provider and question. This module reads those back
 * as flags for the technician and takes their Right / Wrong tap:
 *
 *   accessFlagsFor(dbh, visit)   flags for the visit's NEWEST stored state
 *   tapAccessFlag(dbh, tap, who) Right / Wrong, as one verdict row
 *
 * Nothing here calls a model. A card shows when ANY provider said yes on the
 * newest state (a missed dog is worse than an extra flag) and the technician
 * has not marked it Wrong on that state, or when a Right they gave on an
 * EARLIER state of the same visit carries forward (the pet save itself changes
 * the state, and a confirmed warning must survive it). A Wrong never carries:
 * new evidence shows the card again.
 *
 * The tap writes ONE row to visit_access_verdicts, keyed by visit, question and
 * the evidence digest (`subjectHash`) the card was read from. It never touches
 * decision_reviews, so the providers' answers and the review lane's labels stay
 * as the sweep and the reviewers left them. The tap runs in one transaction
 * that holds a FOR SHARE lock on the visit row, so a reassignment cannot land
 * between the assignment check and the writes. Only the tap whose insert
 * created a Right on a dog flag saves the pet line, on the locked profile row
 * and only while it holds no pets; a replay writes nothing. Neither write
 * sends anything to a customer. Both paths re-prove the visit is still at its
 * customer's one premises, because the profile, texts and notes the state was
 * built from are keyed on the customer.
 */
const logger = require('./logger');
const { packageFor } = require('./typed-decisions/packages');
const { PACKAGE_ID, SUBJECT_TYPE, visitSinglePremises } = require('./typed-decisions/visit-access-shadow');

const REVIEWS = 'decision_reviews';
const STATES = 'visit_access_states';
const VERDICTS = 'visit_access_verdicts';
const QUOTE_CHARS = 160;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Everything redactForState (and the text window) generates is a bracketed
// marker: "[access detail withheld: ...]", "[redacted]", "[follow-up to ...]".
// It is the sweep's wording, never the customer's, so it is never quoted.
const MARKER_RE = /\[[^\]]*\]/;

const TEXTS = { field: 'recent_texts', label: 'Customer text' };
const NOTES = { field: 'notes_text', label: 'Notes on file' };
const LAST_TECH = { field: 'last_tech_notes', label: 'Last technician note' };

// Per question: the plain title, the tone, where its quote is looked for first
// (the customer's own words unless the question is about an earlier visit) and
// the words that pick the line.
const FLAGS = {
  dog_on_property: {
    title: 'Dog or other animal may be loose', tone: 'amber', sources: [TEXTS, NOTES, LAST_TECH],
    words: /\b(?:dogs?|pupp(?:y|ies)|pets?|cats?|animals?|bark\w*|pit\s?bulls?|retriever|k9)\b/i,
  },
  needs_code_key_or_person: {
    title: 'Code, key or a person needed to get in', tone: 'plain', sources: [TEXTS, NOTES, LAST_TECH],
    words: /\b(?:codes?|keys?|keypad|gate|lock\s?box|garage|locks?|doors?|openers?|fobs?|someone\s+(?:to|will\s+be)|let\s+(?:you|them)\s+in)\b/i,
  },
  contact_before_arrival: {
    title: 'Customer asked for a call or text before you arrive', tone: 'plain', sources: [TEXTS, NOTES, LAST_TECH],
    words: /\b(?:call|text|knock|ring|ahead|heads[- ]?up|before\s+(?:you|they|the\s+tech\w*)|notify|let\s+(?:me|us)\s+know)\b/i,
  },
  person_home_needs_notice: {
    title: 'Someone at home needs notice or care', tone: 'plain', sources: [TEXTS, NOTES, LAST_TECH],
    words: /\b(?:sleep\w*|nights?|baby|infant|newborn|toddler|elderly|ill|sick|nap\w*|sensitiv\w*|asthma|oxygen|pregnan\w*|medical|disabled)\b/i,
  },
  past_access_problem: {
    title: 'Access problem on an earlier visit', tone: 'amber', sources: [LAST_TECH, NOTES, TEXTS],
    words: /\b(?:locked|couldn['’]?t|could\s+not|no\s+one\s+home|nobody\s+home|not\s+home|no\s+access|unable|blocked|no\s+answer)\b/i,
  },
  access_fact_not_on_file: {
    title: 'Customer texted an access fact that is not on file', tone: 'plain', sources: [TEXTS],
    words: /\b(?:codes?|keys?|gate|lock\s?box|garage|dogs?|pets?|pupp(?:y|ies)|keypad)\b/i,
  },
};

const parse = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

// The line the model most likely read the answer from: the first sentence in
// the first field (in the question's order) that holds one of its words and is
// the writer's own (no generated marker). No match: quote null, and `source`
// names the fields that were read.
function pickQuote(state, questionId) {
  const flag = FLAGS[questionId];
  for (const { field, label } of flag.sources) {
    const lines = String(state?.[field] || '').split('\n');
    for (const line of lines) {
      const sentence = line.replace(/^\s*-\s*/, '').split(/(?<=[.!?])\s+/).find((part) => flag.words.test(part) && !MARKER_RE.test(part));
      if (sentence) return { quote: sentence.trim().slice(0, QUOTE_CHARS), source: label };
    }
  }
  const read = flag.sources.filter(({ field }) => String(state?.[field] || '').trim()).map(({ label }) => label.toLowerCase());
  return { quote: null, source: read.length ? `Read: ${read.join(', ')}` : 'Read: nothing written on file' };
}

const saidYes = (row) => parse(row.jev_answer)?.yes === true;

// Everything one visit's flags are read from: the newest stored state, its
// provider answers, and every verdict the technicians gave on the visit.
async function loadEvidence(dbh, visitId) {
  const stored = await dbh(STATES).where({ scheduled_service_id: visitId }).orderBy('created_at', 'desc').first('subject_hash', 'state');
  if (!stored) return null;
  const answers = await dbh(REVIEWS)
    .where({ package_id: PACKAGE_ID, subject_type: SUBJECT_TYPE, subject_id: visitId, subject_hash: stored.subject_hash })
    .select('question_id', 'jev_answer');
  const verdicts = await dbh(VERDICTS).where({ scheduled_service_id: visitId }).select('question_id', 'subject_hash', 'verdict');
  return { hash: stored.subject_hash, state: parse(stored.state) || {}, answers, verdicts };
}

// One question as the technician sees it: a verdict on the newest evidence
// wins; else a Right on any earlier evidence carries forward (a Wrong never
// does). A card shows for a Right, or for an open question any provider
// answered yes.
function questionView(ev, questionId) {
  const mine = ev.verdicts.filter((v) => v.question_id === questionId);
  const newest = mine.find((v) => v.subject_hash === ev.hash);
  let status = 'open';
  if (newest) status = newest.verdict;
  else if (mine.some((v) => v.verdict === 'right')) status = 'right';
  const yes = ev.answers.some((row) => row.question_id === questionId && saidYes(row));
  return { status, newestVerdict: newest ? newest.verdict : null, shown: status === 'right' || (status === 'open' && yes) };
}

// Pets are "on file" when the profile has a count or any detail text.
async function petsOnFile(dbh, customerId) {
  const prefs = await dbh('property_preferences').where({ customer_id: customerId }).first('pet_count', 'pet_details');
  return Boolean(prefs && (Number(prefs.pet_count) > 0 || String(prefs.pet_details || '').trim()));
}

/**
 * The flags for one visit's newest stored state. A visit no longer proven to be
 * at its customer's one premises has none. Never throws: any failure logs and
 * answers null, so the brief still serves.
 * @returns {Promise<Array<object> | null>}
 */
async function accessFlagsFor(dbh, visit) {
  try {
    if (!(await visitSinglePremises(visit.id, dbh))) return [];
    const ev = await loadEvidence(dbh, visit.id);
    if (!ev) return [];
    const flags = [];
    for (const questionId of Object.keys(packageFor(PACKAGE_ID).questions)) {
      const view = questionView(ev, questionId);
      if (!view.shown) continue;
      const flag = FLAGS[questionId];
      flags.push({
        questionId, title: flag.title, tone: flag.tone, status: view.status, subjectHash: ev.hash, ...pickQuote(ev.state, questionId),
        saveToFile: questionId === 'dog_on_property' && view.status === 'open' && !(await petsOnFile(dbh, visit.customer_id)) ? 'pets' : null,
      });
    }
    return flags;
  } catch (err) {
    logger.warn(`[visit-access-flags] read failed for ${visit && visit.id}: ${err.message}`);
    return null;
  }
}

// The pet line, written in the tap's transaction by the tap whose verdict row
// was just created. The profile row is locked, and the write itself holds the
// condition (no pet count, no pet text): nothing read earlier stands in for it.
// Says only what the technician confirmed: an animal is on the property.
async function savePet(trx, visit, who) {
  const { recordAuditEvent } = require('./audit-log');
  const { etParts } = require('../utils/datetime-et');
  await trx('property_preferences').insert({ customer_id: visit.customer_id }).onConflict('customer_id').ignore();
  const locked = await trx('property_preferences').where({ customer_id: visit.customer_id }).forUpdate().first('id');
  if (!locked) return false;
  const { month, day } = etParts();
  const [written] = await trx('property_preferences')
    .where({ id: locked.id })
    .whereRaw('(pet_count IS NULL OR pet_count = 0)')
    .whereRaw("(pet_details IS NULL OR btrim(pet_details) = '')")
    .update({ pet_details: `Animal on property (tech confirmed ${month}/${day})`, updated_at: trx.fn.now() })
    .returning('id');
  if (!written) return false;
  await recordAuditEvent({
    trx, critical: true, actor_type: 'technician', actor_id: who.actorId,
    action: 'visit_access_flag.pet_saved', resource_type: 'property_preferences', resource_id: locked.id,
    metadata: { visit_id: visit.id, customer_id: visit.customer_id, field: 'pet_details', labeled_by: who.labeledBy },
    ip_address: who.ip, user_agent: who.userAgent,
  });
  return true;
}

/**
 * A technician's tap on one flag, as one transaction.
 *
 * `scope(query)` adds the caller's assignment check to a scheduled_services
 * query; the visit row is read under FOR SHARE with it, so a reassignment
 * waits for this transaction and the check holds for every write below.
 *
 * Results: { notFound } (not this technician's visit, or no longer proven to be
 * at one premises), { conflict } (the evidence moved since the card was read,
 * or the question shows no card), else { status, saved }: the stored verdict.
 * A second tap on the same visit, question and evidence returns the stored
 * verdict and writes nothing. `saved` is true only for the tap that created the
 * Right and wrote the pet line.
 *
 * @param {{visitId:string, scope:Function, questionId:string, verdict:'right'|'wrong', subjectHash:string}} tap
 * @param {{labeledBy:string, actorId:string|null, ip:string|null, userAgent:string|null}} who
 */
async function tapAccessFlag(dbh, tap, who) {
  const { visitId, scope, questionId, verdict, subjectHash } = tap;
  return dbh.transaction(async (trx) => {
    const visit = await scope(trx('scheduled_services').where({ 'scheduled_services.id': visitId }))
      .forShare().first('scheduled_services.id', 'scheduled_services.customer_id');
    if (!visit || !(await visitSinglePremises(visit.id, trx))) return { notFound: true };
    const ev = await loadEvidence(trx, visit.id);
    if (!ev || ev.hash !== subjectHash) return { conflict: true };
    const view = questionView(ev, questionId);
    if (view.newestVerdict) return { status: view.newestVerdict, saved: false };
    if (!view.shown) return { conflict: true };
    const [created] = await trx(VERDICTS)
      .insert({ scheduled_service_id: visit.id, question_id: questionId, subject_hash: subjectHash, verdict, technician_id: UUID_RE.test(String(who.actorId)) ? who.actorId : null })
      .onConflict(['scheduled_service_id', 'question_id', 'subject_hash']).ignore().returning('id');
    // A concurrent tap on the same evidence won: its verdict stands.
    if (!created) {
      const stored = await trx(VERDICTS).where({ scheduled_service_id: visit.id, question_id: questionId, subject_hash: subjectHash }).first('verdict');
      return { status: stored.verdict, saved: false };
    }
    const saved = verdict === 'right' && questionId === 'dog_on_property' ? await savePet(trx, visit, who) : false;
    return { status: verdict, saved };
  });
}

module.exports = { FLAGS, accessFlagsFor, tapAccessFlag, pickQuote };
