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
 *   2. Chance does not explain it: if an open were equally likely in both groups, Gmail readers
 *      would hold this few of the issue's opens less than 1 time in 100 (CHANCE_LIMIT; Fisher's
 *      exact test, one-sided). Without this, a small issue with few opens would raise an alert
 *      on a difference of two readers.
 * With fewer than MIN_COPIES delivered copies in either group there is no verdict.
 *
 * The job runs every hour (scheduler.js) and judges each issue from 48 to 72 hours after it went
 * out. Every run counts the same opens, the ones of the issue's first 48 hours (most have arrived
 * by then), so the day of hourly runs is one test that a restart or a failed run cannot skip, not
 * 24 tests of a moving count. An issue that stopped part way ('failed') is judged too: the copies
 * it delivered reached readers. One alert per issue, ever: the dedupe key holds the send id, with
 * neither dedupeOpenOnly nor refreshOnDedupe, so a later run stays silent, also after a person
 * marked the row done (admin-alert-retention.js, RE-RING RISK). The check reads the ledger only
 * and emails no one, so it ships with no gate; nothing here holds or stops a send.
 */
'use strict';

const db = require('../models/db');
const logger = require('./logger');
const { PEST_INSIDER_TYPE } = require('../config/newsletter-types');
const { formatETDayDate } = require('../utils/datetime-et');

const HOUR_MS = 60 * 60 * 1000;
// Opens count up to JUDGE_FROM_MS after the issue went out; runs judge it from then to JUDGE_UNTIL_MS.
const JUDGE_FROM_MS = 48 * HOUR_MS;
const JUDGE_UNTIL_MS = 72 * HOUR_MS;
const MIN_COPIES = 20;
const CHANCE_LIMIT = 0.01;
const alertKey = (sendId) => `newsletter-gmail-check:${sendId}`;

/**
 * Fisher's exact test, one-sided: the chance that Gmail readers hold `gmail.opened` or fewer of
 * the issue's opens when an open is equally likely in both groups (a hypergeometric tail). Both
 * rates come from this one issue, so neither is taken as exact: a binomial tail against the other
 * readers' rate reads 0 of 20 against 5 of 20 as 3 in 1,000, and it is 24 in 1,000. Terms are
 * summed from log factorials, which do not overflow for a large issue.
 * @param {{ gmail: { delivered: number, opened: number }, other: { delivered: number, opened: number } }} counts
 */
function chanceOfSoFewGmailOpens({ gmail, other }) {
  const copies = gmail.delivered + other.delivered;
  const opens = gmail.opened + other.opened;
  const logFactorial = [0];
  for (let i = 1; i <= copies; i += 1) logFactorial.push(logFactorial[i - 1] + Math.log(i));
  const logChoose = (n, k) => logFactorial[n] - logFactorial[k] - logFactorial[n - k];
  const allWays = logChoose(copies, opens);
  let chance = 0;
  // Gmail holds at least the opens that the other readers have no copies left to hold.
  for (let held = Math.max(0, opens - other.delivered); held <= gmail.opened; held += 1) {
    chance += Math.exp(logChoose(gmail.delivered, held) + logChoose(other.delivered, opens - held) - allWays);
  }
  return Math.min(1, chance);
}

/**
 * 'gap' when Gmail readers are far behind all other readers (the two rules in the header),
 * 'too_few' when either group has under MIN_COPIES delivered copies, else 'ok'. An issue nobody
 * opened is 'ok': that is not a Gmail fault.
 * @param {{ gmail: { delivered: number, opened: number }, other: { delivered: number, opened: number } }} counts
 */
function gmailGapVerdict({ gmail, other }) {
  if (gmail.delivered < MIN_COPIES || other.delivered < MIN_COPIES) return 'too_few';
  const underHalf = (gmail.opened / gmail.delivered) * 2 < other.opened / other.delivered;
  return underHalf && chanceOfSoFewGmailOpens({ gmail, other }) < CHANCE_LIMIT ? 'gap' : 'ok';
}

// When an issue went out: the later of the send's sent_at and its newest mailed copy (greatest
// skips a NULL). The sender stamps sent_at at its final write, 'sent' or 'failed'. A send that
// died before that write (a tick that threw part way, a stale claim) has none. A resumed send
// keeps its first sent_at, and its newest readers need the same 48 hours to open.
const WENT_OUT_SQL = 'greatest(newsletter_sends.sent_at, (select max(copy.sent_at)'
  + ' from newsletter_send_deliveries copy where copy.send_id = newsletter_sends.id))';

/**
 * The issues one run judges: each one that went out 48 to 72 hours before `now`, oldest first.
 * 'failed' too: a send that stopped part way reached some readers. A send with no sent_at and no
 * mailed copy has no time here and is never judged.
 * @returns {Promise<Array<{ id: string, subject: string, newsletter_type: string, went_out_at: Date }>>}
 */
function issuesToJudge(now) {
  return db('newsletter_sends')
    .whereIn('status', ['sent', 'failed'])
    .whereRaw(`${WENT_OUT_SQL} <= ?`, [new Date(now.getTime() - JUDGE_FROM_MS)])
    .whereRaw(`${WENT_OUT_SQL} > ?`, [new Date(now.getTime() - JUDGE_UNTIL_MS)])
    .orderByRaw(`${WENT_OUT_SQL} asc`)
    .select('id', 'subject', 'newsletter_type', db.raw(`${WENT_OUT_SQL} as went_out_at`));
}

const share = ({ opened, delivered }) => `${opened} of ${delivered}`;
const percent = ({ opened, delivered }) => `${Math.round((opened / delivered) * 100)}%`;

// The one alert for this issue. Resolves with notifyAdmin's result: { deduped: true } on a repeat,
// null when the row could not be written.
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
    detail: `The ${name} issue "${send.subject || 'Untitled'}" went out ${formatETDayDate(new Date(send.went_out_at))}. `
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
 * for each one where Gmail is far behind. A failed read or a failed alert write is thrown, so
 * job_health records the failed run; the next hour judges the same issues again.
 * @returns {Promise<{ judged: Array<{ sendId: string, verdict: string, gmail: object, other: object }> }>}
 */
async function runNewsletterGmailCheck({ now = new Date() } = {}) {
  // Lazy: the sender pulls the whole newsletter stack.
  const { gmailOpenCounts } = require('./newsletter-sender');
  const judged = [];
  for (const send of await issuesToJudge(now)) {
    const counts = await gmailOpenCounts(db, send.id, new Date(new Date(send.went_out_at).getTime() + JUDGE_FROM_MS));
    const verdict = gmailGapVerdict(counts);
    if (verdict === 'gap') {
      const raised = await raiseGmailGap(send, counts);
      // notifyAdmin resolves with null when it could not write the row. That is a failed run, not
      // a raised alert: the next hour tries again.
      if (!raised) throw new Error(`the Gmail alert for send ${send.id} was not written`);
      if (!raised.deduped) {
        logger.warn(`[newsletter-gmail-check] send ${send.id}: Gmail ${share(counts.gmail)}, other ${share(counts.other)}; alert raised`);
      }
    }
    judged.push({ sendId: send.id, verdict, ...counts });
  }
  return { judged };
}

module.exports = {
  runNewsletterGmailCheck, issuesToJudge, gmailGapVerdict, chanceOfSoFewGmailOpens,
  MIN_COPIES, CHANCE_LIMIT, JUDGE_FROM_MS, JUDGE_UNTIL_MS,
};
