/**
 * The promise check at completion (owner "ok yes add these" 2026-10-01 on
 * the promise-check mockup). The open promises Waves made a customer that a
 * technician can keep at a visit, from calls, texts and emails (the same
 * call_commitments ledger the office's promise lists read), are listed on
 * the completion form. The technician marks each one Done, Partly or Not
 * yet, or leaves it blank:
 *   - the report says only what was marked (the writer's PROMISES record);
 *   - Done closes the promise through the office's own Mark done path, with
 *     a note naming the visit;
 *   - Partly keeps it open and adds the technician's "still left" note;
 *   - Not yet, or a blank, changes nothing.
 *
 * Only while GATE_REPORT_WRITER_RULES is live, and only on visits the
 * writer covers (never lawn or tree, shrub & palm, which another lane
 * owns). Marking is never required, never blocks completion, and never
 * contacts the customer.
 */
const logger = require('../logger');
const { isEnabled, gateEnvValue } = require('../../config/feature-gates');
const { writerRulesInScope } = require('./lawn-report-copy-prompt');
const { dateOnlyString } = require('../../utils/datetime-et');
const { redactAccessCodes } = require('../context-aggregator');

// Promises a technician can keep at a visit. Office work (estimates,
// confirmations, callbacks, reports, paperwork, scheduling, reschedule
// links) stays in the office lists.
const VISIT_PROMISE_KINDS = Object.freeze(['technician_follow_up', 'other']);
// The card lists the newest few; marks resolve against every open one.
const MAX_LISTED_PROMISES = 10;
const MARKS = Object.freeze(['done', 'partly', 'not_yet']);
const MAX_MARKS = 50;
const MAX_STILL_LEFT_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_HUMAN_NOTE_CHARS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(value, max = Infinity) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The writer's scope for a visit, from its resolved completion profile: the
// same context the generate route hands writerRulesInScope (identity keys
// only; a failed resolution reads the label, as the route does).
function writerScopeContext(completionProfile, { failed = false } = {}) {
  if (failed) return { requireCanonical: false };
  const { serviceKey = null, findingsType = null } = completionProfile || {};
  return {
    requireCanonical: !(completionProfile?.synthesized === true && !serviceKey),
    serviceKey,
    findingsType,
  };
}

function promiseCheckInScope(serviceType, completionProfile, options = {}) {
  return writerRulesInScope(serviceType, writerScopeContext(completionProfile, options));
}

// Every open promise of a kind a technician keeps, newest first. Each
// source joins only while its own ledger is on, so a promise listed here is
// one the office could settle too.
async function openVisitPromises(conn, { customerId }) {
  if (!customerId) return [];
  const rows = [];
  if (isEnabled('callCommitments')) {
    const { listOpenCommitments } = require('../call-commitments');
    const callRows = await listOpenCommitments(conn, {
      party: 'waves', kinds: VISIT_PROMISE_KINDS, customerId, prepare: false, limit: 200,
    });
    for (const row of callRows) {
      rows.push({ id: row.id, description: row.description, source: 'call', madeAt: row.call_started_at || row.created_at });
    }
  }
  const { smsCommitmentsEnabled, listSmsCommitments } = require('../sms-operational-actions');
  const smsLedger = smsCommitmentsEnabled();
  const emailLedger = gateEnvValue('GATE_EMAIL_OPERATIONAL_ACTIONS');
  if (smsLedger || emailLedger) {
    const textRows = await listSmsCommitments(conn, { customerId, limit: 200 });
    for (const row of textRows) {
      if (row.party !== 'waves' || !VISIT_PROMISE_KINDS.includes(row.kind)) continue;
      const email = row.channel === 'email';
      if (email ? !emailLedger : !smsLedger) continue;
      rows.push({ id: row.id, description: row.description, source: email ? 'email' : 'text', madeAt: row.sms_started_at });
    }
  }
  return rows
    .map((row) => ({ ...row, description: cleanText(row.description, MAX_DESCRIPTION_CHARS), madeAt: isoOrNull(row.madeAt) }))
    .filter((row) => row.id && row.description)
    .sort((a, b) => (Date.parse(b.madeAt || 0) || 0) - (Date.parse(a.madeAt || 0) || 0));
}

// The card's list: { id, description, source: call|text|email, madeAt }.
async function loadVisitPromises(conn, { customerId }) {
  return (await openVisitPromises(conn, { customerId })).slice(0, MAX_LISTED_PROMISES);
}

// The request's marks, validated: [{ id, mark, stillLeft? }], one per id
// (the last wins). Anything else is dropped, never an error: marking is
// optional and must not fail a completion.
function promiseMarksFromBody(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const entry of value.slice(0, MAX_MARKS)) {
    const id = String(entry?.id || '');
    const mark = String(entry?.mark || '');
    if (!UUID_RE.test(id) || !MARKS.includes(mark)) continue;
    const stillLeft = mark === 'partly' ? cleanText(entry?.stillLeft, MAX_STILL_LEFT_CHARS) : '';
    byId.set(id.toLowerCase(), { id, mark, ...(stillLeft ? { stillLeft } : {}) });
  }
  return [...byId.values()];
}

// Marks for promises still open for this customer, with each promise's own
// description and source. A mark for anything else (closed since, another
// customer's, an office kind) is dropped.
async function resolveVisitPromiseMarks(conn, { customerId, marks }) {
  const valid = promiseMarksFromBody(marks);
  if (!valid.length || !customerId) return [];
  const open = new Map((await openVisitPromises(conn, { customerId })).map((row) => [String(row.id).toLowerCase(), row]));
  return valid.flatMap((entry) => {
    const promise = open.get(entry.id.toLowerCase());
    return promise ? [{ ...entry, id: promise.id, description: promise.description, source: promise.source }] : [];
  });
}

const MARK_WORDS = Object.freeze({
  done: 'Done today',
  partly: 'Partly done today',
  not_yet: 'Not done yet',
});

// The writer's PROMISES record (report-writer-records.js). Both texts are
// free text (a promise can name a gate or lockbox code), so they pass the
// same access-code scrubber as every other free-text grounding input.
function writerPromiseLines(resolved) {
  const scrub = (text) => cleanText(redactAccessCodes(text));
  return (Array.isArray(resolved) ? resolved : []).flatMap((promise) => {
    const description = scrub(promise.description);
    if (!description) return [];
    const stillLeftText = promise.mark === 'partly' ? scrub(promise.stillLeft) : '';
    const stillLeft = stillLeftText ? ` (still left: ${stillLeftText})` : '';
    return [`- ${MARK_WORDS[promise.mark]}: ${description}${stillLeft}`];
  });
}

// "October 1", the visit's calendar day (noon UTC, so no zone shifts it).
function visitDayLabel(value) {
  const ymd = dateOnlyString(value);
  if (!ymd) return null;
  const date = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

// Partly: the promise stays open and carries the technician's note, added
// once (a resumed completion finds it already there).
async function addStillLeftNote(conn, id, line) {
  return conn.transaction(async (trx) => {
    const row = await trx('call_commitments').where({ id }).forUpdate().first('status', 'human_note');
    if (!row || row.status !== 'open') return false;
    const current = String(row.human_note || '');
    if (current.includes(line)) return false;
    const combined = current ? `${current}\n${line}` : line;
    await trx('call_commitments').where({ id }).update({
      human_note: combined.length > MAX_HUMAN_NOTE_CHARS ? combined.slice(-MAX_HUMAN_NOTE_CHARS) : combined,
      updated_at: new Date(),
    });
    return true;
  });
}

// Post-commit, best-effort: each mark is applied on its own, and a failure
// is logged and leaves that promise as it was (open). Re-runnable: a Done
// promise is no longer open, and a Partly note is added once.
async function applyVisitPromiseMarks(conn, { customerId, marks, visitDate = null, reviewedBy = null }) {
  const resolved = await resolveVisitPromiseMarks(conn, { customerId, marks });
  const day = visitDayLabel(visitDate);
  const visit = day ? `the ${day} visit` : 'the visit';
  const results = [];
  for (const promise of resolved) {
    if (promise.mark === 'not_yet') continue;
    try {
      if (promise.mark === 'done') {
        const note = `Done at ${visit} (marked by the technician).`;
        if (promise.source === 'call') {
          await require('../call-commitments').applyHumanUpdate(conn, promise.id, { action: 'fulfill', note, reviewedBy });
        } else {
          await require('../sms-operational-actions').applySmsCommitmentUpdate(conn, promise.id, {
            customerId, action: 'fulfill', note, reviewedBy,
          });
        }
        results.push({ id: promise.id, mark: 'done', applied: true });
      } else {
        const line = `Partly done at ${visit}. Still left: ${promise.stillLeft || 'not noted'}.`;
        results.push({ id: promise.id, mark: 'partly', applied: await addStillLeftNote(conn, promise.id, line) });
      }
    } catch (err) {
      logger.warn(`[visit-promises] mark not applied for promise ${promise.id}: ${err.message}`);
      results.push({ id: promise.id, mark: promise.mark, applied: false });
    }
  }
  return results;
}

module.exports = {
  VISIT_PROMISE_KINDS,
  MAX_LISTED_PROMISES,
  MAX_STILL_LEFT_CHARS,
  writerScopeContext,
  promiseCheckInScope,
  loadVisitPromises,
  promiseMarksFromBody,
  resolveVisitPromiseMarks,
  writerPromiseLines,
  visitDayLabel,
  applyVisitPromiseMarks,
};
