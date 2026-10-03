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
 * (`structured.has_codes`), and every free-text field passes
 * redactAccessCodes (which ends with the sensitive-identifier pass) and a
 * mask over every run of three or more digits before it is built
 * (redactForState).
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
const TERMINAL_STATUSES = ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show'];
const MAX_VISITS = 80;
const WORKERS = 2;
const MAX_TEXTS = 8;
const TEXT_CHARS = 260;
const NOTE_CHARS = 600;
const NOTES_TEXT_CHARS = 1500;
// The comms window's recurring cap (completion-comms-context RECURRING_CAP_DAYS).
const WINDOW_CAP_DAYS = 120;
const DEFAULT_START = '08:00';

const compact = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

// Every digit run a code could be (three or more, with any # or * beside it)
// is masked AFTER the keyword-aware passes, so a bare "1234#" in a text never
// reaches a provider. It also masks house numbers, phone numbers and years:
// none of them answers these questions.
const DIGIT_RUN_RE = /[#*]?\d[\d#*-]{1,}\d[#*]?|[#*]\d+|\d+[#*]/g;
function redactForState(text) {
  // redactAccessCodes ends with the sensitive-identifier pass (SSN, card, CVV).
  const { redactAccessCodes } = require('../context-aggregator');
  const passed = redactAccessCodes(String(text || ''));
  return passed.replace(DIGIT_RUN_RE, (run) => (run.replace(/\D/g, '').length >= 3 || /[#*]/.test(run) ? '[redacted]' : run));
}

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
  const { detectServiceLine } = require('../service-report/service-line-configs');
  const { excludeUnresolvedSendReservations } = require('../messaging/review-ask-reservation');
  const { isSmsReaction } = require('../sms-intent');
  const serviceLine = detectServiceLine(svc.service_type) || null;
  const cutoff = stateCutoff(svc);

  const prefs = await dbh('property_preferences').where({ customer_id: svc.customer_id }).first(
    'pet_count', 'pet_details', 'pets_secured_plan', 'contact_preference', 'away_mode_until', 'side_gate_access',
    'neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
    'access_notes', 'parking_notes', 'special_instructions',
  ) || null;

  // Completed visits on days BEFORE this one: the count, and the newest on
  // this visit's own service line (its technician note, and the texts' floor).
  const history = await dbh('service_records')
    .where({ customer_id: svc.customer_id, status: 'completed' })
    .where('service_date', '<', day)
    .orderBy('service_date', 'desc').orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(100)
    .select('service_type', 'service_line', 'service_date', 'technician_notes');
  const lastLine = history.find((r) => (String(r.service_line || '').trim() || detectServiceLine(r.service_type)) === serviceLine) || null;

  const capFloor = new Date(cutoff.getTime() - WINDOW_CAP_DAYS * 24 * 60 * 60 * 1000);
  const lastLineDay = lastLine ? new Date(`${dayString(lastLine.service_date)}T00:00:00Z`) : null;
  const floor = lastLineDay && lastLineDay > capFloor ? lastLineDay : capFloor;
  const texts = await excludeUnresolvedSendReservations(dbh('sms_log').where({ customer_id: svc.customer_id }))
    .where('direction', 'inbound')
    .where('created_at', '>=', floor)
    .where('created_at', '<', cutoff)
    .orderBy('created_at', 'desc')
    .limit(24)
    .select('created_at', 'message_body', 'message_type');
  const recentTexts = texts
    .filter((row) => row.message_type !== 'sms_reaction' && !isSmsReaction(row.message_body))
    .map((row) => compact(redactForState(row.message_body), TEXT_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TEXTS);

  const hasCodes = Boolean(prefs && (prefs.neighborhood_gate_code || prefs.property_gate_code || prefs.garage_code || prefs.lockbox_code));
  const petCount = Number.isInteger(prefs && prefs.pet_count) ? prefs.pet_count : 0;
  const notes = [
    labelled('Access notes', prefs && prefs.access_notes, NOTE_CHARS),
    labelled('Parking', prefs && prefs.parking_notes, NOTE_CHARS),
    labelled('Special instructions', prefs && prefs.special_instructions, NOTE_CHARS),
    labelled('Pets', prefs && prefs.pet_details, NOTE_CHARS),
    labelled('Pets secured plan', prefs && prefs.pets_secured_plan, NOTE_CHARS),
    labelled('Side gate', prefs && prefs.side_gate_access, 200),
    labelled('Visit note', svc.notes, NOTE_CHARS),
  ].filter(Boolean).join('\n').slice(0, NOTES_TEXT_CHARS);

  const state = {
    service_line: serviceLine,
    visit_count: history.length,
    structured: {
      pet_count: petCount,
      has_codes: hasCodes,
      contact_preference: (prefs && prefs.contact_preference) || null,
      away_mode: Boolean(prefs && prefs.away_mode_until && dayString(prefs.away_mode_until) >= day),
      side_gate: Boolean(prefs && String(prefs.side_gate_access || '').trim()),
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

const VISIT_COLUMNS = ['s.id', 's.customer_id', 's.service_type', 's.scheduled_date', 's.window_start', 's.notes'];

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

  // A provider that already answered this exact state is still a sibling:
  // its stored answers ride beside the new leg's, so the pair's cohort is
  // decided on both.
  const stored = providers.filter((provider) => !due.includes(provider)).map((provider) => ({
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

  // A retried leg's rows were written with the stored sibling's answers beside
  // them; the stored sibling's own rows must land in the same cohort, or a
  // case where the two differ would queue one side only. No model call: the
  // cohort is recomputed from the answers on record, with the recorder's own
  // rule and draw, onto unreviewed rows that are not held out.
  if (legs.length && stored.length) {
    const { sampleFor, stableDraw } = require('./shadow-recorder');
    for (const sibling of stored) {
      for (const id of questionIds) {
        const answer = sibling.answers[id];
        if (!answer) continue;
        const key = { capability: pkg.capability, package_id: pkg.id, provider: sibling.provider, subject_type: SUBJECT_TYPE, subject_id: svc.id, question_id: id };
        const others = legs.map((leg) => leg.answers[id]).filter(Boolean);
        const cohort = sampleFor(answer, built.baselines[id], () => stableDraw(key), others);
        try {
          await dbh(TABLE).where(key).where({ subject_hash: built.subjectHash, label_status: 'unreviewed' })
            .whereRaw(`sampled_for IS DISTINCT FROM 'heldout'`)
            .update({ sampled_for: cohort });
        } catch (err) {
          logger.warn(`[typed-decisions] visit access (${sibling.provider}) cohort refresh failed: ${err.message}`);
        }
      }
    }
  }
}

/**
 * Today's and tomorrow's open visits (Eastern), each asked once per state.
 * Gate off returns before any read. Never throws.
 *
 * @returns {Promise<{considered:number, asked:number, recorded:number, unchanged:number, skipped:number, failed:number, skippedReason?:string}>}
 */
async function runVisitAccessSweep({ dbh = null, now = new Date() } = {}) {
  const out = { considered: 0, asked: 0, recorded: 0, unchanged: 0, skipped: 0, failed: 0 };
  if (!visitAccessShadowLive()) return { ...out, skippedReason: 'gate_off' };
  try {
    const conn = dbh || require('../../models/db');
    const { etDateString, addETDays } = require('../../utils/datetime-et');
    const { isInternalTestCustomerId } = require('../internal-test-customers');
    const days = [etDateString(now), etDateString(addETDays(now, 1))];
    const visits = (await conn('scheduled_services as s')
      .join('customers as c', 's.customer_id', 'c.id')
      .whereNull('c.deleted_at')
      .whereIn('s.scheduled_date', days)
      .whereNotIn('s.status', TERMINAL_STATUSES)
      .orderBy('s.scheduled_date', 'asc').orderBy('s.id', 'asc')
      .limit(MAX_VISITS)
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
    `On file: pets ${s.pet_count}; codes ${s.has_codes ? 'yes' : 'no'}; contact preference ${s.contact_preference || 'none'}; away mode ${s.away_mode ? 'yes' : 'no'}; side gate noted ${s.side_gate ? 'yes' : 'no'}.`,
    `Notes:\n${state.notes_text || '(none)'}`,
    `Customer texts since the last visit on this line:\n${state.recent_texts || '(none)'}`,
    `Last technician note:\n${state.last_tech_notes || '(none)'}`,
  ].join('\n\n');
}

// The live state of a visit for the review route: null when it is gone.
async function liveVisitAccess(scheduledServiceId, dbh) {
  const svc = await dbh('scheduled_services as s').where('s.id', scheduledServiceId).first(VISIT_COLUMNS);
  if (!svc) return null;
  const built = await buildVisitAccessState(svc, dbh);
  if (!built) return null;
  return { text: renderVisitAccessState(built.state), at: dayString(svc.scheduled_date), hash: built.subjectHash };
}

module.exports = {
  runVisitAccessSweep, buildVisitAccessState, liveVisitAccess, renderVisitAccessState, visitAccessSubjectHash,
  redactForState, stateCutoff, PACKAGE_ID, SUBJECT_TYPE,
};
