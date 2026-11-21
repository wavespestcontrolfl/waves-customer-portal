// Nightly check: did an out-of-date staff tab miss its reload?
//
// An out-of-date staff tab reloads at its next page move, unless something
// keeps it on its build (client/src/lib/portalReload.js; owner 2026-11-19,
// option A). Each staff page view logs whether the tab's build was out of
// date and what kept it there (admin_usage_events.stale_build and
// reload_hold, written by routes/admin-usage.js). This job reads, once a
// night, the page views it has not read yet, up to one minute before its
// scheduled time, and posts one engineering FIX row to the ops digest when
// out-of-date page views show a failed reload:
// - no name: the move was due a reload, or no move was noted for the page
//   (components/PortalUpdate.jsx);
// - 'reloaded': three reloads for the live build came back on the old one;
// - 'reload-missed': the page the tab loaded is the tab's own reload for a
//   newer build, and it came back on the build it left.
// Every other name is a rule the owner chose, and the Reload bar stays; or
// it is 'current' or 'never-heard': the tab knew no newer build at its move.
// A healthy tab sends 'never-heard' for a move made before its first server
// answer, so one such view proves no failure, and it is not counted. The row
// retires itself on the first clean run (ops-digest-fall-off.js).
//
// Read-only for the business: it writes no business record, texts or emails
// no customer, and calls no paid API. Its writes are the ops digest row (or,
// when the in-app feed is off, one email to the internal ops inbox) and its
// own mark of how far it has read (system_settings).

const db = require('../models/db');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');

const OPS_KEY = 'tab-reload-check';
// The edge of a read, Eastern: one minute before the job's scheduled time,
// 11:51 PM. A page view takes its time from the database as its insert
// starts. After that minute a view of before the edge is in the table, also
// when that clock is a little behind this one.
const EDGE_AT = '23:50';
const FAILED_NAMES = ['reloaded', 'reload-missed'];
// How far a finished run has read (system_settings), and the most a run goes
// back for runs that did not finish.
const MARK_KEY = 'tab_reload_check.read_to';
const MAX_NIGHTS = 7;
const OPS_INBOX = 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || OPS_INBOX;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

const CAUSES = {
  none: 'the move was due a reload, or no move was noted for the page (client/src/components/PortalUpdate.jsx)',
  reloaded: 'three reloads for the live build came back on the old build (client/src/lib/portalReload.js)',
  'reload-missed': "the tab's own reload for a newer build came back on the build it left (client/src/lib/portalReload.js, client/public/sw.js)",
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// What a run reads: from where the last finished run read to (`readTo`, its
// mark) up to the latest edge that has come (`end`, not included), in
// Eastern time. So each page view is read by one finished run: a night whose
// run failed is read by the next run, a run by hand included, and nothing is
// read twice. With no mark the read starts one edge back: 23, 24 or 25 hours
// (the clocks change), never a fixed 24. It never starts more than
// MAX_NIGHTS back. `start` equals `end` when a finished run has read this
// far already.
function readWindow(now = new Date(), readTo = null) {
  const edgeOn = (day) => parseETDateTime(`${etDateString(day)}T${EDGE_AT}`);
  const today = edgeOn(now);
  const end = today.getTime() <= now.getTime() ? today : edgeOn(addETDays(now, -1));
  const from = readTo || edgeOn(addETDays(end, -1));
  const oldest = edgeOn(addETDays(end, -MAX_NIGHTS));
  return { start: new Date(Math.max(Math.min(from.getTime(), end.getTime()), oldest.getTime())), end };
}

// The mark: the `end` of the last window a run finished. An unreadable value
// reads as no mark.
const marks = {
  async get(knex = db) {
    const row = await knex('system_settings').where({ key: MARK_KEY }).first('value');
    const at = new Date(row && typeof row.value === 'string' ? row.value : NaN);
    return Number.isFinite(at.getTime()) ? at : null;
  },
  async set(at, knex = db) {
    const value = at.toISOString();
    await knex('system_settings').insert({ key: MARK_KEY, value, category: 'tab_reload_check' })
      .onConflict('key').merge({ value, updated_at: new Date() });
  },
};

// Out-of-date staff page views of a window whose name shows a failed
// reload, counted for each name, page and staff member.
function readMissedReloads({ start, end, knex = db }) {
  return knex('admin_usage_events')
    .where('created_at', '>=', start)
    .where('created_at', '<', end)
    .where('stale_build', true)
    .where((q) => q.whereNull('reload_hold').orWhereIn('reload_hold', FAILED_NAMES))
    .select('reload_hold', 'page_key', 'technician_id')
    .count({ views: '*' })
    .groupBy('reload_hold', 'page_key', 'technician_id');
}

// Totals for each name and page, most first, then by name.
function summarize(rows) {
  const names = new Map();
  const pages = new Map();
  const people = new Set();
  let views = 0;
  for (const row of rows) {
    const n = Number(row.views) || 0;
    const name = row.reload_hold || 'none';
    views += n;
    names.set(name, (names.get(name) || 0) + n);
    pages.set(row.page_key, (pages.get(row.page_key) || 0) + n);
    people.add(row.technician_id);
  }
  const ranked = (map) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { views, people: people.size, names: ranked(names), pages: ranked(pages) };
}

function composeDigest({ views, people, names, pages }) {
  const s = views === 1 ? '' : 's';
  const who = `${people} staff member${people === 1 ? '' : 's'}`;
  const lead = `Since the last check that finished, ${views} staff page view${s} by ${who} ran an out-of-date portal build that should have reloaded.`;
  const causeLine = ([name, n]) => `${name === 'none' ? 'no name' : name} (${n}): ${CAUSES[name]}`;
  const pageLine = ([page, n]) => `${page}: ${n}`;
  const source = 'Rows: admin_usage_events with stale_build true (routes/admin-usage.js).';
  return {
    subject: `FIX: ${views} staff page view${s} missed a reload to the live portal build`,
    headline: 'System — fix the reload of out-of-date staff tabs',
    summary: `${views} staff page view${s} since the last finished check ran an out-of-date build that should have reloaded.`,
    text: [lead, '', 'By cause:', ...names.map((e) => `- ${causeLine(e)}`), '', 'By page:', ...pages.map((e) => `- ${pageLine(e)}`), '', source].join('\n'),
    html: [
      `<p>${esc(lead)}</p>`,
      `<p>By cause:</p><ul style="margin:0 0 12px 18px;padding:0;">${names.map((e) => `<li style="margin:0 0 6px 0;">${esc(causeLine(e))}</li>`).join('')}</ul>`,
      `<p>By page:</p><ul style="margin:0 0 12px 18px;padding:0;">${pages.map((e) => `<li style="margin:0 0 6px 0;">${esc(pageLine(e))}</li>`).join('')}</ul>`,
      `<p>${esc(source)}</p>`,
    ].join('\n'),
  };
}

function postDigest(found, mailer) {
  const composed = composeDigest(found);
  return deliverOpsDigest({
    fallOff: true, // retired by retireIfClean on the first clean night
    key: OPS_KEY,
    subject: composed.subject,
    headline: composed.headline,
    summary: composed.summary,
    html: composed.html,
    text: composed.text,
    count: found.views,
    itemKeys: found.names.map(([name]) => name),
    // One standing row while reloads keep failing, rewritten when it changes.
    dedupeKey: OPS_KEY,
    refreshOnDedupe: true,
    // Fallback only: the in-app feed is off, or the row write failed.
    sendEmail: async () => {
      if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
        throw new Error('mailer not configured');
      }
      try {
        return await mailer.sendOne({
          to: OPS_INBOX,
          fromEmail: fromEmail(),
          fromName: FROM_NAME,
          subject: composed.subject,
          html: composed.html,
          text: composed.text,
          categories: ['ops', OPS_KEY],
          suppressErrorLog: true,
        });
      } catch (err) {
        // The provider's answer can quote an email address, and this error
        // goes to job_health and the log: keep the status only.
        throw new Error(`the email to the ops inbox failed (status ${Number(err?.status) || 'unknown'})`);
      }
    },
  });
}

/**
 * One run. When the read throws, this throws too, so runExclusive records a
 * failed run and the standing row stays: a check that did not run proves
 * nothing. The mark moves only once the window is handled: the row retired,
 * or the finding delivered. Returns { views, delivery?, upToDate? }.
 */
async function runTabReloadCheck({ readRows = readMissedReloads, mailer = sendgrid, now = new Date(), markStore = marks } = {}) {
  const { start, end } = readWindow(now, await markStore.get());
  // A finished run has read up to this edge: nothing to add, and no reason
  // to retire the row it left.
  if (start.getTime() >= end.getTime()) return { views: 0, upToDate: true };
  const found = summarize(await readRows({ start, end }));
  if (!found.views) {
    await retireIfClean(OPS_KEY);
    await markStore.set(end);
    return { views: 0 };
  }
  logger.warn(`[tab-reload-check] ${found.views} out-of-date staff page view(s) missed a reload`);
  const delivery = await postDigest(found, mailer);
  if (!delivery || delivery.ok !== false) await markStore.set(end);
  return { views: found.views, delivery };
}

module.exports = {
  runTabReloadCheck,
  readMissedReloads,
  readWindow,
  marks,
  OPS_KEY,
  EDGE_AT,
  FAILED_NAMES,
  _private: { summarize, composeDigest },
};
