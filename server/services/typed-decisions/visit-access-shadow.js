/**
 * Visit access and safety flags, shadow leg (visit_access.v1; dark behind
 * GATE_VISIT_ACCESS_FLAGS=shadow, honoured only while GATE_TYPED_DECISIONS is
 * live).
 *
 * For each of today's and tomorrow's open visits the sweep builds one small
 * state (the visit's service line, how many visits came before it, a few
 * structured facts, the notes a technician already sees, the customer's own
 * recent texts, the last technician's note), puts the package's six yes/no
 * questions to each live provider and records every answer in
 * decision_reviews (subject_type 'scheduled_services').
 *
 * SHADOW ONLY: nothing here is shown to a technician, written to a visit, a
 * brief or a customer record, belled or sent. The rows are evidence for the
 * later card flags.
 *
 * No code leaves: the state says only WHETHER codes are on file
 * (`structured.has_codes`), and every free-text field passes redactForState:
 * a text or note naming any access point or credential is replaced whole by a marker
 * built from closed vocabularies (which access points; whether a problem is
 * reported), a text sent just after one is withheld with it, and in any other
 * text digit-bearing and code-shaped tokens are masked.
 *
 * property_preferences is the primary home's row, so a visit stamped at
 * another address (stamped-address.js) is left out: its pets, codes and
 * notes would be another property's.
 *
 * The state is a function of the visit and of facts dated before it, never of
 * "now": texts stop at the visit's own start (stateCutoff) and history counts
 * only days before its date. So the review route rebuilds the same state, and
 * the same digest, after the visit is done; a visit whose state did change
 * (a new text, an edited note) is asked again on the next pass and its
 * unreviewed rows are replaced.
 */
const crypto = require('crypto');
const logger = require('../logger');
const { visitAccessShadowLive, typedDecisionsClefLive } = require('../../config/feature-gates');

const PACKAGE_ID = 'visit_access.v1';
const SUBJECT_TYPE = 'scheduled_services';
// Visits asked per pass; the rest wait for the next hourly pass. Visits whose
// state is already answered cost reads only and never count against it.
const MAX_ASKED_VISITS = 80;
const WORKERS = 2;
const MAX_TEXTS = 8;
const TEXT_CHARS = 260;
const NOTE_CHARS = 600;
const NOTES_TEXT_CHARS = 1500;
// The comms window's recurring cap (completion-comms-context RECURRING_CAP_DAYS).
const WINDOW_CAP_DAYS = 120;
const DEFAULT_START = '08:00';

const compact = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

// Redaction rules (redactForState below):
//  1. A text that names ANY access point or credential noun (ACCESS_NOUNS), or
//     holds a sentence completion-comms-context's isAccessSentence reads as
//     being about getting in, never leaves as written. A credential can be any
//     word in any notation ("use BLUE at the keypad", "Garage:sesame", "four
//     five four five"), so no token rule is safe there. It becomes a marker
//     built from two closed vocabularies only: the access nouns it mentioned
//     and whether it reports a problem. None of the writer's words survive.
//  2. In every other text, a token holding a digit is masked unless it is a
//     one- or two-digit number, an ordinal, a clock time or a day/month date
//     (house numbers, phone numbers and years go too), and so is a
//     capitalised code-shaped token ("BLUE") unless the line is shouted.
const ACCESS_NOUNS = [
  ['code', /\b(?:codes?|pins?|pass(?:code|word|phrase)s?|combos?|combinations?)\b/i],
  ['key', /\bkeys?\b/i],
  ['keypad', /\bkeypads?\b/i],
  ['lockbox', /\block\s*box(?:es)?\b/i],
  ['gate', /\bgates?\b/i],
  ['garage', /\bgarages?\b/i],
  ['door', /\bdoors?\b/i],
  ['lock', /\b(?:locks?|deadbolts?|padlocks?)\b/i],
  ['alarm', /\balarms?\b/i],
  ['remote', /\b(?:fobs?|remotes?|openers?)\b/i],
];
const ACCESS_PROBLEM_RE = /\b(?:locked|stuck|jammed|blocked|broken|closed|no\s+access|not?\s+(?:get|reach|access|open|enter)|(?:could|can|did|would|was|were)(?:\s+not|n['’]?t)\s+(?:get|reach|access|open|enter|able)|unable|nobody\s+(?:was\s+)?home|no\s+one\s+(?:was\s+)?home)\b/i;
// An instruction verb a credential rides on with no access noun beside it
// ("use sesame", "punch in blue"): such a text is withheld as well.
const ACCESS_VERB_RE = /\b(?:use|using|type|typing|punch(?:ing)?|press(?:ing)?|enter(?:ing)?|dial(?:ing)?|key\s+in|say|tell\s+(?:them|him|her))\b/i;
const PLAIN_NUMBER_RE = /^(?:\d{1,2}|\d+(?:st|nd|rd|th)|\d{1,2}(?::\d{2})?(?:am|pm)?|\d{1,2}\/\d{1,2})$/i;
const CAPS_CODE_RE = /^[A-Z][A-Z#*-]{2,}$/;
function shouted(sentence) {
  const words = sentence.match(/[A-Za-z]{2,}/g) || [];
  return words.length >= 3 && words.filter((word) => word === word.toUpperCase()).length / words.length >= 0.6;
}
// Whether a text names an access point or credential anywhere in it.
function mentionsAccess(text) {
  const { isAccessSentence } = require('../completion-comms-context');
  const whole = String(text || '');
  return ACCESS_NOUNS.some(([, re]) => re.test(whole)) || ACCESS_VERB_RE.test(whole)
    || whole.split(/(?<=[.!?])\s+|\n+/).some((sentence) => isAccessSentence(sentence));
}

// The closed-vocabulary marker for a withheld text: which access points it
// named and whether it reports a problem. Never any of its words.
function accessMarker(raw) {
  const nouns = ACCESS_NOUNS.filter(([, re]) => re.test(raw)).map(([name]) => name);
  const parts = [];
  if (nouns.length) parts.push(`mentions ${nouns.join(', ')}`);
  if (ACCESS_PROBLEM_RE.test(raw)) parts.push('reports a problem getting in');
  return parts.length ? `[access detail withheld: ${parts.join('; ')}]` : '[access detail withheld]';
}

// The unit is the WHOLE text (one note field, one customer text), never a
// sentence or a line: a credential can sit on the line after its access point
// ("Garage:\nsesame"), so a text that mentions access anywhere leaves only as
// the marker (pre-push P0, 2026-10-03).
function redactForState(text) {
  // redactAccessCodes ends with the sensitive-identifier pass (SSN, card, CVV).
  const { redactAccessCodes } = require('../context-aggregator');
  const raw = String(text || '');
  if (!raw.trim()) return '';
  if (mentionsAccess(raw)) return accessMarker(raw);
  return redactAccessCodes(raw).split(/\n+/).map((line) => {
    const loud = shouted(line);
    return line.replace(/\S+/g, (word) => {
      const [, lead, token, trail] = /^([("'“‘]*)(.*?)([.,!?;:)"'”’]*)$/.exec(word);
      const masked = /\d/.test(token) ? !PLAIN_NUMBER_RE.test(token) : (!loud && CAPS_CODE_RE.test(token));
      return masked ? `${lead}[redacted]${trail}` : word;
    });
  }).join(' ');
}

// A customer can split a credential over two texts ("gate code is" / "four
// five four five"): a text sent within this long after an access-bearing one
// is withheld with it.
const ACCESS_FOLLOW_UP_MS = 15 * 60 * 1000;
// And a reply to a Waves text that asked about access can come much later:
// every customer text within this long after such a Waves text is withheld.
const ACCESS_REPLY_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_MARKER = '[follow-up to an access detail withheld]';

function dayString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const { etCalendarDayOf } = require('../../utils/datetime-et');
    return etCalendarDayOf(value);
  }
  return String(value).slice(0, 10);
}

// The instant the visit starts (its window start, else 08:00 Eastern on its
// date). Texts after it are never part of the state.
function stateCutoff(svc) {
  const { parseETDateTime } = require('../../utils/datetime-et');
  const day = dayString(svc.scheduled_date);
  const start = /^\d{2}:\d{2}/.test(String(svc.window_start || '')) ? String(svc.window_start).slice(0, 5) : DEFAULT_START;
  return parseETDateTime(`${day}T${start}`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function visitAccessSubjectHash(state) {
  return crypto.createHash('sha256').update(canonical(state)).digest('hex');
}

function labelled(label, value, max) {
  const text = compact(redactForState(value), max);
  return text ? `${label}: ${text}` : null;
}

// A field whose whole purpose is how to get in (access notes, the side gate
// field): any word in it can be the credential ("sesame"), so it never leaves
// as written, whatever it says. Only its marker does.
function labelledAccessField(label, value) {
  return String(value || '').trim() ? `${label}: ${accessMarker(String(value))}` : null;
}

/**
 * The state one visit is judged on, with the two baselines production holds.
 * Returns null when the visit, its customer or its date cannot be read.
 * Throws on a database error (callers count it as a failed visit).
 *
 * @returns {Promise<null | { state: object, baselines: object, subjectHash: string }>}
 */
async function buildVisitAccessState(svc, dbh) {
  const day = dayString(svc && svc.scheduled_date);
  if (!svc || !svc.id || !svc.customer_id || !day) return null;
  if (require('../stamped-address').stampedAddressDiverges(svc)) return null;
  const { detectServiceLine } = require('../service-report/service-line-configs');
  const { excludeUnresolvedSendReservations } = require('../messaging/review-ask-reservation');
  const { isSmsReaction } = require('../sms-intent');
  const serviceLine = detectServiceLine(svc.service_type) || null;
  const cutoff = stateCutoff(svc);

  const prefs = await dbh('property_preferences').where({ customer_id: svc.customer_id }).first(
    'pet_count', 'pet_details', 'pets_secured_plan', 'contact_preference', 'away_mode_until', 'side_gate_access',
    'neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
    'access_notes', 'parking_notes', 'special_instructions', 'chemical_sensitivities', 'chemical_sensitivity_details',
  ) || null;

  // Completed visits on days BEFORE this one. scheduled_services is the
  // history (a completed recurring visit can have no service_records row, as
  // completion-comms-context reads it): the count, and the newest on this
  // visit's own service line, where the texts' window starts. service_records
  // supplies only the last technician note on that line.
  const completed = await dbh('scheduled_services')
    .where({ customer_id: svc.customer_id, status: 'completed' })
    .whereNot({ id: svc.id })
    .where('scheduled_date', '<', day)
    .orderBy('scheduled_date', 'desc').orderBy('id', 'desc')
    .limit(200)
    .select('service_type', 'scheduled_date');
  const lastCompleted = completed.find((r) => detectServiceLine(r.service_type) === serviceLine) || null;
  const records = await dbh('service_records')
    .where({ customer_id: svc.customer_id, status: 'completed' })
    .where('service_date', '<', day)
    .orderBy('service_date', 'desc').orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(100)
    .select('service_type', 'service_line', 'service_date', 'technician_notes');
  const lastLine = records.find((r) => (String(r.service_line || '').trim() || detectServiceLine(r.service_type)) === serviceLine) || null;

  const capFloor = new Date(cutoff.getTime() - WINDOW_CAP_DAYS * 24 * 60 * 60 * 1000);
  // Eastern midnight of the last same-line visit's day (the later of the two
  // sources), never UTC midnight.
  const lastDay = [lastCompleted && dayString(lastCompleted.scheduled_date), lastLine && dayString(lastLine.service_date)].filter(Boolean).sort().pop() || null;
  const lastLineDay = lastDay ? require('../../utils/datetime-et').parseETDateTime(`${lastDay}T00:00`) : null;
  const floor = lastLineDay && lastLineDay > capFloor ? lastLineDay : capFloor;
  // Both directions are read, but only the customer's own texts enter the
  // state: a Waves text is there solely so a reply to an access question
  // ("What is your gate password?" / "sesame") is withheld with it.
  const texts = await excludeUnresolvedSendReservations(dbh('sms_log').where({ customer_id: svc.customer_id }))
    .whereIn('direction', ['inbound', 'outbound'])
    .where('created_at', '>=', floor)
    .where('created_at', '<', cutoff)
    .orderBy('created_at', 'desc')
    .limit(80)
    .select('created_at', 'direction', 'message_body', 'message_type');
  // Oldest first, so a text that follows an access-bearing one is seen as such.
  let withholdUntil = 0;
  const recentTexts = texts
    .filter((row) => row.message_type !== 'sms_reaction' && !isSmsReaction(row.message_body))
    .reverse()
    .map((row) => {
      const at = new Date(row.created_at).getTime();
      const access = mentionsAccess(row.message_body);
      if (row.direction !== 'inbound') {
        if (access) withholdUntil = Math.max(withholdUntil, at + ACCESS_REPLY_MS);
        return null;
      }
      if (access) { withholdUntil = Math.max(withholdUntil, at + ACCESS_FOLLOW_UP_MS); return redactForState(row.message_body); }
      if (at <= withholdUntil) { withholdUntil = Math.max(withholdUntil, at + ACCESS_FOLLOW_UP_MS); return FOLLOW_UP_MARKER; }
      return compact(redactForState(row.message_body), TEXT_CHARS);
    })
    .filter(Boolean)
    .reverse()
    .slice(0, MAX_TEXTS);

  const hasCodes = Boolean(prefs && (prefs.neighborhood_gate_code || prefs.property_gate_code || prefs.garage_code || prefs.lockbox_code));
  const petCount = Number.isInteger(prefs && prefs.pet_count) ? prefs.pet_count : 0;
  const notes = [
    labelledAccessField('Access notes', prefs && prefs.access_notes),
    labelled('Parking', prefs && prefs.parking_notes, NOTE_CHARS),
    labelled('Special instructions', prefs && prefs.special_instructions, NOTE_CHARS),
    labelled('Pets', prefs && prefs.pet_details, NOTE_CHARS),
    labelled('Pets secured plan', prefs && prefs.pets_secured_plan, NOTE_CHARS),
    labelledAccessField('Side gate', prefs && prefs.side_gate_access),
    prefs && prefs.chemical_sensitivities ? labelled('Chemical sensitivity', prefs.chemical_sensitivity_details || 'yes', NOTE_CHARS) : null,
    labelled('Visit note', svc.notes, NOTE_CHARS),
  ].filter(Boolean).join('\n').slice(0, NOTES_TEXT_CHARS);

  const state = {
    service_line: serviceLine,
    visit_count: completed.length,
    structured: {
      pet_count: petCount,
      has_codes: hasCodes,
      contact_preference: (prefs && prefs.contact_preference) || null,
      away_mode: Boolean(prefs && prefs.away_mode_until && dayString(prefs.away_mode_until) >= day),
      side_gate: Boolean(prefs && String(prefs.side_gate_access || '').trim()),
      chemical_sensitivity: Boolean(prefs && prefs.chemical_sensitivities),
    },
    notes_text: notes || null,
    recent_texts: recentTexts.length ? recentTexts.map((line) => `- ${line}`).join('\n') : null,
    last_tech_notes: lastLine ? (compact(redactForState(lastLine.technician_notes), NOTE_CHARS) || null) : null,
  };
  return {
    state,
    baselines: { dog_on_property: { rules: petCount > 0 }, needs_code_key_or_person: { rules: hasCodes } },
    subjectHash: visitAccessSubjectHash(state),
  };
}

const VISIT_COLUMNS = [
  's.id', 's.customer_id', 's.service_type', 's.scheduled_date', 's.window_start', 's.notes',
  // stampedAddressDiverges' row keys.
  's.service_address_line1', 's.service_address_zip', 's.service_address_city',
  'c.address_line1 as customer_address_line1', 'c.zip as customer_zip', 'c.city as customer_city',
];

// One visit: ask every live provider that has not already answered THIS
// state, then record each answer with the others' answers beside it.
async function shadowVisit(svc, { dbh, providers, out }) {
  const { askPackage } = require('./jev');
  const { recordDecisions, TABLE } = require('./shadow-recorder');
  const { packageFor } = require('./packages');
  const pkg = packageFor(PACKAGE_ID);
  const built = await buildVisitAccessState(svc, dbh);
  if (!built) { out.skipped += 1; return; }

  // A provider is done with this state once it holds a row for every
  // question under the current digest (a labeled or held-out row counts: it
  // is never re-answered).
  const existing = await dbh(TABLE)
    .where({ package_id: pkg.id, subject_type: SUBJECT_TYPE, subject_id: svc.id })
    .select('provider', 'question_id', 'subject_hash', 'label_status', 'sampled_for', 'jev_answer');
  const questionIds = Object.keys(pkg.questions);
  const settled = (row) => row.subject_hash === built.subjectHash || row.label_status !== 'unreviewed' || row.sampled_for === 'heldout';
  const done = (provider) => questionIds.every((id) => existing.some((row) => row.provider === provider && row.question_id === id && settled(row)));
  const due = providers.filter((provider) => !done(provider));
  if (!due.length) { out.unchanged += 1; return; }
  if (out.askedVisits >= MAX_ASKED_VISITS) { out.deferred += 1; return; }
  out.askedVisits += 1;

  const legs = (await Promise.all(due.map(async (provider) => {
    out.asked += 1;
    try {
      const result = provider === 'typesafe' ? await askPackage(PACKAGE_ID, built.state) : await askPackage(PACKAGE_ID, built.state, { provider });
      if (!result || !result.ok) { out.failed += 1; return null; }
      return { provider, answers: result.answers, result };
    } catch (err) {
      out.failed += 1;
      logger.warn(`[typed-decisions] visit access (${provider}) failed: ${err.message}`);
      return null;
    }
  }))).filter(Boolean);

  // Any provider's rows for this exact state are siblings: one that answered
  // on an earlier pass, or one since switched off. Rows for an OLDER state
  // (a switched-off provider's, once the state moved) are not: their answers
  // are about text that no longer stands.
  const asked = new Set(legs.map((leg) => leg.provider));
  const stored = [...new Set(existing.filter((row) => row.subject_hash === built.subjectHash && !asked.has(row.provider)).map((row) => row.provider))]
    .map((provider) => ({
      provider,
      answers: Object.fromEntries(existing
        .filter((row) => row.provider === provider && row.subject_hash === built.subjectHash)
        .map((row) => [row.question_id, typeof row.jev_answer === 'string' ? JSON.parse(row.jev_answer) : row.jev_answer])),
    }));

  for (const leg of legs) {
    try {
      const others = [...legs, ...stored].filter((other) => other.provider !== leg.provider);
      const siblingAnswers = {};
      for (const id of questionIds) {
        const list = others.map((other) => other.answers[id]).filter(Boolean);
        if (list.length) siblingAnswers[id] = list;
      }
      const recorded = await recordDecisions({
        capability: pkg.capability, pkg, provider: leg.provider, subjectType: SUBJECT_TYPE, subjectId: svc.id,
        result: leg.result, baselines: built.baselines, siblingAnswers, subjectHash: built.subjectHash, conn: dbh,
      });
      if (recorded.recorded > 0) out.recorded += 1; else out.failed += 1;
    } catch (err) {
      out.failed += 1;
      logger.warn(`[typed-decisions] visit access (${leg.provider}) record failed: ${err.message}`);
    }
  }

  // The cohort of every row for THIS state is then settled from the answers
  // on record, with the recorder's own rule and draw and no model call. It
  // covers what the recorder's lone-write rule cannot see from here: a stored
  // sibling whose pair just arrived (a retry), and a new answer that would
  // otherwise copy the cohort of a switched-off provider's row for an older
  // state. Unreviewed rows that are not held out only.
  // The answers are re-read: a fresh answer the recorder refused to store (its
  // row is labeled or held out, and keeps its older state) must not count.
  if (legs.length) {
    const { sampleFor, stableDraw } = require('./shadow-recorder');
    let persisted;
    try {
      persisted = await dbh(TABLE)
        .where({ package_id: pkg.id, subject_type: SUBJECT_TYPE, subject_id: svc.id, subject_hash: built.subjectHash })
        .select('id', 'capability', 'package_id', 'provider', 'subject_type', 'subject_id', 'question_id', 'jev_answer', 'label_status', 'sampled_for');
    } catch (err) {
      logger.warn(`[typed-decisions] visit access cohort refresh read failed: ${err.message}`);
      return;
    }
    const parsed = (row) => (typeof row.jev_answer === 'string' ? JSON.parse(row.jev_answer) : row.jev_answer);
    for (const row of persisted) {
      if (row.label_status !== 'unreviewed' || row.sampled_for === 'heldout') continue;
      const others = persisted.filter((other) => other.question_id === row.question_id && other.provider !== row.provider).map(parsed);
      const cohort = sampleFor(parsed(row), built.baselines[row.question_id], () => stableDraw(row), others);
      if (cohort === row.sampled_for) continue;
      try {
        await dbh(TABLE).where({ id: row.id, subject_hash: built.subjectHash, label_status: 'unreviewed' })
          .whereRaw(`sampled_for IS DISTINCT FROM 'heldout'`)
          .update({ sampled_for: cohort });
      } catch (err) {
        logger.warn(`[typed-decisions] visit access (${row.provider}) cohort refresh failed: ${err.message}`);
      }
    }
  }
}

/**
 * Today's and tomorrow's open visits (Eastern), each asked once per state.
 * Gate off returns before any read. Never throws.
 *
 * `deferred` counts visits left for the next pass once MAX_ASKED_VISITS were asked.
 *
 * @returns {Promise<{considered:number, asked:number, recorded:number, unchanged:number, skipped:number, failed:number, deferred:number, skippedReason?:string}>}
 */
async function runVisitAccessSweep({ dbh = null, now = new Date() } = {}) {
  const out = { considered: 0, asked: 0, recorded: 0, unchanged: 0, skipped: 0, failed: 0, deferred: 0, askedVisits: 0 };
  if (!visitAccessShadowLive()) return { ...out, skippedReason: 'gate_off' };
  try {
    const conn = dbh || require('../../models/db');
    const { etDateString, addETDays } = require('../../utils/datetime-et');
    const { isInternalTestCustomerId } = require('../internal-test-customers');
    const { UPCOMING_SERVICE_STATUSES } = require('../visit-context/statuses');
    const days = [etDateString(now), etDateString(addETDays(now, 1))];
    const visits = (await conn('scheduled_services as s')
      .join('customers as c', 's.customer_id', 'c.id')
      .whereNull('c.deleted_at')
      .whereIn('s.scheduled_date', days)
      .whereIn('s.status', UPCOMING_SERVICE_STATUSES)
      .orderBy('s.scheduled_date', 'asc').orderBy('s.id', 'asc')
      .select(VISIT_COLUMNS))
      .filter((svc) => !isInternalTestCustomerId(svc.customer_id));
    out.considered = visits.length;
    const providers = typedDecisionsClefLive() ? ['typesafe', 'cloudflare'] : ['typesafe'];
    const queue = [...visits];
    const worker = async () => {
      for (let svc = queue.shift(); svc; svc = queue.shift()) {
        try {
          await shadowVisit(svc, { dbh: conn, providers, out });
        } catch (err) {
          out.failed += 1;
          logger.warn(`[typed-decisions] visit access failed for ${svc.id}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, worker));
  } catch (err) {
    logger.error(`[typed-decisions] visit access sweep failed: ${err.message}`);
    return { ...out, skippedReason: 'error' };
  }
  return out;
}

// The state as the reviewer reads it (already redacted): what the models saw.
function renderVisitAccessState(state) {
  const s = state.structured || {};
  return [
    `Service line: ${state.service_line || 'unknown'}. Completed visits before this one: ${state.visit_count}.`,
    `On file: pets ${s.pet_count}; codes ${s.has_codes ? 'yes' : 'no'}; contact preference ${s.contact_preference || 'none'}; away mode ${s.away_mode ? 'yes' : 'no'}; side gate noted ${s.side_gate ? 'yes' : 'no'}; chemical sensitivity ${s.chemical_sensitivity ? 'yes' : 'no'}.`,
    `Notes:\n${state.notes_text || '(none)'}`,
    `Customer texts since the last visit on this line:\n${state.recent_texts || '(none)'}`,
    `Last technician note:\n${state.last_tech_notes || '(none)'}`,
  ].join('\n\n');
}

// The live state of a visit for the review route: null when it is gone.
async function liveVisitAccess(scheduledServiceId, dbh) {
  const svc = await dbh('scheduled_services as s').join('customers as c', 's.customer_id', 'c.id').where('s.id', scheduledServiceId).first(VISIT_COLUMNS);
  if (!svc) return null;
  const built = await buildVisitAccessState(svc, dbh);
  if (!built) return null;
  return { text: renderVisitAccessState(built.state), at: dayString(svc.scheduled_date), hash: built.subjectHash };
}

module.exports = {
  runVisitAccessSweep, buildVisitAccessState, liveVisitAccess, renderVisitAccessState, visitAccessSubjectHash,
  redactForState, stateCutoff, PACKAGE_ID, SUBJECT_TYPE,
};
