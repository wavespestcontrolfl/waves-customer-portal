/**
 * Visit access flags on the technician's Visit Brief (GATE_VISIT_ACCESS_FLAGS=on).
 *
 * The hourly sweep (typed-decisions/visit-access-shadow.js) stores, per visit,
 * the redacted state the providers read (visit_access_states) and one
 * decision_reviews row per provider and question. This module reads those
 * rows back as flags for the technician and takes their Right / Wrong tap:
 *
 *   accessFlagsFor(dbh, visit)   flags for the visit's NEWEST stored state
 *   tapAccessFlag(dbh, tap, who) Right / Wrong: labels the question's rows
 *
 * Nothing here calls a model. A question is flagged when ANY provider said yes
 * (a missed dog is worse than an extra flag) and no one has marked it wrong.
 * A Right confirmation on an EARLIER state of the same visit carries forward
 * (the pet save itself changes the state, and the warning must survive it); a
 * Wrong does not (new evidence should show again).
 *
 * A tap is bound to the evidence the technician saw (`subjectHash`) and runs
 * in one transaction that holds a FOR SHARE lock on the visit row, so the
 * assignment check and every write after it see the same assignment: a
 * reassignment cannot land in between. The labels go through the shared label
 * write (typed-decisions/label-write.js). The only write beside them is the pet
 * save: an accepted Right on a dog flag, while the profile holds no pets,
 * writes one pet_details line. Neither write sends anything to a customer.
 */
const logger = require('./logger');
const { packageFor } = require('./typed-decisions/packages');
const { writeLabel, correctValueFor, CONFIRMED } = require('./typed-decisions/label-write');
const { PACKAGE_ID, SUBJECT_TYPE } = require('./typed-decisions/visit-access-shadow');

const REVIEWS = 'decision_reviews';
const STATES = 'visit_access_states';
const QUOTE_CHARS = 160;

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
    words: /\b(?:locked|couldn['’]?t|could\s+not|no\s+one\s+home|nobody\s+home|not\s+home|no\s+access|unable|blocked|no\s+answer|reports\s+a\s+problem\s+getting\s+in)\b/i,
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
// the first field (in the question's order) that holds one of its words. No
// match: quote null, and `source` names the fields that were read.
function pickQuote(state, questionId) {
  const flag = FLAGS[questionId];
  for (const { field, label } of flag.sources) {
    const lines = String(state?.[field] || '').split('\n');
    for (const line of lines) {
      const sentence = line.replace(/^\s*-\s*/, '').split(/(?<=[.!?])\s+/).find((part) => flag.words.test(part));
      if (sentence) return { quote: sentence.trim().slice(0, QUOTE_CHARS), source: label };
    }
  }
  const read = flag.sources.filter(({ field }) => String(state?.[field] || '').trim()).map(({ label }) => label.toLowerCase());
  return { quote: null, source: read.length ? `Read: ${read.join(', ')}` : 'Read: nothing written on file' };
}

// What a technician (or reviewer) has said is true for a question, from its
// confirmed rows: a confirmed-correct row confirms its own answer; a
// confirmed-error row says the opposite. 'right' beats 'wrong' if they differ.
function humanStatus(rows) {
  const truths = rows.filter((row) => CONFIRMED.includes(row.label_status)).map((row) => {
    const said = parse(row.jev_answer)?.yes;
    const stated = parse(row.label)?.correct_value;
    if (row.label_status === 'confirmed_correct') return said;
    return typeof stated === 'boolean' ? stated : !said;
  }).filter((truth) => typeof truth === 'boolean');
  if (truths.includes(true)) return 'right';
  return truths.length ? 'wrong' : 'open';
}

const saidYes = (row) => parse(row.jev_answer)?.yes === true;
const newestAt = (rows) => rows.reduce((best, row) => (row.created_at && (!best || new Date(row.created_at) > best) ? new Date(row.created_at) : best), null);

// Everything one visit's flags are read from: the newest stored state and
// every review row of the visit (all states: an earlier state's Right carries).
async function loadEvidence(dbh, visitId) {
  const stored = await dbh(STATES).where({ scheduled_service_id: visitId }).orderBy('created_at', 'desc').first('subject_hash', 'state', 'created_at');
  if (!stored) return null;
  const rows = await dbh(REVIEWS)
    .where({ package_id: PACKAGE_ID, subject_type: SUBJECT_TYPE, subject_id: visitId })
    .select('id', 'provider', 'question_id', 'subject_hash', 'jev_answer', 'label', 'label_status', 'package_id', 'created_at');
  const atNewest = rows.filter((row) => row.subject_hash === stored.subject_hash);
  return { stored, state: parse(stored.state) || {}, rows, atNewest, readAt: newestAt(atNewest) || new Date(stored.created_at) };
}

// One question as the technician sees it: its status, and whether a card shows.
// Newest state: any provider yes, not marked wrong. A Right confirmed on an
// earlier state of the visit carries forward while the newest state's rows are
// unlabeled; a Wrong never does.
function questionView(ev, questionId) {
  const mine = ev.atNewest.filter((row) => row.question_id === questionId);
  let status = humanStatus(mine);
  if (status === 'open') {
    const earlier = new Map();
    for (const row of ev.rows) {
      if (row.question_id === questionId && row.subject_hash !== ev.stored.subject_hash) earlier.set(row.subject_hash, [...(earlier.get(row.subject_hash) || []), row]);
    }
    if ([...earlier.values()].some((rows) => humanStatus(rows) === 'right')) status = 'right';
  }
  return { mine, status, shown: status === 'right' || (status === 'open' && mine.some(saidYes)) };
}

const shownQuestionIds = (ev) => Object.keys(packageFor(PACKAGE_ID).questions).filter((id) => questionView(ev, id).shown);

// Pets are "on file" when the profile has a count or any detail text.
async function petsOnFile(dbh, customerId) {
  const prefs = await dbh('property_preferences').where({ customer_id: customerId }).first('pet_count', 'pet_details');
  return Boolean(prefs && (Number(prefs.pet_count) > 0 || String(prefs.pet_details || '').trim()));
}

/**
 * The flags for one visit's newest stored state. Never throws: any failure
 * logs and answers null, so the brief still serves.
 * @returns {Promise<Array<object> | null>}
 */
async function accessFlagsFor(dbh, visit) {
  try {
    const ev = await loadEvidence(dbh, visit.id);
    if (!ev) return [];
    const flags = [];
    for (const questionId of shownQuestionIds(ev)) {
      const view = questionView(ev, questionId);
      const flag = FLAGS[questionId];
      flags.push({
        questionId, title: flag.title, tone: flag.tone, status: view.status, subjectHash: ev.stored.subject_hash,
        readAt: (newestAt(view.mine) || ev.readAt).toISOString(), ...pickQuote(ev.state, questionId),
        saveToFile: questionId === 'dog_on_property' && view.status === 'open' && !(await petsOnFile(dbh, visit.customer_id)) ? 'pets' : null,
      });
    }
    return flags;
  } catch (err) {
    logger.warn(`[visit-access-flags] read failed for ${visit && visit.id}: ${err.message}`);
    return null;
  }
}

// Right on a dog flag: one pet_details line, written in the tap's transaction.
// The profile row is locked, and the write itself holds the condition (no pet
// count, no pet text): nothing read earlier stands in for it, so a profile
// that gained pets since the card was shown is never overwritten. Says only
// what the technician confirmed: an animal is on the property.
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

// One row's verdict from what the technician says is true: its answer
// matches (right) or not (wrong, carrying the true answer).
function rowRequest(row, truth) {
  const seen = parse(row.jev_answer);
  if (!seen || typeof seen.yes !== 'boolean') return null;
  return { verdict: seen.yes === truth ? 'jev_right' : 'jev_wrong', seen, seenSubject: row.subject_hash, note: null, reason: null, force: false };
}

async function labelRows(trx, rows, truth, who) {
  const labeler = { labeledBy: who.labeledBy, machine: false, actorType: 'technician', actorId: who.actorId, ip: who.ip, userAgent: who.userAgent };
  for (const row of rows) {
    if (CONFIRMED.includes(row.label_status)) continue;
    const request = rowRequest(row, truth);
    const correct = request && correctValueFor(row, request, truth);
    if (!correct || correct.error) continue;
    const written = await writeLabel(row.id, request, correct, labeler, trx);
    // Another writer got there first: that row stays as it is.
    if (!written.row && written.status !== 409) throw new Error(`label write failed (${written.status})`);
  }
}

/**
 * A technician's tap on one flag, as one transaction.
 *
 * `scope(query)` adds the caller's assignment check to a scheduled_services
 * query; the visit row is read under FOR SHARE with it, so a reassignment
 * waits for this transaction and the check holds for every write below.
 *
 * Results: { notFound } (not this technician's visit), { conflict } (the flag
 * is not one that shows now, or the evidence moved since the card was read),
 * else { status, saved }: the question's status after the tap. A tap that
 * contradicts a confirmed answer is refused with nothing written (the first
 * confirmation stands), and only an accepted Right saves the pet line.
 *
 * @param {{visitId:string, scope:Function, questionId:string, verdict:'right'|'wrong', subjectHash:string}} tap
 * @param {{labeledBy:string, actorId:string|null, ip:string|null, userAgent:string|null}} who
 */
async function tapAccessFlag(dbh, tap, who) {
  const { visitId, scope, questionId, verdict, subjectHash } = tap;
  const truth = verdict === 'right';
  const out = await dbh.transaction(async (trx) => {
    const visit = await scope(trx('scheduled_services').where({ 'scheduled_services.id': visitId }))
      .forShare().first('scheduled_services.id', 'scheduled_services.customer_id');
    if (!visit) return { notFound: true };
    const ev = await loadEvidence(trx, visit.id);
    if (!ev || ev.stored.subject_hash !== subjectHash) return { conflict: true };
    const view = questionView(ev, questionId);
    if (!view.shown) return view.status === verdict ? { status: view.status, saved: false } : { conflict: true };
    if (view.status !== 'open' && view.status !== verdict) return { status: view.status, saved: false };
    await labelRows(trx, view.mine, truth, who);
    const after = questionView(await loadEvidence(trx, visit.id), questionId);
    const saved = truth && questionId === 'dog_on_property' && after.status === 'right' ? await savePet(trx, visit, who) : false;
    return { status: after.status, saved, labeled: true };
  });
  if (out.labeled) {
    await require('./typed-decisions/daily-review-item').closeIfQueueEmpty()
      .catch((err) => logger.warn(`[visit-access-flags] review item close failed: ${err.message}`));
  }
  return out.labeled ? { status: out.status, saved: out.saved } : out;
}

module.exports = { FLAGS, accessFlagsFor, tapAccessFlag, pickQuote, humanStatus };
