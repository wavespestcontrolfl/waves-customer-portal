'use strict';

// Customer alerts that fell off the bell with no reply: list 1 of the Monday review bell while
// GATE_MONDAY_FELL_OFF_LINE is on (owner 2026-11-05, "go" on the admin-bell plan, decision D3).
//
// Why: the quiet fall-off (admin-alert-retention.js, GATE_ALERT_QUIET_FALL_OFF) marks a bell row done after 72 hours
// with no new activity, so the old list 1 ("needs-you alerts nobody read for 14+ days") can never fire. A customer who
// wrote or called and was never answered now leaves the bell without anyone seeing it. This list names them once a week.
//
// What counts, read fresh on every run:
//   - A row the quiet rule closed (done_by 'quiet-72h', still done) in the 7 days before the run. A row a person
//     reopened is open again and a row a person or another closer took over has another done_by: neither is here.
//   - A customer contact: a bell row in a customer-contact category (admin-alert-routing.js
//     CUSTOMER_CONTACT_CATEGORIES) or one that declares `contact`/`promise` itself or through its registry type
//     (admin-alert-send-to-claude.js declaredContact). The money categories never fall off, so none is judged here.
//   - Not handled. "Handled" is the relevance sweep's own verdict (admin-alert-relevance.js: classify, loadSubjects,
//     subjectFor, judge), never a second opinion written here. The sweep owns every boundary rule: the ask time a
//     portal reminder keeps (askedAt), a re-rung bell's latest event, a shared phone, an unknown sender's latest text,
//     a person's text, call or email, a live booking, a quote handed over (handedOffWithin, never sent_at). A row with
//     a verdict, `reason` or `would`, is handled and left out, so the list does not depend on the mode of
//     GATE_ALERT_CONTACT_CLOSE (loadSubjects `judgeContact` reads the contact witnesses even when that gate is off).
//     The sweep's other gates are honored: a class whose own gate is off is not judged, so its rows are listed.
//   - When a row cannot be checked it is LISTED and marked unchecked: no class judges it (a missed call, say), the
//     class needs witnesses it could not identify, or the subject load failed. The owner reads the list: an alert
//     shown that was answered costs a glance, one hidden that was not costs a customer.
//   - Internal test customers are left out.
//
// Read only. Sends nothing to a customer, calls no paid API.

const db = require('../models/db');
const logger = require('./logger');
const { QUIET_BY } = require('./admin-alert-retention');
const { cutAtWord } = require('./admin-alert-compose');
const { etDateString } = require('../utils/datetime-et');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
// The runaway bound on rows read; 7 days of quiet closes is a few dozen.
const CANDIDATE_LIMIT = 1000;
// Rows judged per subject load, the sweep's own page size.
const JUDGE_BATCH = 200;
const ENTRY_SHOWN = 15;
const TITLE_CHARS = 60;

const toDate = (value) => {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

function parseMeta(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try { const parsed = JSON.parse(metadata); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

// A customer contact, as the repo already classifies it (see the header).
function isCustomerContact(row, meta) {
  const { CUSTOMER_CONTACT_CATEGORIES } = require('./admin-alert-routing');
  const { declaredContact } = require('./admin-alert-send-to-claude');
  return CUSTOMER_CONTACT_CATEGORIES.has(row.category) || declaredContact(meta);
}

// One warning per run, whatever failed, with the error code only.
function warnOnce(state, what, err) {
  if (state.warned) return;
  state.warned = true;
  logger.warn(`[monday-review] ${what}: ${require('./notification-service').safeErrorSummary(err)}`);
}

// The sweep's verdict on one row: { handled } or { handled: false, unchecked }.
function judgeOne(relevance, row, data, todayET, state) {
  if (!data) return { handled: false, unchecked: true };
  try {
    const cls = relevance.classify(row, { assumeContactLive: true });
    if (!cls) return { handled: false, unchecked: true };
    const subject = relevance.subjectFor(row, data, todayET);
    const verdict = relevance.judge(cls, subject);
    if (verdict.reason || verdict.would) return { handled: true };
    // A class that judges by the contact witnesses, whose witnesses could not be found or read, has judged nothing.
    return { handled: false, unchecked: Boolean(subject.contactUnknown || (cls.contact && !subject.contact)) };
  } catch (err) {
    warnOnce(state, 'a reply check failed; the alert is listed unchecked', err);
    return { handled: false, unchecked: true };
  }
}

// Map of row id -> { handled, unchecked }. A subject load that fails leaves its batch listed, unchecked.
async function judgeRows(rows, database, now) {
  const relevance = require('./admin-alert-relevance');
  const todayET = etDateString(now);
  const state = { warned: false };
  const verdicts = new Map();
  for (let i = 0; i < rows.length; i += JUDGE_BATCH) {
    const batch = rows.slice(i, i + JUDGE_BATCH);
    let data = null;
    try {
      data = await relevance.loadSubjects(batch, database, { judgeContact: true });
    } catch (err) {
      warnOnce(state, 'reply witnesses failed to load; the alerts are listed unchecked', err);
    }
    for (const row of batch) verdicts.set(String(row.id), judgeOne(relevance, row, data, todayET, state));
  }
  return verdicts;
}

/**
 * -> { kind: 'fell-off', count, capped, unchecked, uncheckedCount, entries: [{ name, title, at, unchecked }] } (newest
 * first). `unchecked` is true when any listed alert could not be checked; `uncheckedCount` says how many.
 * `entries` holds every alert found; the Monday text shows the first ENTRY_SHOWN.
 */
async function loadFellOffAlerts({ now = new Date(), database = db, limit = CANDIDATE_LIMIT } = {}) {
  const { customersForAlerts } = require('./admin-alert-customer');
  const { isInternalTestCustomerId } = require('./internal-test-customers');
  const { bellEventAt } = require('./admin-alert-relevance');
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const rows = await database('notifications')
    .where({ recipient_type: 'admin', done_by: QUIET_BY }).whereNotNull('done_at').where('done_at', '>=', since)
    .whereRaw("COALESCE(metadata->>'feed', '') <> 'activity'")
    .whereRaw("COALESCE(metadata->>'claudeQueue', '') = ''")
    .orderByRaw('done_at DESC, id DESC').limit(limit)
    .select('id', 'category', 'title', 'link', 'metadata', 'created_at', 'done_at');
  const capped = rows.length >= limit;
  if (capped) logger.warn(`[monday-review] fell-off scan stopped at ${limit} rows; the count is a floor`);
  const contact = rows.filter((row) => isCustomerContact(row, parseMeta(row.metadata)));
  const named = await customersForAlerts(database, contact);
  const kept = contact.filter((row) => !isInternalTestCustomerId(named.get(String(row.id))?.id));
  const verdicts = await judgeRows(kept, database, now);
  const entries = kept.filter((row) => !verdicts.get(String(row.id)).handled).map((row) => ({
    name: named.get(String(row.id))?.name || '',
    title: String(row.title || '').trim(),
    // The day the customer reached us: the ask time a portal reminder keeps, else the bell's latest event.
    at: bellEventAt(row) || toDate(row.created_at) || now,
    unchecked: verdicts.get(String(row.id)).unchecked === true,
  }));
  entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  const uncheckedCount = entries.filter((e) => e.unchecked).length;
  return { kind: 'fell-off', count: entries.length, capped, unchecked: uncheckedCount > 0, uncheckedCount, entries };
}

// "Jane Doe: SMS from Jane Doe" would say the name twice, so a title that already holds the name stands alone.
function entryLine(entry, shortDate) {
  const title = cutAtWord(entry.title || 'Customer alert', TITLE_CHARS);
  const named = entry.name && !title.toLowerCase().includes(entry.name.toLowerCase());
  return `   - ${named ? `${entry.name}: ` : ''}${title} (${shortDate(entry.at)}${entry.unchecked ? ', reply not checked' : ''})`;
}

module.exports = {
  loadFellOffAlerts,
  entryLine,
  ENTRY_SHOWN,
  WINDOW_DAYS,
  _private: { isCustomerContact, judgeOne, judgeRows },
};
