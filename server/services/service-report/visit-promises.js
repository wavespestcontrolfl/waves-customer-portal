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
const crypto = require('crypto');
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
// The ledger's own cap on a promise's wording: the card shows the whole
// promise the tech closes, never a cut (Codex #5516).
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_HUMAN_NOTE_CHARS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[0-9a-f]{16}$/;

function cleanText(value, max = Infinity) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

// The version of the promise the technician saw: its wording and the
// office's last verdict on it (reviewed_at, stamped by every Mark done,
// Dismiss, Reopen, Confirm or Edit). A mark counts only while the promise
// still stands as the technician saw it: an office edit, or a close and
// Reopen that renews the obligation in the same words, drops it (Codex
// #5516). Not updated_at: automatic refreshes touch rows without changing
// what was promised.
function promiseVersion(description, reviewedAt = null) {
  return crypto.createHash('sha256')
    .update(`${cleanText(description)}\u0000${isoOrNull(reviewedAt) || ''}`)
    .digest('hex').slice(0, 16);
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

// Every row a ledger reader returns, page by page. Both readers order
// overdue and oldest first and cap a page at 200, and the text reader counts
// customer and office rows too, so one page could leave out the newest
// promise (Codex #5516). Bounded, so a runaway ledger cannot stall the card.
const LEDGER_PAGE = 200;
const LEDGER_MAX_PAGES = 10;
async function allLedgerPages(read) {
  const rows = [];
  for (let page = 0; page < LEDGER_MAX_PAGES; page += 1) {
    const batch = await read({ limit: LEDGER_PAGE, offset: page * LEDGER_PAGE });
    rows.push(...batch);
    if (batch.length < LEDGER_PAGE) return rows;
  }
  logger.warn(`[visit-promises] ledger read stopped at ${rows.length} rows`);
  return rows;
}

// Every open promise of a kind a technician keeps, newest first. Each
// source joins only while its own ledger is on, so a promise listed here is
// one the office could settle too.
async function openVisitPromises(conn, { customerId }) {
  if (!customerId) return [];
  const rows = [];
  if (isEnabled('callCommitments')) {
    const { listOpenCommitments } = require('../call-commitments');
    const callRows = await allLedgerPages((page) => listOpenCommitments(conn, {
      party: 'waves', kinds: VISIT_PROMISE_KINDS, customerId, prepare: false, ...page,
    }));
    for (const row of callRows) {
      rows.push({ id: row.id, description: row.description, source: 'call', madeAt: row.call_started_at || row.created_at });
    }
  }
  const { smsCommitmentsEnabled, listSmsCommitments } = require('../sms-operational-actions');
  const smsLedger = smsCommitmentsEnabled();
  const emailLedger = gateEnvValue('GATE_EMAIL_OPERATIONAL_ACTIONS');
  if (smsLedger || emailLedger) {
    const textRows = await allLedgerPages((page) => listSmsCommitments(conn, { customerId, ...page }));
    for (const row of textRows) {
      if (row.party !== 'waves' || !VISIT_PROMISE_KINDS.includes(row.kind)) continue;
      const email = row.channel === 'email';
      if (email ? !emailLedger : !smsLedger) continue;
      rows.push({ id: row.id, description: row.description, source: email ? 'email' : 'text', madeAt: row.sms_started_at });
    }
  }
  // The office's last verdict on each, for its version (the text ledger's
  // listing does not carry it).
  const ids = rows.map((row) => row.id).filter(Boolean);
  const reviewedAt = new Map(ids.length
    ? (await conn('call_commitments').whereIn('id', ids).select('id', 'reviewed_at'))
      .map((row) => [String(row.id), row.reviewed_at])
    : []);
  return rows
    .map((row) => ({
      ...row,
      description: cleanText(row.description, MAX_DESCRIPTION_CHARS),
      version: promiseVersion(row.description, reviewedAt.get(String(row.id))),
      madeAt: isoOrNull(row.madeAt),
    }))
    .filter((row) => row.id && row.description)
    .sort((a, b) => (Date.parse(b.madeAt || 0) || 0) - (Date.parse(a.madeAt || 0) || 0));
}

// The card's list, newest first: { promises: [{ id, description, source:
// call|text|email, madeAt, version }], total } (total counts every open
// visit promise, so the card can say when older ones are not shown).
// `include`: older open promises a restored draft had marked, listed after
// the newest ten so the mark is kept and shown (Codex #5516).
async function loadVisitPromises(conn, { customerId, include = [] }) {
  const open = await openVisitPromises(conn, { customerId });
  const wanted = new Set((Array.isArray(include) ? include : [])
    .filter((id) => UUID_RE.test(String(id))).slice(0, MAX_MARKS).map((id) => String(id).toLowerCase()));
  const older = open.slice(MAX_LISTED_PROMISES).filter((row) => wanted.has(String(row.id).toLowerCase()));
  return { promises: [...open.slice(0, MAX_LISTED_PROMISES), ...older], total: open.length };
}

// The request's marks, validated: [{ id, mark, version, stillLeft? }], one
// per id (the last wins); the version is the wording the technician saw.
// Anything else is dropped, never an error: marking is optional and must
// not fail a completion.
function promiseMarksFromBody(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const entry of value.slice(0, MAX_MARKS)) {
    const id = String(entry?.id || '');
    const mark = String(entry?.mark || '');
    const version = String(entry?.version || '').toLowerCase();
    if (!UUID_RE.test(id) || !MARKS.includes(mark) || !VERSION_RE.test(version)) continue;
    const stillLeft = mark === 'partly' ? cleanText(entry?.stillLeft, MAX_STILL_LEFT_CHARS) : '';
    // Partly says what is still left, or it is no mark: the report must say
    // what remains (rule 18) and the office note must carry it (Codex #5516).
    if (mark === 'partly' && !stillLeft) continue;
    byId.set(id.toLowerCase(), { id, mark, version, ...(stillLeft ? { stillLeft } : {}) });
  }
  return [...byId.values()];
}

// Marks for promises still open for this customer and still worded as the
// technician saw them, with each promise's own description and source. A
// mark for anything else (closed or reworded since, another customer's, an
// office kind) is dropped.
// The submitted marks that no longer hold (the promise was closed, reworded
// or moved to another customer since the tech marked it): the report
// written from them may speak to a promise that changed.
async function staleVisitPromiseMarks(conn, { customerId, marks }) {
  const valid = promiseMarksFromBody(marks);
  if (!valid.length) return [];
  const resolved = new Set((await resolveVisitPromiseMarks(conn, { customerId, marks: valid })).map((entry) => String(entry.id).toLowerCase()));
  return valid.filter((entry) => !resolved.has(entry.id.toLowerCase())).map((entry) => entry.id);
}

async function resolveVisitPromiseMarks(conn, { customerId, marks }) {
  const valid = promiseMarksFromBody(marks);
  if (!valid.length || !customerId) return [];
  const open = new Map((await openVisitPromises(conn, { customerId })).map((row) => [String(row.id).toLowerCase(), row]));
  return valid.flatMap((entry) => {
    const promise = open.get(entry.id.toLowerCase());
    return promise && promise.version === entry.version
      ? [{ ...entry, id: promise.id, description: promise.description, source: promise.source }]
      : [];
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

const SOURCE_TABLES = Object.freeze({
  call: ['call_log', 'call_log_id'],
  text: ['sms_log', 'sms_log_id'],
  email: ['emails', 'email_id'],
});

// The promise as it stands under locks, or null when it is no longer this
// customer's open visit promise worded as the technician saw it (dismissed,
// done or reworded by the office meanwhile, or its call, text or email
// moved to another customer). The marks were resolved from an unlocked
// read, so every write re-checks here first. Lock order: the customer,
// then the promise's source row, then the promise: the call relink and
// customer merge order, and applySmsCommitmentUpdate's. `lock: 'update'`
// takes the customer and source rows as that path does, before it runs
// inside the same transaction.
async function lockOwnedOpenPromise(trx, id, { customerId, source, version, lock = 'share' }) {
  const [table, column] = SOURCE_TABLES[source] || [];
  if (!table || !customerId || !version) return null;
  const strength = (query) => (lock === 'update' ? query.forUpdate() : query.forShare());
  const customer = await strength(trx('customers').where({ id: customerId }).whereNull('deleted_at')).first('id');
  const initial = customer && await trx('call_commitments').where({ id }).first(column, 'email_customer_id');
  const sourceId = initial?.[column];
  const sourceRow = sourceId && await strength(trx(table).where({ id: sourceId })).first('customer_id');
  // An email ask follows a merge through emails.customer_id; a staff
  // promise's sent email carries none, so its own email_customer_id does
  // (the rule applySmsCommitmentUpdate applies).
  const owner = sourceRow && (sourceRow.customer_id || (source === 'email' ? initial.email_customer_id : null));
  if (String(owner || '') !== String(customerId)) return null;
  const row = await trx('call_commitments').where({ id }).forUpdate()
    .first('status', 'party', 'kind', 'description', 'human_note', 'reviewed_at', column);
  const unchanged = row?.status === 'open' && row.party === 'waves' && VISIT_PROMISE_KINDS.includes(row.kind)
    && promiseVersion(row.description, row.reviewed_at) === version
    // The promise still points at the source just checked.
    && String(row[column]) === String(sourceId);
  return unchanged ? row : null;
}

// Partly: the promise stays open and carries the technician's note, added
// once (a resumed completion finds it already there).
async function addStillLeftNote(conn, promise, customerId, line) {
  return conn.transaction(async (trx) => {
    const row = await lockOwnedOpenPromise(trx, promise.id, { customerId, source: promise.source, version: promise.version });
    if (!row) return false;
    const current = String(row.human_note || '');
    // Already there (a resumed completion): the mark stands.
    if (current.includes(line)) return true;
    const combined = current ? `${current}\n${line}` : line;
    // The office's own note is never cut to make room: a note too full for
    // the line keeps everything it says and gets no line (Codex #5516).
    if (combined.length > MAX_HUMAN_NOTE_CHARS) return false;
    await trx('call_commitments').where({ id: promise.id }).update({ human_note: combined, updated_at: new Date() });
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
        const doneLine = `Done at ${visit} (marked by the technician).`;
        // The ownership, open and wording checks run under locks in the
        // same transaction as the office's own write: applyHumanUpdate for
        // a call promise; applySmsCommitmentUpdate (its own checks again,
        // on the rows this transaction already holds) for a text or email.
        const applied = await conn.transaction(async (trx) => {
          const locked = await lockOwnedOpenPromise(trx, promise.id, {
            customerId, source: promise.source, version: promise.version,
            lock: promise.source === 'call' ? 'share' : 'update',
          });
          if (!locked) return false;
          // The office's own note stays: the visit's line goes under it when
          // it fits, and a note too full for it is left as it is (Codex
          // #5516).
          const current = String(locked.human_note || '');
          const combined = current ? `${current}\n${doneLine}` : doneLine;
          const note = combined.length <= MAX_HUMAN_NOTE_CHARS ? combined : undefined;
          if (promise.source === 'call') {
            await require('../call-commitments').applyHumanUpdate(trx, promise.id, { action: 'fulfill', note, reviewedBy });
          } else {
            await require('../sms-operational-actions').applySmsCommitmentUpdate(trx, promise.id, {
              customerId, action: 'fulfill', note, reviewedBy,
            });
          }
          return true;
        });
        results.push({ id: promise.id, mark: 'done', applied });
      } else {
        const line = `Partly done at ${visit}. Still left: ${promise.stillLeft || 'not noted'}.`;
        results.push({ id: promise.id, mark: 'partly', applied: await addStillLeftNote(conn, promise, customerId, line) });
      }
    } catch (err) {
      logger.warn(`[visit-promises] mark not applied for promise ${promise.id}: ${err.message}`);
      results.push({ id: promise.id, mark: promise.mark, applied: false });
    }
  }
  return results;
}

// The marks that did not reach the office's list, after the write: a Done
// promise still open, or a Partly one still open without its line. A
// promise closed or moved meanwhile has nothing left open. When the list
// cannot be read, every Done or Partly mark counts, so a failure surfaces
// rather than hides.
async function unsavedVisitPromiseMarks(conn, { customerId, marks, results = null }) {
  const kept = promiseMarksFromBody(marks).filter((entry) => entry.mark !== 'not_yet');
  if (!kept.length) return [];
  const applied = new Set((Array.isArray(results) ? results : [])
    .filter((result) => result.applied === true).map((result) => String(result.id).toLowerCase()));
  let open;
  try {
    open = new Map((await openVisitPromises(conn, { customerId })).map((row) => [String(row.id).toLowerCase(), row]));
  } catch (err) {
    logger.warn(`[visit-promises] promise list unreadable after the marks: ${err.message}`);
    return kept.map((entry) => ({ id: entry.id, mark: entry.mark, stillLeft: entry.stillLeft || null, description: null }));
  }
  return kept.flatMap((entry) => {
    const promise = open.get(entry.id.toLowerCase());
    if (!promise) return [];
    if (entry.mark === 'partly' && applied.has(entry.id.toLowerCase())) return [];
    return [{ id: promise.id, mark: entry.mark, stillLeft: entry.stillLeft || null, description: promise.description }];
  });
}

// The report already went out saying what the technician marked: a mark
// that did not reach the office's list rings one bell to settle it by hand
// (Codex #5516; docs/admin-notifications.md). It opens the customer's own
// promise controls (Customer 360, where call, text and email promises are
// all listed). When a later run (a resumed completion) finds nothing left
// unsaved, it closes its own bell; the relevance sweep clears it once the
// office settles the promises. Never contacts the customer.
async function alertUnsavedVisitPromiseMarks(conn, { customerId, serviceId, visitDate = null, unsaved }) {
  if (!serviceId) return null;
  const dedupeKey = `visit-promise-marks:${serviceId}`;
  if (!Array.isArray(unsaved) || !unsaved.length) {
    if (!require('../../config/feature-gates').alertEpisodesLive()) return null;
    await require('../admin-alert-episodes').closeAdminAlertKeys(conn, [dedupeKey], 'promise_marks_saved', {
      resolution: "The technician's marks reached the promise list",
    });
    return null;
  }
  const { raiseAdminAlert, cutAtWord } = require('../admin-alert-compose');
  const customer = customerId
    ? await conn('customers').where({ id: customerId }).first('first_name', 'last_name').catch(() => null)
    : null;
  const name = cutAtWord([customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'the customer', 40);
  const day = visitDayLabel(visitDate);
  const count = unsaved.length;
  const lines = unsaved.map((entry) => {
    const what = entry.description ? `"${cleanText(redactAccessCodes(entry.description), 200)}"` : 'a promise the list could not show';
    return entry.mark === 'done'
      ? `- ${what}: marked Done, still open.`
      : `- ${what}: marked Partly${entry.stillLeft ? ` (still left: ${cleanText(redactAccessCodes(entry.stillLeft), 200)})` : ''}, the note was not added.`;
  });
  return raiseAdminAlert('alert', {
    area: 'Comms',
    action: count === 1 ? 'update a promise the technician marked' : `update ${count} promises the technician marked`,
    why: `Marked at ${name}'s ${day ? `${day} ` : ''}visit, but the promise list does not show ${count === 1 ? 'it' : 'them'}.`,
    severity: 'needs-you',
    link: customerId ? `/admin/customers?customerId=${encodeURIComponent(customerId)}&tab=comms` : '/admin/communications#tab=owed',
    subject: { type: 'visit', id: serviceId },
    doneWhen: 'promise_fulfilled',
    who: 'person',
  }, {
    dedupeKey,
    bell: true,
    detail: `The visit's report already went out saying what the technician marked. Settle these on the Promises list:\n${lines.join('\n')}`,
    metadata: { customer_id: customerId || null, promise_ids: unsaved.map((entry) => entry.id) },
  });
}

module.exports = {
  VISIT_PROMISE_KINDS,
  MAX_LISTED_PROMISES,
  MAX_STILL_LEFT_CHARS,
  writerScopeContext,
  promiseCheckInScope,
  promiseVersion,
  loadVisitPromises,
  promiseMarksFromBody,
  staleVisitPromiseMarks,
  resolveVisitPromiseMarks,
  writerPromiseLines,
  visitDayLabel,
  applyVisitPromiseMarks,
  unsavedVisitPromiseMarks,
  alertUnsavedVisitPromiseMarks,
};
