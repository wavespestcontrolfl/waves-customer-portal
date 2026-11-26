/**
 * Visit access flags on the technician's Visit Brief (GATE_VISIT_ACCESS_FLAGS=on).
 *
 * The hourly sweep (typed-decisions/visit-access-shadow.js) stores, per visit,
 * the redacted state the providers read (visit_access_states) and one
 * decision_reviews row per provider and question. This module reads those
 * rows back as flags for the technician and takes their Right / Wrong tap:
 *
 *   accessFlagsFor(dbh, visit)        flags for the visit's NEWEST stored state
 *   tapAccessFlag(dbh, visit, ...)    Right / Wrong: labels the question's rows
 *
 * Nothing here calls a model. A question is flagged when ANY provider said yes
 * (a missed dog is worse than an extra flag) and no one has marked it wrong.
 * A tap labels every row of the question for that state from what the
 * technician says is true, through the shared label write
 * (typed-decisions/label-write.js), so the review lane learns from it. The
 * only write beside the label is the pet save: Right on a dog flag, with no
 * pets on file, saves one pet_details line to the customer's profile. Neither
 * write sends anything to a customer.
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

async function newestState(dbh, visitId) {
  return dbh(STATES).where({ scheduled_service_id: visitId }).orderBy('created_at', 'desc').first('subject_hash', 'state', 'created_at');
}

function reviewRows(dbh, visitId, subjectHash) {
  return dbh(REVIEWS)
    .where({ package_id: PACKAGE_ID, subject_type: SUBJECT_TYPE, subject_id: visitId, subject_hash: subjectHash })
    .select('id', 'provider', 'question_id', 'subject_hash', 'jev_answer', 'label', 'label_status', 'package_id');
}

const saidYes = (row) => parse(row.jev_answer)?.yes === true;

// Groups a state's rows by question, in the package's order.
function byQuestion(rows) {
  const out = [];
  for (const id of Object.keys(packageFor(PACKAGE_ID).questions)) {
    const mine = rows.filter((row) => row.question_id === id);
    if (mine.length) out.push([id, mine]);
  }
  return out;
}

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
    const stored = await newestState(dbh, visit.id);
    if (!stored) return [];
    const state = parse(stored.state) || {};
    const readAt = new Date(stored.created_at).toISOString();
    const rows = await reviewRows(dbh, visit.id, stored.subject_hash);
    const flags = [];
    for (const [questionId, mine] of byQuestion(rows)) {
      const status = humanStatus(mine);
      if (!mine.some(saidYes) || status === 'wrong') continue;
      const flag = FLAGS[questionId];
      flags.push({
        questionId, title: flag.title, tone: flag.tone, status, readAt, ...pickQuote(state, questionId),
        saveToFile: questionId === 'dog_on_property' && !(await petsOnFile(dbh, visit.customer_id)) ? 'pets' : null,
      });
    }
    return flags;
  } catch (err) {
    logger.warn(`[visit-access-flags] read failed for ${visit && visit.id}: ${err.message}`);
    return null;
  }
}

// Right on a dog flag with no pets on file: one pet_details line, written
// through the same compare-and-set writer the text-note Save button uses.
// Sends nothing (property_preferences has no customer-facing hook for
// pet_details; its two triggers watch the gate code and the irrigation fields).
async function savePet(dbh, visit, who) {
  const { resolvePropertyPreferencesTarget, applyPropertyPreferenceValue } = require('./data-hygiene/property-preferences');
  const { recordAuditEvent } = require('./audit-log');
  const { etParts } = require('../utils/datetime-et');
  if (await petsOnFile(dbh, visit.customer_id)) return false;
  const { month, day } = etParts();
  const proposedRaw = `Dog (customer text; confirmed by tech ${month}/${day})`;
  const existing = await dbh('property_preferences').where({ customer_id: visit.customer_id }).first('pet_details');
  try {
    await dbh.transaction(async (trx) => {
      const proposal = { scope_id: visit.customer_id, field: 'pet_details', resource_id: null };
      const target = await resolvePropertyPreferencesTarget({ trx, proposal, currentRaw: existing ? existing.pet_details ?? null : null });
      await applyPropertyPreferenceValue({ trx, proposal, target, proposedRaw });
      await recordAuditEvent({
        trx, critical: true, actor_type: 'technician', actor_id: who.actorId,
        action: 'visit_access_flag.pet_saved', resource_type: 'property_preferences', resource_id: target.id,
        metadata: { visit_id: visit.id, customer_id: visit.customer_id, field: 'pet_details', labeled_by: who.labeledBy },
        ip_address: who.ip, user_agent: who.userAgent,
      });
    });
    return true;
  } catch (err) {
    // The profile changed under the compare-and-set: nothing was saved.
    if (err.status === 409) return false;
    throw err;
  }
}

// One row's verdict from what the technician says is true: its answer
// matches (right) or not (wrong, carrying the true answer).
function rowRequest(row, truth) {
  const seen = parse(row.jev_answer);
  if (!seen || typeof seen.yes !== 'boolean') return null;
  return { verdict: seen.yes === truth ? 'jev_right' : 'jev_wrong', seen, seenSubject: row.subject_hash, note: null, reason: null, force: false };
}

/**
 * A technician's tap on one flag. Labels every still-unlabeled row of the
 * question for the visit's newest state, then (Right on a dog flag with no
 * pets on file) saves the pet line. A row somebody already confirmed is left
 * alone, so the same tap twice changes nothing.
 * @param {{verdict:'right'|'wrong', questionId:string}} tap
 * @param {{labeledBy:string, actorId:string|null, ip:string|null, userAgent:string|null}} who
 * @returns {Promise<null | {status:string, saved:boolean}>} null when the visit holds no rows for the question
 */
async function tapAccessFlag(dbh, visit, { questionId, verdict }, who) {
  const stored = await newestState(dbh, visit.id);
  const mine = stored ? (await reviewRows(dbh, visit.id, stored.subject_hash)).filter((row) => row.question_id === questionId) : [];
  if (!mine.length) return null;
  const truth = verdict === 'right';
  const labeler = { labeledBy: who.labeledBy, machine: false, actorType: 'technician', actorId: who.actorId, ip: who.ip, userAgent: who.userAgent };
  for (const row of mine) {
    if (CONFIRMED.includes(row.label_status)) continue;
    const request = rowRequest(row, truth);
    if (!request) continue;
    const correct = correctValueFor(row, request, truth);
    if (correct.error) continue;
    const written = await writeLabel(row.id, request, correct, labeler);
    // Another tap or a reviewer got there first: that row stays as it is.
    if (!written.row && written.status !== 409) throw new Error(`label write failed (${written.status})`);
  }
  await require('./typed-decisions/daily-review-item').closeIfQueueEmpty()
    .catch((err) => logger.warn(`[visit-access-flags] review item close failed: ${err.message}`));
  const status = humanStatus(await reviewRows(dbh, visit.id, stored.subject_hash).where({ question_id: questionId }));
  const saved = truth && questionId === 'dog_on_property' ? await savePet(dbh, visit, who) : false;
  return { status, saved };
}

module.exports = { FLAGS, accessFlagsFor, tapAccessFlag, pickQuote, humanStatus };
