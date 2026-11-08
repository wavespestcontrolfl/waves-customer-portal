// Nightly check: did any dashboard alert check fail to run?
//
// computeDashboardAlerts() runs each alert check in its own try/catch. A check
// whose query throws lands in `failures`, and its queue is missing from the
// dashboard until the check runs again (the Action inbox marks itself
// "incomplete" and names the check). This job reads the checks once a night,
// reads again a minute later when something failed, and posts one engineering
// FIX row to the ops digest that lists every check that failed BOTH reads. A
// one-off failure (a dropped connection) never posts. The row retires itself
// on the first clean night (ops-digest-fall-off.js).
//
// Read-only: it writes no business record, texts or emails no customer, and
// calls no paid API. Its only write is the ops digest row (or, when the in-app
// feed is off, one email to the internal ops inbox).

const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const { computeDashboardAlerts } = require('./dashboard-alerts');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');

const OPS_KEY = 'dashboard-check-health';
const CONFIRM_DELAY_MS = 60 * 1000;
const DASHBOARD_LINK = '/admin/dashboard';
const OPS_INBOX = 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || OPS_INBOX;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The ids of the checks that threw, deduped and sorted. A failure names its
// check in `id`; its `alertIds` (the alert ids that check emits) matter to
// dashboard-alerts-cron.js, not to this report.
function failedCheckIds(result) {
  const ids = (result?.failures || []).map((f) => f?.id).filter(Boolean);
  return [...new Set(ids)].sort();
}

function composeDigest(ids) {
  const n = ids.length;
  const checks = `alert check${n === 1 ? '' : 's'}`;
  const missing = n === 1 ? 'its queue is' : 'their queues are';
  const url = `${adminPortalUrl()}${DASHBOARD_LINK}`;
  const cause = 'The cause is in the server log line "[dashboard-alerts] <check id>: <error>" (server/services/dashboard-alerts.js).';
  return {
    subject: `FIX: ${n} dashboard ${checks} failed to run`,
    headline: `System — fix ${n} failing dashboard ${checks}`,
    summary: `${n} dashboard ${checks} threw twice in a row, so ${missing} missing from the dashboard.`,
    text: [
      `${n} dashboard ${checks} threw on two reads a minute apart:`,
      '',
      ...ids.map((id) => `- ${id}`),
      '',
      `Until each check runs again, ${missing} missing from the dashboard and the Action inbox shows "incomplete".`,
      cause,
      '',
      `Dashboard: ${url}`,
    ].join('\n'),
    html: [
      `<p><strong>${n}</strong> dashboard ${checks} threw on two reads a minute apart:</p>`,
      `<ul style="margin:0 0 12px 18px;padding:0;">${ids.map((id) => `<li style="margin:0 0 6px 0;">${esc(id)}</li>`).join('')}</ul>`,
      `<p>Until each check runs again, ${missing} missing from the dashboard and the Action inbox shows "incomplete". ${esc(cause)}</p>`,
      `<p><a href="${esc(url)}">Open the dashboard</a></p>`,
    ].join('\n'),
  };
}

function postDigest(ids, mailer) {
  const composed = composeDigest(ids);
  return deliverOpsDigest({
    fallOff: true, // retired by retireIfClean on the first clean night
    key: OPS_KEY,
    subject: composed.subject,
    headline: composed.headline,
    summary: composed.summary,
    html: composed.html,
    text: composed.text,
    link: DASHBOARD_LINK,
    count: ids.length,
    itemKeys: ids,
    // One standing row while checks keep failing, rewritten when the list
    // changes. No dedupeWindowMs: a retired row drops its dedupeKey, so the
    // next failure opens a new row.
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
 * One nightly run. When the alert read itself throws, this throws too, so
 * runExclusive records a failed run and the standing row stays: a check that
 * did not run proves nothing. Returns { failed, cleared?, delivery? }:
 * `cleared` lists checks that failed the first read only.
 */
async function runDashboardCheckHealth({
  readAlerts = () => computeDashboardAlerts({ fresh: true }),
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  mailer = sendgrid,
} = {}) {
  const firstRead = failedCheckIds(await readAlerts());
  let failed = firstRead;
  if (firstRead.length) {
    await wait(CONFIRM_DELAY_MS);
    const secondRead = new Set(failedCheckIds(await readAlerts()));
    failed = firstRead.filter((id) => secondRead.has(id));
  }
  if (!failed.length) {
    await retireIfClean(OPS_KEY);
    return { failed: [], ...(firstRead.length ? { cleared: firstRead } : {}) };
  }
  logger.warn(`[dashboard-check-health] ${failed.length} check(s) failed both reads: ${failed.join(', ')}`);
  const delivery = await postDigest(failed, mailer);
  return { failed, delivery };
}

module.exports = {
  runDashboardCheckHealth,
  OPS_KEY,
  CONFIRM_DELAY_MS,
  _private: { failedCheckIds, composeDigest },
};
