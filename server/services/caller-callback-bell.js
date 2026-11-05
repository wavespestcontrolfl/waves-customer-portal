'use strict';

// Caller callback late bell (owner 2026-11-04, option A): "one Leads bell for each caller whose callback is late.
// The callback is late at the time they named, or else 2 business hours after the call. Nothing goes to the caller."
//
// The call agent saves a caller's own promise ("we'll call you right back") as a call_commitments row with
// party 'customer' and kind 'call_back'. Nothing chased it: the one-hour pager reads only Waves promises, the
// promise chaser rings only on an open Waves promise, and lead staleness parks a quiet lead after 21 days.
// Since Sep 21, 7 of 10 new-lead callers who said it went quiet and none booked.
//
// Every 15 minutes in office hours this job:
//   1. CLOSE: every open bell under `caller-callback-late:` is judged again from its promise, call and lead. A bell
//      whose caller has since called or texted, whose lead got a visit or a quote, whose lead is closed, or whose
//      promise was closed (or is gone) closes itself with a one-line resolution.
//   2. RAISE: an open, untouched AI-heard customer call_back promise from an inbound new-lead call (last 30 days,
//      a lead that is still open) whose due time fell in the last 24 hours and that nobody has settled gets ONE
//      Leads bell, raised once ever (no dedupeOpenOnly: a closed bell does not ring again).
//
// Due time: the time the caller named when extraction called it a deadline; otherwise 2 business hours (8 AM to
// 8 PM ET, closed days skipped) after the later of the call's end and a named time (a "floor" such as "after
// lunch" is the earliest the callback can happen, not the deadline).
//
// Settled means one of these happened AFTER the call ended: the caller called us (even if we missed it: the missed
// call and voicemail bells own that follow-up), the caller texted us, followedUpIds holds the promise (a staff call
// that reached them, a person's delivered text, a booked visit), a quote was handed to them, the lead is no longer
// open, or the promise is no longer open. A lookup that throws fails CLOSED for that row (no raise, no close) and
// the run throws at the end, after the other rows, so job_health shows it.
//
// Read-only except admin notifications. Sends nothing to a customer, calls no paid API.
//
// GATE_CALLER_CALLBACK_BELL (strict 'true', read at call time). Off = the cron returns before any read.

const db = require('../models/db');
const logger = require('./logger');
const commitments = require('./call-commitments');
const { followUpDueAt, loadSlaCalendar, followedUpIds } = require('./followup-sla-watcher');
const { resolveLeadLinkage } = require('./call-booking-link-text');
const { isOpenLeadRow } = require('./lead-statuses');
const { isInternalTestCustomerId } = require('./internal-test-customers');
const { realName, fitAction, redactedWords } = require('./admin-alert-names');
const { formatETDayDate, formatETTime } = require('../utils/datetime-et');

const OWN_PREFIX = 'caller-callback-late:';
const AREA = 'Leads';
const DUE_MINUTES = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 30 * DAY_MS;

// What settled a promise: the reason code stored on the closed bell, and the one-line resolution a person reads.
const SETTLED = Object.freeze({
  called: { reason: 'caller_called', text: 'They called back' },
  texted: { reason: 'caller_texted', text: 'They texted us' },
  followedUp: { reason: 'followed_up', text: 'Someone followed up (a call, a text or a booking)' },
  quote: { reason: 'quote_sent', text: 'A quote was sent' },
  leadClosed: { reason: 'lead_closed', text: 'The lead is closed' },
  promiseClosed: { reason: 'promise_closed', text: 'The promise was closed' },
  gone: { reason: 'promise_or_lead_gone', text: 'The promise or lead is gone' },
});

const BASIS_WORDS = Object.freeze({
  named: 'the time they named',
  afterNamed: '2 business hours after the time they named',
  afterCall: '2 business hours after the call',
});

// 'Wed, Nov 4, 7:52 PM' (Eastern); the time format's narrow space becomes a plain one.
const etWhen = (at) => `${formatETDayDate(at)}, ${formatETTime(at)}`.replace(/\s/g, ' ');

// ------------------------------------------------------------- due time (pure)

// When the call ended: callEndedAt, else the row's own creation time.
function baseOf(call) {
  return commitments.callEndedAt(call) || new Date(call.created_at);
}

// { at, basis } for one promise. A time the caller named counts only when it is after the call ended. A named
// DEADLINE is the due time itself; any other named time ('floor', or untyped) is where the 2 business hours start.
function dueOf(promise, base, calendar) {
  const stated = promise.due_at ? new Date(promise.due_at) : null;
  const named = stated && !Number.isNaN(stated.getTime()) && stated > base ? stated : null;
  if (named && promise.due_type === 'deadline') return { at: named, basis: 'named' };
  return { at: followUpDueAt(named || base, calendar, DUE_MINUTES), basis: named ? 'afterNamed' : 'afterCall' };
}

// ---------------------------------------------------------------- copy (pure)

// The bell's spec. `name` is a real name or null; `last4` the caller's number ending, used when no name is known.
function specFor({ name, last4, leadId, callLogId, calledAt }) {
  const who = name || (last4 ? `the caller ending ${last4}` : 'the caller');
  return {
    area: AREA,
    action: fitAction(AREA, who, [(w) => `call ${w} back`, (w) => `call ${w}`]),
    why: `Said on the ${etWhen(calledAt)} call they would call back; no call or text since.`,
    severity: 'needs-you',
    who: 'person',
    link: `/admin/leads?lead=${leadId}`,
    subject: { type: 'lead', id: String(leadId) },
    doneWhen: 'lead_contacted',
    // Call: the Call Log's own "Call back" for the promise's call (alert-call-button.js).
    buttons: require('./alert-call-button').callButtons({ callLogId }),
  };
}

function detailFor({ promise, calledAt, due, lead }) {
  return [
    `They said: "${redactedWords(promise.description)}"`,
    `Said on the ${etWhen(calledAt)} call.`,
    `Callback was due ${etWhen(due.at)} (${BASIS_WORDS[due.basis]}).`,
    lead.service_interest ? `Interested in: ${redactedWords(lead.service_interest)}` : null,
  ].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------- reads

// The untouched AI-heard customer call_back promises from the last 30 days on an inbound new-lead call that is a
// real caller's (not a voice sandbox call, not an internal test customer), or, with `ids`, those exact promises
// whatever their state (the close pass reloads its bells' promises).
async function loadPromises(database, { ids, now }) {
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  return database('call_commitments as cc')
    .modify((q) => {
      if (ids) { q.whereIn('cc.id', ids); return; }
      q.where({ 'cc.party': 'customer', 'cc.kind': 'call_back', 'cc.status': 'open', 'cc.source': 'ai' })
        .whereNull('cc.human_state')
        .where('cc.created_at', '>', new Date(now.getTime() - LOOKBACK_MS))
        .whereExists(function newLeadCall() {
          this.select(database.raw('1')).from('call_log as c').whereRaw('c.id = cc.call_log_id')
            .whereRaw("c.direction LIKE 'inbound%'")
            .whereRaw("c.ai_extraction_enriched->>'call_nature' = 'new_lead'")
            .modify((b) => whereNotSandboxCall(b, 'c.source'));
        });
    })
    .select('cc.id', 'cc.call_log_id', 'cc.party', 'cc.kind', 'cc.status', 'cc.source', 'cc.human_state', 'cc.due_at', 'cc.due_type', 'cc.description');
}

async function loadCalls(database, promises) {
  const rows = await database('call_log')
    .whereIn('id', [...new Set(promises.map((p) => p.call_log_id))])
    .select('id', 'customer_id', 'direction', 'from_phone', 'to_phone', 'created_at', 'duration_seconds', 'bridged_at',
      'twilio_call_sid', 'metadata', database.raw("ai_extraction_enriched->'caller'->>'name_full' AS caller_name_full"));
  return new Map(rows.map((c) => [String(c.id), c]));
}

// The call's lead: the id the bell stored (close pass), else the call's own linkage. Null when there is none.
async function loadLead(database, call, leadId) {
  const id = leadId || (await resolveLeadLinkage(database, call)).leadId;
  if (!id) return null;
  return (await database('leads').where({ id })
    .first('id', 'first_name', 'last_name', 'phone', 'status', 'converted_at', 'deleted_at', 'customer_id', 'service_interest')) || null;
}

// A real name for the bell: the customer's, else the lead's, else the one the call extraction heard.
async function nameFor(database, call, lead) {
  const customerId = call.customer_id || lead.customer_id;
  const customer = customerId ? await database('customers').where({ id: customerId }).first('first_name', 'last_name') : null;
  return realName(customer) || realName(lead) || realName({ name: call.caller_name_full }, 'name', null) || null;
}

// Why this promise needs no bell, as a SETTLED key, or null while it is still owed. Evidence counts only after the
// call ended. A lookup that throws propagates: the caller treats it as unverified.
async function settledBy(database, { promise, call, lead, base }) {
  if (promise.status !== 'open' || promise.human_state) return 'promiseClosed';
  if (lead.deleted_at || !isOpenLeadRow(lead)) return 'leadClosed';
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const customerId = call.customer_id || lead.customer_id || null;
  const phones = [call.from_phone, lead.phone].filter((p) => commitments.phoneDigits(p));
  if (phones.length) {
    const inbound = (table) => database(table).where('created_at', '>', base).whereRaw("direction LIKE 'inbound%'")
      .modify((b) => commitments.phoneWhereAny(b, 'from_phone', phones));
    if (await inbound('call_log').whereNot('id', call.id).modify((b) => whereNotSandboxCall(b)).first('id')) return 'called';
    if (await inbound('sms_log').first('id')) return 'texted';
  }
  const asPromise = {
    id: promise.id, customer_id: customerId, call_log_id: call.id, direction: call.direction, from_phone: call.from_phone,
    to_phone: call.to_phone, party: promise.party, kind: promise.kind, source: promise.source, human_state: promise.human_state,
    due_at: null, due_type: null, call_ended_at: base,
  };
  if ((await followedUpIds(database, [asPromise])).has(promise.id)) return 'followedUp';
  // A quote handed to the customer (the shared "reached the customer" witness, never estimates.sent_at), or one
  // parked on this caller's lead.
  const quote = await commitments.handedOffWithin(database('estimates'), base).where(function ownedByCaller() {
    this.whereRaw("COALESCE(estimate_data ->> 'lead_id', '') = ?", [String(lead.id)]);
    if (customerId) this.orWhere(function customerQuote() { commitments.whereEstimateCustomerOwnership(this, customerId); });
  }).first('id');
  return quote ? 'quote' : null;
}

// ------------------------------------------------------------------ writes

// Raise one bell. Returns 'raised' when a new row rang, else 'unchanged' (a row already exists for this promise).
async function raiseBell(database, { promise, call, lead, base, due }) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const customerId = call.customer_id || lead.customer_id || null;
  const digits = [call.from_phone, lead.phone].map(commitments.phoneDigits).find(Boolean) || '';
  const spec = specFor({
    name: await nameFor(database, call, lead), last4: digits.slice(-4), leadId: lead.id, callLogId: call.id, calledAt: base,
  });
  const result = await raiseAdminAlert('lead', spec, {
    bell: true,
    dedupeKey: `${OWN_PREFIX}${promise.id}`,
    detail: detailFor({ promise, calledAt: base, due, lead }),
    metadata: { leadId: String(lead.id), customerId: customerId && String(customerId), callLogId: String(call.id), commitmentId: String(promise.id), dueAt: due.at.toISOString() },
  });
  if (!result) throw new Error('caller callback bell was not written');
  return result.suppressed || result.deduped ? 'unchanged' : 'raised';
}

// Judge each open bell again; close the settled ones. Returns { closed, failed }.
async function closePass(database, episodes) {
  const bells = (await episodes.openAdminAlertMetadata(database, OWN_PREFIX)).filter((meta) => meta.commitmentId);
  const promises = bells.length ? await loadPromises(database, { ids: [...new Set(bells.map((m) => String(m.commitmentId)))] }) : [];
  const promiseById = new Map(promises.map((p) => [String(p.id), p]));
  const calls = promises.length ? await loadCalls(database, promises) : new Map();
  const tally = { closed: 0, failed: 0 };
  for (const meta of bells) {
    try {
      const promise = promiseById.get(String(meta.commitmentId));
      const call = promise && calls.get(String(promise.call_log_id));
      const lead = call && await loadLead(database, call, meta.leadId);
      const key = lead ? await settledBy(database, { promise, call, lead, base: baseOf(call) }) : 'gone';
      if (key) {
        tally.closed += Number(await episodes.closeAdminAlertKeys(database, [`${OWN_PREFIX}${meta.commitmentId}`], SETTLED[key].reason, { resolution: SETTLED[key].text })) || 0;
      }
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[caller-callback-bell] close check failed for promise ${meta.commitmentId}: ${err.message}`);
    }
  }
  return tally;
}

// Raise one bell for each candidate that fell due in the last 24 hours and is not settled.
async function raisePass(database, now) {
  const found = await loadPromises(database, { now });
  const calls = found.length ? await loadCalls(database, found) : new Map();
  const items = found.map((promise) => ({ promise, call: calls.get(String(promise.call_log_id)) }))
    .filter(({ call }) => call && !isInternalTestCustomerId(call.customer_id))
    .map((item) => ({ ...item, base: baseOf(item.call) }));
  const tally = { raised: 0, failed: 0, candidates: items.length };
  if (!items.length) return tally;
  const calendar = await loadSlaCalendar(database, new Date(Math.min(...items.map((item) => item.base.getTime()))), now);
  for (const item of items) {
    try {
      const due = dueOf(item.promise, item.base, calendar);
      if (!due.at || due.at > now || due.at <= new Date(now.getTime() - DAY_MS)) continue;
      const lead = await loadLead(database, item.call, null);
      if (!lead || isInternalTestCustomerId(lead.customer_id) || await settledBy(database, { ...item, lead })) continue;
      if ((await raiseBell(database, { ...item, lead, due })) === 'raised') tally.raised += 1;
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[caller-callback-bell] bell failed for promise ${item.promise.id}: ${err.message}`);
    }
  }
  return tally;
}

/**
 * Cron entry point (every 15 minutes in office hours). Returns { skipped } when the gate is off (before any read),
 * else { raised, closed, candidates, outcome }. A row that failed is counted and the run throws after finishing the
 * others, so runExclusive records it in job_health. `gateEnabled` and `now` are for tests.
 */
async function runCallerCallbackBell({ now = new Date(), database = db, gateEnabled } = {}) {
  const gates = require('../config/feature-gates');
  if (!(gateEnabled ?? gates.callerCallbackBellLive())) return { skipped: 'disabled' };
  if (!gates.isEnabled('callCommitments')) return { skipped: 'commitments_off' };
  // ALERT_EPISODES off (alertEpisodesLive): this job closes only through admin-alert-episodes, so it stands down
  // rather than raise bells it could never close. A test that mocks feature-gates without the reader keeps the default.
  if (typeof gates.alertEpisodesLive === 'function' && !gates.alertEpisodesLive()) return { skipped: 'episodes_off' };
  const closed = await closePass(database, require('./admin-alert-episodes'));
  const raised = await raisePass(database, now);
  const failed = closed.failed + raised.failed;
  if (failed) throw new Error(`${failed} caller callback bell check${failed === 1 ? '' : 's'} failed`);
  return { raised: raised.raised, closed: closed.closed, candidates: raised.candidates, outcome: raised.raised || closed.closed ? 'changed' : 'clear' };
}

module.exports = {
  runCallerCallbackBell,
  OWN_PREFIX,
  _private: { dueOf, baseOf, specFor, detailFor, settledBy, SETTLED, BASIS_WORDS, LOOKBACK_MS },
};
