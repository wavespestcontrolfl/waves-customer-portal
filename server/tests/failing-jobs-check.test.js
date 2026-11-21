/**
 * failing-jobs-check: the nightly read-only check that posts one engineering
 * FIX row listing the scheduled jobs that have had no good run for 2 hours
 * and whose last run failed or has not ended, and retires the row on a clean
 * night. Before it, a failing job showed only on the Agents → Queue tab; the
 * outside watchdog that read job_health stopped polling on 2026-09-05.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/intelligence-bar/job-health-tools', () => ({ getScheduledJobHealth: jest.fn() }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n1' })) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 0) }));

const sendgrid = require('../services/sendgrid-mail');
const { getScheduledJobHealth } = require('../services/intelligence-bar/job-health-tools');
const { deliverOpsDigest } = require('../services/ops-digest');
const { retireIfClean } = require('../services/ops-digest-fall-off');
const { DEAD_RUN_ERROR } = require('../utils/cron-lock');
const { runFailingJobsCheck, OPS_KEY, RECENT_RUN_DAYS } = require('../services/failing-jobs-check');

// Thu Nov 5, 11:31 PM ET (EST, UTC-5).
const NOW = Date.parse('2026-11-06T04:31:00.000Z');
const now = () => NOW;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const job = (name, state, startedAt, successAt, extra = {}) => ({
  job: name,
  state,
  last_started_at: startedAt,
  last_success_at: successAt,
  consecutive_failures: 0,
  last_error: null,
  ...extra,
});
const health = (...jobs) => jest.fn(async () => ({ jobs, total: jobs.length }));
// ICU may put a narrow no-break space before AM/PM.
const plain = (s) => String(s).replace(/ /g, ' ');
const digestArgs = () => deliverOpsDigest.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
});

describe('runFailingJobsCheck', () => {
  test('a clean night retires the standing row and posts nothing', async () => {
    const readHealth = health(
      job('inbox-hygiene', 'healthy', iso(NOW - 16 * HOUR), iso(NOW - 16 * HOUR)),
      job('scheduled-email-send', 'running', iso(NOW - 10 * 1000), iso(NOW - 70 * 1000)),
    );

    const result = await runFailingJobsCheck({ readHealth, now });

    expect(result).toEqual({ failing: [] });
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('a failed, a deploy-killed and a hung job post one standing FIX row', async () => {
    const readHealth = health(
      job('seo-sweep', 'stuck', '2026-11-06T01:00:00.000Z', '2026-11-05T01:05:00.000Z'),
      job('inbox-hygiene', 'failing', '2026-11-05T11:50:00.000Z', '2026-11-04T11:50:00.000Z', {
        consecutive_failures: 1,
        last_error: 'Timeout acquiring a connection. The pool is probably full.',
      }),
      job('property-enrich-backfill', 'failing', '2026-11-05T08:55:00.000Z', '2026-11-03T08:55:00.000Z', {
        consecutive_failures: 2,
        last_error: DEAD_RUN_ERROR,
      }),
      job('review-sync', 'healthy', iso(NOW - HOUR), iso(NOW - HOUR)),
    );

    const result = await runFailingJobsCheck({ readHealth, now });

    expect(result.failing).toEqual(['inbox-hygiene', 'property-enrich-backfill', 'seo-sweep']);
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const args = digestArgs();
    expect(args).toMatchObject({
      fallOff: true,
      key: OPS_KEY,
      dedupeKey: OPS_KEY,
      refreshOnDedupe: true,
      link: '/admin/agents?tab=queue',
      count: 3,
      itemKeys: ['inbox-hygiene', 'property-enrich-backfill', 'seo-sweep'],
      subject: 'FIX: 3 scheduled jobs failing',
      headline: 'System — fix 3 failing scheduled jobs',
      summary: '3 scheduled jobs have had no good run for 2 hours: the last run failed or has not ended.',
    });
    expect(args).not.toHaveProperty('dedupeWindowMs');
    expect(args.headline.length).toBeLessThanOrEqual(60);
    expect(args.summary.length).toBeLessThanOrEqual(110);
    const text = plain(args.text);
    expect(text).toContain('- inbox-hygiene: the last run failed. Last good run: Wed, Nov 4, 6:50 AM ET.');
    expect(text).toContain('- property-enrich-backfill: a deploy restart killed the last run (2 in a row). Last good run: Tue, Nov 3, 3:55 AM ET.');
    expect(text).toContain('- seo-sweep: the run that started Thu, Nov 5, 8:00 PM ET has not ended. Last good run: Wed, Nov 4, 8:05 PM ET.');
    expect(text).toContain('Agents → Queue shows the last error of each job.');
    expect(text).toContain('A run that a deploy restart killed did not finish its work.');
    // The stored error can hold customer data: it stays on the Queue tab.
    expect(args.text).not.toContain('Timeout acquiring');
    expect(args.html).not.toContain('Timeout acquiring');
    expect(args.html).toContain('<strong>inbox-hygiene</strong>');
  });

  test('jobs that are off on purpose or recovered are not listed; a weekly failure is', async () => {
    const readHealth = health(
      // Gate off after a deploy killed its last run, 6 weeks ago.
      job('sms-sealed-eval-autorun', 'failing', '2026-09-24T09:10:00.000Z', '2026-09-23T09:10:00.000Z', {
        consecutive_failures: 1,
        last_error: DEAD_RUN_ERROR,
      }),
      // Gate off or code removed: no run for 11 days, last run fine.
      job('signup-runner', 'stale', '2026-10-25T07:30:00.000Z', '2026-10-25T07:31:00.000Z'),
      // Frequent job, one-off failure: good run 6 minutes ago.
      job('scheduled-email-send', 'failing', iso(NOW - 60 * 1000), iso(NOW - 6 * 60 * 1000), { consecutive_failures: 1 }),
      // Hourly job, good run 90 minutes ago.
      job('hourly-sync', 'failing', iso(NOW - 30 * 60 * 1000), iso(NOW - 90 * 60 * 1000), { consecutive_failures: 1 }),
      // Running for 90 minutes: the classifier says stuck, but not for 2 hours yet.
      job('long-sweep', 'stuck', iso(NOW - 90 * 60 * 1000), iso(NOW - 26 * HOUR)),
      // A weekly job that failed 7 days ago is still listed until its next run.
      job('weekly-digest', 'failing', iso(NOW - 7 * DAY), iso(NOW - 14 * DAY), { consecutive_failures: 1 }),
    );

    const result = await runFailingJobsCheck({ readHealth, now });

    expect(result.failing).toEqual(['weekly-digest']);
    expect(digestArgs()).toMatchObject({
      count: 1,
      itemKeys: ['weekly-digest'],
      subject: 'FIX: 1 scheduled job failing',
      headline: 'System — fix 1 failing scheduled job',
      summary: '1 scheduled job has had no good run for 2 hours: the last run failed or has not ended.',
    });
    expect(digestArgs().text).not.toContain('deploy restart');
  });

  test('a job_health read that throws fails the run and never retires the row', async () => {
    const readHealth = jest.fn(async () => { throw new Error('connection terminated'); });

    await expect(runFailingJobsCheck({ readHealth, now })).rejects.toThrow('connection terminated');
    await expect(runFailingJobsCheck({ readHealth: jest.fn(async () => ({ error: 'x' })), now }))
      .rejects.toThrow('no job list');
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('the default read is the shared classifier the Queue tab uses', async () => {
    getScheduledJobHealth.mockResolvedValueOnce({ jobs: [], total: 0 });

    await runFailingJobsCheck();

    expect(getScheduledJobHealth).toHaveBeenCalledTimes(1);
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
  });

  test('the email fallback goes only to the internal ops inbox and throws when the mailer is not set up', async () => {
    const readHealth = health(job('inbox-hygiene', 'failing', iso(NOW - 16 * HOUR), iso(NOW - 40 * HOUR)));
    await runFailingJobsCheck({ readHealth, now });
    const { sendEmail } = digestArgs();

    await sendEmail();
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      subject: 'FIX: 1 scheduled job failing',
      categories: ['ops', OPS_KEY],
    }));

    sendgrid.isConfigured.mockReturnValue(false);
    await expect(sendEmail()).rejects.toThrow('mailer not configured');
  });

  test('the 8-day window is the shared classifier stale floor', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'intelligence-bar', 'job-health-tools.js'), 'utf8');
    expect(src).toContain(`const STALE_SUCCESS_DAYS = ${RECENT_RUN_DAYS};`);
  });
});

// The fixed or hourly crons (a plain minute list: no wildcard, no step) in
// scheduler.js that fire at hour:minute. Day fields are ignored, so a monthly
// job at that time counts too.
function fixedCronsAt(src, hour, minute) {
  const has = (field, value, max) => field.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    let lo = Number(range);
    let hi = stepText ? max : lo;
    if (range === '*') { lo = 0; hi = max; } else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number); }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
  return [...src.matchAll(/cron\.schedule\('([^']+)'/g)].map((m) => m[1]).filter((expr) => {
    const f = expr.trim().split(/\s+/);
    const [m, h] = f.length === 6 ? [f[1], f[2]] : [f[0], f[1]];
    return /^[\d,]+$/.test(m) && has(m, minute, 59) && has(h, hour, 23);
  });
}

describe('scheduler wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');

  test('runs nightly at 11:31 PM ET under runExclusive, with a lazy require and a job_health rethrow', () => {
    const i = src.indexOf("cron.schedule('31 23 * * *'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf('timezone', i) + 40);
    expect(block).toContain("runExclusive('failing-jobs-check'");
    expect(block).toContain("require('./failing-jobs-check')");
    expect(block).toContain('result.delivery.ok === false');
    expect(block).toContain("timezone: 'America/New_York'");
  });

  test('the nightly checks share no minute with another fixed or hourly job (#3208 rule)', () => {
    expect(fixedCronsAt(src, 23, 31)).toEqual(['31 23 * * *']);
    expect(fixedCronsAt(src, 23, 21)).toEqual(['21 23 * * *']);
    // text-name-spelling-check
    expect(fixedCronsAt(src, 23, 32)).toEqual(['32 23 * * *']);
    // late-sent-bill-check
    expect(fixedCronsAt(src, 23, 30)).toEqual(['30 23 * * *']);
    // The rule check itself: three hourly jobs run at minute 20.
    expect(fixedCronsAt(src, 23, 20).length).toBeGreaterThan(1);
  });
});
