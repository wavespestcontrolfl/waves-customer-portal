/**
 * Gmail check for the newsletters (owner 2026-11-22, "gmail").
 *
 * Gmail sends SendGrid no spam reports, so the spam-report stop (newsletter-sender.js
 * spamReportCounts, read by pest-insider/schedule.js) cannot see an issue that Gmail filed as
 * spam. What does show it is who opened: a message in Gmail's Spam folder loads no images, so it
 * records no open. For one issue this check compares the share of delivered copies that Gmail
 * readers opened with the share that all other readers opened (newsletter-sender.js
 * gmailOpenCounts: opens by a person only), and raises one admin alert when Gmail is far behind.
 *
 * Far behind is both of these:
 *   1. Gmail's open rate is under half of the other readers' rate.
 *   2. Chance does not explain it: if Gmail readers opened at the other readers' rate, this few
 *      Gmail opens would happen less than 1 time in 100 (CHANCE_LIMIT, a binomial tail). Without
 *      this, a small issue with few opens would raise an alert on a difference of two readers.
 * With fewer than MIN_COPIES delivered copies in either group there is no verdict.
 *
 * The job runs every hour (scheduler.js) and judges each issue from 48 to 72 hours after it went
 * out: most opens have arrived by then, and a day of hourly runs covers a restart. An issue that
 * stopped part way ('failed') is judged too: the copies it delivered reached readers. One alert
 * per issue, ever: the dedupe key holds the send id, with neither dedupeOpenOnly nor
 * refreshOnDedupe, so a later run stays silent, also after a person marked the row done
 * (admin-alert-retention.js, RE-RING RISK). The check reads the ledger only and emails no one, so
 * it ships with no gate; nothing here holds or stops a send.
 */
'use strict';

const db = require('../models/db');
const logger = require('./logger');
const { PEST_INSIDER_TYPE } = require('../config/newsletter-types');
const { formatETDayDate } = require('../utils/datetime-et');

const HOUR_MS = 60 * 60 * 1000;
const JUDGE_FROM_MS = 48 * HOUR_MS;
const JUDGE_UNTIL_MS = 72 * HOUR_MS;
const MIN_COPIES = 20;
const CHANCE_LIMIT = 0.01;
const alertKey = (sendId) => `newsletter-gmail-check:${sendId}`;

/**
 * P(X <= k) for X ~ Binomial(n, p). Terms are summed from their logs: (1 - p)^n itself underflows
 * to 0 for a large issue.
 */
function binomialAtMost(k, n, p) {
  if (k >= n || p <= 0) return 1;
  if (p >= 1) return 0;
  const step = Math.log(p) - Math.log1p(-p);
  let logTerm = n * Math.log1p(-p);
  let sum = Math.exp(logTerm);
  for (let i = 0; i < k; i += 1) {
    logTerm += Math.log((n - i) / (i + 1)) + step;
    sum += Math.exp(logTerm);
  }
  return Math.min(1, sum);
}

/**
 * 'gap' when Gmail readers are far behind all other readers (the two rules in the header),
 * 'too_few' when either group has under MIN_COPIES delivered copies, else 'ok'. An issue nobody
 * opened is 'ok': that is not a Gmail fault.
 * @param {{ gmail: { delivered: number, opened: number }, other: { delivered: number, opened: number } }} counts
 */
function gmailGapVerdict({ gmail, other }) {
  if (gmail.delivered < MIN_COPIES || other.delivered < MIN_COPIES) return 'too_few';
  const otherRate = other.opened / other.delivered;
  const underHalf = (gmail.opened / gmail.delivered) * 2 < otherRate;
  return underHalf && binomialAtMost(gmail.opened, gmail.delivered, otherRate) < CHANCE_LIMIT ? 'gap' : 'ok';
}

const share = ({ opened, delivered }) => `${opened} of ${delivered}`;
const percent = ({ opened, delivered }) => `${Math.round((opened / delivered) * 100)}%`;

// The one alert for this issue. Resolves with notifyAdmin's result ({ deduped: true } on a repeat).
function raiseGmailGap(send, counts) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const name = send.newsletter_type === PEST_INSIDER_TYPE ? 'Waves Pest Insider' : 'Waves Newsletter';
  const dedupeKey = alertKey(send.id);
  return raiseAdminAlert('newsletter', {
    area: 'Content',
    action: `check Gmail delivery of the ${name}`,
    why: `Gmail readers opened ${share(counts.gmail)} copies (${percent(counts.gmail)}); all other readers opened ${share(counts.other)} (${percent(counts.other)}).`,
    severity: 'needs-you',
    link: '/admin/newsletter?tab=history',
    subject: { type: 'check', id: dedupeKey },
    doneWhen: 'report_read',
    who: 'person',
  }, {
    dedupeKey,
    // The bell policy silences the newsletter category by default (notification-bell-policy.js),
    // which would drop this row unwritten. The owner asked for this alert, so it always rings.
    bell: true,
    detail: `The ${name} issue "${send.subject || 'Untitled'}" went out ${formatETDayDate(new Date(send.sent_at))}. `
      + `Gmail readers opened ${share(counts.gmail)} delivered copies (${percent(counts.gmail)}). `
      + `All other readers opened ${share(counts.other)} (${percent(counts.other)}). `
      + 'Opens that Apple Mail makes by itself are not counted. '
      + 'A gap this large usually means Gmail put the issue in Spam. Gmail sends no spam reports, so the spam-report stop cannot see it. '
      + 'Look for the issue in a Gmail inbox, then open Google Postmaster Tools for news.wavespestcontrol.com.',
    metadata: { source: 'newsletter-gmail-check', sendId: send.id, counts },
  });
}

/**
 * One run: judges every issue that went out 48 to 72 hours before `now`, and raises the alert
 * for each one where Gmail is far behind. A read or alert error is thrown, so job_health records
 * the failed run; the next hour judges the same issues again.
 * @returns {Promise<{ judged: Array<{ sendId: string, verdict: string, gmail: object, other: object }> }>}
 */
async function runNewsletterGmailCheck({ now = new Date() } = {}) {
  // Lazy: the sender pulls the whole newsletter stack.
  const { gmailOpenCounts } = require('./newsletter-sender');
  const sends = await db('newsletter_sends')
    // 'failed' too: a send that stopped part way reached some readers, and the sender stamps its
    // sent_at at the final write of either status.
    .whereIn('status', ['sent', 'failed'])
    .where('sent_at', '<=', new Date(now.getTime() - JUDGE_FROM_MS))
    .where('sent_at', '>', new Date(now.getTime() - JUDGE_UNTIL_MS))
    .orderBy('sent_at', 'asc')
    .select('id', 'subject', 'newsletter_type', 'sent_at');
  const judged = [];
  for (const send of sends) {
    const counts = await gmailOpenCounts(db, send.id);
    const verdict = gmailGapVerdict(counts);
    if (verdict === 'gap') {
      const raised = await raiseGmailGap(send, counts);
      if (!raised?.deduped) {
        logger.warn(`[newsletter-gmail-check] send ${send.id}: Gmail ${share(counts.gmail)}, other ${share(counts.other)}; alert raised`);
      }
    }
    judged.push({ sendId: send.id, verdict, ...counts });
  }
  return { judged };
}

module.exports = {
  runNewsletterGmailCheck, gmailGapVerdict, binomialAtMost,
  MIN_COPIES, CHANCE_LIMIT, JUDGE_FROM_MS, JUDGE_UNTIL_MS,
};
