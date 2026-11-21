// Nightly check: did an out-of-date staff tab miss its reload?
//
// An out-of-date staff tab reloads at its next page move, unless something
// keeps it on its build (client/src/lib/portalReload.js; owner 2026-11-19,
// option A). Each staff page view logs whether the tab's build was out of
// date and what kept it there (admin_usage_events.stale_build and
// reload_hold, written by routes/admin-usage.js). This job reads, once a
// night, the page views since the scheduled time of the run before it, and
// posts one engineering FIX row to the ops digest when out-of-date page
// views show a failed reload:
// - no name: the move was due a reload, or no move was noted for the page
//   (components/PortalUpdate.jsx);
// - 'no-server-heard': the tab had still heard no server as the page view
//   left, so it cannot know it is out of date. The route stores this name of
//   its own (routes/admin-usage.js); 'never-heard', the name a tab sends, is
//   not counted: a row that holds it is older than that rule;
// - 'reloaded': three reloads for the live build came back on the old one;
// - 'reload-missed': the page the tab loaded is the tab's own reload for a
//   newer build, and it came back on the build it left.
// Every other name is a rule the owner chose, and the Reload bar stays. The
// row retires itself on the first clean night (ops-digest-fall-off.js).
//
// Read-only: it writes no business record, texts or emails no customer, and
// calls no paid API. Its only write is the ops digest row (or, when the
// in-app feed is off, one email to the internal ops inbox).

const db = require('../models/db');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');

const OPS_KEY = 'tab-reload-check';
// The job's scheduled time, Eastern (scheduler.js; a test keeps both in step).
const RUN_AT = '23:51';
const HALF_DAY_MS = 12 * 60 * 60 * 1000;
const FAILED_NAMES = ['no-server-heard', 'reloaded', 'reload-missed'];
const OPS_INBOX = 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || OPS_INBOX;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

const CAUSES = {
  none: 'the move was due a reload, or no move was noted for the page (client/src/components/PortalUpdate.jsx)',
  'no-server-heard': 'the tab had still heard no server as the page view left, so it cannot know it is out of date (client/src/lib/portalVersion.js, server/middleware/portal-build-header.js)',
  reloaded: 'three reloads for the live build came back on the old build (client/src/lib/portalReload.js)',
  'reload-missed': "the tab's own reload for a newer build came back on the build it left (client/src/lib/portalReload.js, client/public/sw.js)",
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Where a run's read starts: the scheduled time of the run before it, in
// Eastern time. From one run to the next is 23, 24 or 25 hours (the clocks
// change), so a fixed 24 hours would skip the hour after the last run on the
// night the clocks go back. It is the latest scheduled time at least half a
// day old (a run starts a moment after its own): the scheduled time on the
// Eastern day of the moment half a day ago, or the one a day before it.
function windowStart(now = new Date()) {
  const halfDayAgo = new Date(now.getTime() - HALF_DAY_MS);
  const scheduledOn = (day) => parseETDateTime(`${etDateString(day)}T${RUN_AT}`);
  const sameDay = scheduledOn(halfDayAgo);
  return sameDay.getTime() <= halfDayAgo.getTime() ? sameDay : scheduledOn(addETDays(halfDayAgo, -1));
}

// Out-of-date staff page views since the run before this one whose name
// shows a failed reload, counted for each name, page and staff member.
function readMissedReloads({ now = new Date(), knex = db } = {}) {
  return knex('admin_usage_events')
    .where('created_at', '>=', windowStart(now))
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
  const lead = `Since the nightly check before this one, ${views} staff page view${s} by ${who} ran an out-of-date portal build that should have reloaded.`;
  const causeLine = ([name, n]) => `${name === 'none' ? 'no name' : name} (${n}): ${CAUSES[name]}`;
  const pageLine = ([page, n]) => `${page}: ${n}`;
  const source = 'Rows: admin_usage_events with stale_build true (routes/admin-usage.js).';
  return {
    subject: `FIX: ${views} staff page view${s} missed a reload to the live portal build`,
    headline: 'System — fix the reload of out-of-date staff tabs',
    summary: `${views} staff page view${s} since the last check ran an out-of-date build that should have reloaded.`,
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
      return mailer.sendOne({
        to: OPS_INBOX,
        fromEmail: fromEmail(),
        fromName: FROM_NAME,
        subject: composed.subject,
        html: composed.html,
        text: composed.text,
        categories: ['ops', OPS_KEY],
        suppressErrorLog: true,
      });
    },
  });
}

/**
 * One nightly run. When the read throws, this throws too, so runExclusive
 * records a failed run and the standing row stays: a check that did not run
 * proves nothing. Returns { views, delivery? }.
 */
async function runTabReloadCheck({ readRows = readMissedReloads, mailer = sendgrid, now = new Date() } = {}) {
  const found = summarize(await readRows({ now }));
  if (!found.views) {
    await retireIfClean(OPS_KEY);
    return { views: 0 };
  }
  logger.warn(`[tab-reload-check] ${found.views} out-of-date staff page view(s) missed a reload`);
  const delivery = await postDigest(found, mailer);
  return { views: found.views, delivery };
}

module.exports = {
  runTabReloadCheck,
  readMissedReloads,
  windowStart,
  OPS_KEY,
  RUN_AT,
  FAILED_NAMES,
  _private: { summarize, composeDigest },
};
