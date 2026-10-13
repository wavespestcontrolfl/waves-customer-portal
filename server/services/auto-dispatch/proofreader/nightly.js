/**
 * MOVE PROOFREADER — the nightly call.
 *
 * Owner 2026-10-12 ("go with the better agent, and for moves it is unsure of
 * moving forward create admin notifications for these"): before the 04:10 run
 * moves a visit, one model reads the customer record (record.js) and answers
 * allow / hold / unknown (index.js is the judge of that answer).
 *
 *   allow    the move goes ahead, on the slot the model read and no other;
 *   hold     a quoted statement in the record sets when visits happen and
 *            the new slot breaks it: the visit stays, the audit row says so;
 *   unknown  the visit stays and a person is told (the notice below).
 *
 * The check can only stop a move. It runs in pass 2 only, after every free
 * rule and the per-run cap, so a move that would not happen anyway is never
 * paid for. A run asks at most config.proofreaderMaxCalls times; past that a
 * move waits for the next run.
 *
 * THE NOTICE. One per visit and date (dedupe key below), written once: a
 * later run that is still unsure about the same visit writes nothing, a
 * notice a person marked done included. It is raised for an "unknown" a
 * person can settle from the record (the model was unsure, or part of the
 * record could not be read). A failed model call raises nothing: the next
 * run asks again. The lane shares the auto-dispatch ring allowance of 24
 * hours (audit.ringsLeft), soonest date first. A notice closes when its
 * visit leaves the date or is no longer open.
 *
 * Behind GATE_AUTO_DISPATCH_PROOFREADER (config.proofreaderEnabled).
 */
const logger = require('../../logger');
const { toDateStr } = require('../dates');

const KEY_PREFIX = 'auto-dispatch-proofreader:';
const RESOLVED_TITLE = 'Move check alert resolved';

const REASON_CODE = { hold: 'PROOFREADER_HOLD', unknown: 'PROOFREADER_UNSURE', not_asked: 'PROOFREADER_NOT_ASKED' };

// The "unknown" answers a person can settle by reading the record, with the
// sentence the notice gives when there is no quote to show.
const PERSON_SETTLES = {
  model_unsure: 'A note may limit when this visit can happen.',
  hold_without_quote: 'A note may limit when this visit can happen.',
  record_incomplete: 'Part of the customer record could not be read.',
  record_too_long: 'The customer record is too long to check.',
};

const DETAIL_MAX_CHARS = 2000;

const noticeKey = (id, date) => `${KEY_PREFIX}${id}:${date}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;

// The run's own tally and the notices it will raise at its end.
function newRunState() {
  return {
    calls: 0, allowed: 0, held: 0, unsure: 0, notAsked: 0, notices: new Map(),
  };
}

async function technicianNames(conn, ids) {
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (!wanted.length) return new Map();
  const rows = await conn('technicians').whereIn('id', wanted).select('id', 'name');
  return new Map(rows.map((row) => [String(row.id), firstName(row.name)]));
}

// The planned move as prompt.js moveFacts reads it. A grouped stop moves
// whole, so it names every member's service.
async function plannedMove(conn, service, best, record) {
  const names = await technicianNames(conn, [service.technician_id, best.technician_id]);
  const tech = (id) => (id ? names.get(String(id)) || null : null);
  const services = record.serviceTypes || [];
  return {
    serviceType: services.length > 1 ? services.join(' + ') : (services[0] || service.service_type),
    from: {
      date: toDateStr(service.scheduled_date), windowStart: service.window_start, windowEnd: service.window_end, technician: tech(service.technician_id),
    },
    to: {
      date: best.date, windowStart: best.start_time, windowEnd: best.end_time, technician: tech(best.technician_id || service.technician_id),
    },
  };
}

// What the audit row keeps of an answer: ids and codes, never a quote or the
// model's sentence (both can hold customer words).
function auditOf(answer) {
  return {
    verdict: answer.verdict, why: answer.why, entry_id: answer.entry_id || null, model: answer.model || null, prompt_version: answer.prompt_version || null,
  };
}

const DESCRIPTION = {
  hold: 'The move proofreader stopped this move: the customer record sets when visits happen',
  unknown: 'The move proofreader could not clear this move; the visit stays',
  not_asked: 'The move proofreader had no calls left this run; the next run asks',
};

function stopped(kind, answer) {
  return {
    allowed: false, reason_code: REASON_CODE[kind], reason_description: DESCRIPTION[kind], audit: auditOf(answer),
  };
}

async function ask({ service, best }, { conn, proofreader }) {
  try {
    const record = await proofreader.buildCustomerRecord(conn, { customerId: service.customer_id, serviceId: service.id, asOf: new Date() });
    const move = proofreader.moveFacts(await plannedMove(conn, service, best, record));
    const answer = await proofreader.proofreadMove({ move, record });
    const entry = answer.entry_id ? record.entries.find((row) => row.id === answer.entry_id) : null;
    return { answer, move, entry: entry || null };
  } catch (err) {
    // Never allow on an error: the visit stays and the next run asks again.
    logger.warn(`[auto-dispatch] move proofreader failed for ${service.id}: ${err.message}`);
    return { answer: { verdict: 'unknown', why: 'check_failed' }, move: null, entry: null };
  }
}

function collectNotice(state, service, { answer, move, entry }) {
  if (!move || !PERSON_SETTLES[answer.why]) return;
  const date = toDateStr(service.scheduled_date);
  const key = noticeKey(service.id, date);
  if (!date || state.notices.has(key)) return;
  state.notices.set(key, {
    key, id: String(service.id), customer_id: service.customer_id || null, date, why: answer.why, move,
    quote: answer.quote || null, reason: answer.reason || null, entry: entry ? { channel: entry.channel, from: entry.from, at: entry.at } : null,
  });
}

/**
 * Ask about one planned move, right before it is applied.
 * @returns null when the check is off for this run; otherwise
 *   { allowed: true, audit } or { allowed: false, reason_code, reason_description, audit }.
 */
async function checkMove({ service, best, run }, deps = {}) {
  const state = run.proofreader;
  if (!state) return null;
  if (state.calls >= run.config.proofreaderMaxCalls) {
    state.notAsked += 1;
    return stopped('not_asked', { verdict: 'unknown', why: 'call_limit' });
  }
  state.calls += 1;
  const asked = await ask({ service, best }, {
    conn: deps.conn || require('../../../models/db'), proofreader: deps.proofreader || require('./index'),
  });
  const { answer } = asked;
  if (answer.verdict === 'allow') {
    state.allowed += 1;
    return { allowed: true, audit: auditOf(answer) };
  }
  if (answer.verdict === 'hold') {
    state.held += 1;
    return stopped('hold', answer);
  }
  state.unsure += 1;
  collectNotice(state, service, asked);
  return stopped('unknown', answer);
}

// The write options of an approved move: the slot the model read and no
// other. The SLOT_TAKEN fallback would land a slot nobody checked, so a
// checked move has none; a taken slot waits for the next run.
function writeOptions(checked, fallback) {
  return checked ? { alternateCandidates: [] } : fallback;
}

// The approved slot was taken between the check and the write. Nothing
// moved: an ordinary "not tonight", never a failed run.
function approvedSlotTaken(checked, err) {
  return !!(checked && err && err.code === 'SLOT_TAKEN' && !err.movedCount && !(Array.isArray(err.failedMembers) && err.failedMembers.length));
}

const slotWords = (slot, shortDateET) => `${slot.weekday} ${shortDateET(`${slot.date}T12:00:00Z`)}, ${slot.arrival_window}`;

function detailFor(item, { shortDateET, redactedWords }) {
  const lines = [
    `Auto-dispatch wanted to move this ${item.move.service} visit from ${slotWords(item.move.from, shortDateET)} to ${slotWords(item.move.to, shortDateET)}.`,
    'It did not move the visit.',
  ];
  if (item.reason) lines.push(`The check said: ${redactedWords(item.reason)}`);
  if (item.quote) {
    const where = item.entry ? ` (${[item.entry.channel, item.entry.from, item.entry.at].filter(Boolean).join(', ')})` : '';
    lines.push(`From the customer record${where}: “${redactedWords(item.quote)}”`);
  } else {
    lines.push(PERSON_SETTLES[item.why]);
  }
  lines.push('If the move is right, move the visit in dispatch. If not, mark this done and the visit stays.');
  return lines.join('\n').slice(0, DETAIL_MAX_CHARS);
}

function whyFor(item, { shortDateET, redactedWords, whyWithQuote }) {
  const from = shortDateET(`${item.date}T12:00:00Z`);
  const to = shortDateET(`${item.move.to.date}T12:00:00Z`);
  const lead = item.move.from.date === item.move.to.date ? `New time on ${from} held` : `Move from ${from} to ${to} held`;
  if (item.quote) return whyWithQuote({ lead: `${lead}; the record says `, quote: redactedWords(item.quote) });
  return `${lead}: ${PERSON_SETTLES[item.why].replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.`;
}

async function raiseOne(item, { raiseAdminAlert, names, audit }) {
  return raiseAdminAlert('schedule_conflict', {
    area: 'Schedule',
    action: await audit.namedVisitAction(item.customer_id, [(who) => `check a held move of ${who}'s visit`, (who) => `check ${who}'s held move`], 'check a visit move auto-dispatch held'),
    why: whyFor(item, names),
    severity: 'needs-you',
    link: `/admin/dispatch?tab=schedule&date=${item.date}&appointment=${encodeURIComponent(item.id)}`,
    subject: { type: 'visit', id: item.id },
    doneWhen: 'visit_moved_or_done',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: item.key,
    detail: detailFor(item, names),
    metadata: {
      scheduledServiceId: item.id, customerId: item.customer_id, scheduledDate: item.date, kind: item.why, proposedDate: item.move.to.date,
    },
  });
}

// A notice stays open while its visit is still open on the notice's date.
async function closeResolved(audit, nowDate) {
  try {
    await audit.retireResolvedNotices({
      keyPattern: `${KEY_PREFIX}%`,
      stillOpen: (q) => {
        q.whereRaw("s.scheduled_date::text = notifications.metadata->>'scheduledDate'").whereIn('s.status', ['pending', 'confirmed']);
      },
      resolvedTitle: RESOLVED_TITLE,
      resolution: 'The visit moved or is no longer open',
      body: 'This visit moved, was done or is no longer on that date.',
    }, nowDate);
  } catch (err) {
    logger.error(`[auto-dispatch] move-check notice close failed: ${err.message}`);
  }
}

// Run end, in every run (a gate turned off must leave none standing): close
// the notices that no longer apply. Never throws.
async function closeNotices(nowDate = new Date()) {
  await closeResolved(require('../audit'), nowDate);
}

/**
 * Run end, after the needs-a-person lane (a visit in conflict outranks a
 * held move for the shared allowance): raise this run's notices. Returns how
 * many writes rang. Never throws.
 */
async function raiseNotices(state) {
  const audit = require('../audit');
  if (!state || state.notices.size === 0) return 0;
  let rang = 0;
  try {
    const { raiseAdminAlert } = require('../../admin-alert-compose');
    const names = require('../../admin-alert-names');
    let left = await audit.ringsLeft();
    // Soonest date first; an internal test customer's visit takes no slot.
    for (const item of audit.withinRingBudget([...state.notices.values()], new Set(), Infinity, (row) => row.key)) {
      // Allowance spent: the rest wait for the next run, which asks again.
      if (left <= 0) break;
      try {
        // Only a new notice rings and spends a slot; a key that exists is left as it is.
        if (audit.noticeRang(await raiseOne(item, { raiseAdminAlert, names, audit }))) { left -= 1; rang += 1; }
      } catch (err) {
        logger.error(`[auto-dispatch] move-check notice failed for ${item.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[auto-dispatch] move-check notices failed: ${err.message}`);
  }
  return rang;
}

// For the run's log line.
function tallyOf(state) {
  return state ? `${state.calls}/${state.allowed}/${state.held}/${state.unsure}` : 'off';
}

module.exports = {
  KEY_PREFIX, RESOLVED_TITLE, REASON_CODE, noticeKey, newRunState, checkMove, writeOptions, approvedSlotTaken, closeNotices, raiseNotices, tallyOf,
  _internals: { whyFor, detailFor, plannedMove },
};
