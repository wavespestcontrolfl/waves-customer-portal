/**
 * GATE_ESTIMATE_TWO_HOUR_EMAIL, the 2-hour estimate_sent email (owner 2026-11-21): the fixed body for an opened estimate and
 * the runner wiring (the stops; the new body only when the estimate was opened, emailed to this address and the step goes
 * there; today's step body otherwise; no estimate link anywhere). Synthetic names and estimates only.
 */

jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
  wasLockSkipped: jest.requireActual('../utils/cron-lock').wasLockSkipped,
}));
jest.mock('../services/contact-notification-prefs', () => ({
  ...jest.requireActual('../services/contact-notification-prefs'),
  rerouteForContactEmailOptOut: jest.fn(async (_customerId, email) => ({ email, rerouted: false })),
}));
// The engine's reply arms have their own suite. The runner must not mint an estimate link or ask the pricing guard.
jest.mock('../services/estimate-follow-up', () => ({
  hasRepliedSince: jest.fn(async () => false),
  _private: { mintStageLinks: jest.fn(), TERMINAL_STATUSES: new Set(['declined', 'accepted', 'expired', 'void']) },
}));
jest.mock('../services/pricing-authority-gate', () => ({
  estimateDeliverableUnderGate: jest.fn(async () => true),
}));

const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const logger = require('../services/logger');
const followUp = require('../services/estimate-follow-up');
const authority = require('../services/pricing-authority-gate');
const { sendStep } = require('../services/automation-runner');
const {
  buildEstimateOpenedEmail, estimateOpenedAfter, latestViewTime, OPENED_PARAGRAPH,
  APP_PARAGRAPH, APP_IMAGE_ALT, APP_CAPTION, APP_TOUR_POSTER_URL, APP_TOUR_VIDEO_URL,
} = require('../services/estimate-sent-opened-email');
const { ESTIMATE_SENT_FAQ } = require('../services/estimate-followup-copy');

function estimateRow(extra = {}) {
  return {
    id: 'est-1', status: 'sent', token: 'tok-synthetic', customer_email: 'pat@example.com',
    monthly_total: 90, annual_total: 1080, onetime_total: 0, sent_at: new Date('2026-11-20T15:00:00Z'),
    estimate_data: { result: { recurring: { services: [{ service: 'Pest Control', mo: 30 }] } } },
    ...extra,
  };
}
const opened = (extra = {}) => estimateRow({ viewed_at: new Date('2026-11-20T16:00:00Z'), ...extra });

let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL;
  process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL = 'true';
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  followUp.hasRepliedSince.mockResolvedValue(false);
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL;
  else process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL = savedGate;
});

describe('latestViewTime and estimateOpenedAfter', () => {
  const T0 = new Date('2026-11-20T15:00:00Z');

  test('the latest of viewed_at and last_viewed_at; none for view_count alone or an unreadable stamp', () => {
    expect(latestViewTime(estimateRow({ viewed_at: '2026-11-20T16:00:00Z', last_viewed_at: '2026-11-20T18:00:00Z' }))).toEqual(new Date('2026-11-20T18:00:00Z'));
    expect(latestViewTime(estimateRow({ viewed_at: '2026-11-20T16:00:00Z' }))).toEqual(new Date('2026-11-20T16:00:00Z'));
    expect(latestViewTime(estimateRow({ view_count: 4 }))).toBeNull();
    expect(latestViewTime(estimateRow({ viewed_at: 'not a time' }))).toBeNull();
  });

  test('a view at or after the delivery counts; one before it, view_count alone, or an unreadable time does not', () => {
    expect(estimateOpenedAfter(estimateRow({ viewed_at: T0 }), T0)).toBe(true);
    expect(estimateOpenedAfter(estimateRow({ last_viewed_at: '2026-11-20T15:00:01Z' }), T0)).toBe(true);
    expect(estimateOpenedAfter(estimateRow({ viewed_at: '2026-11-20T14:59:59Z' }), T0)).toBe(false);
    expect(estimateOpenedAfter(estimateRow({ view_count: 5 }), T0)).toBe(false);
    expect(estimateOpenedAfter(estimateRow({ viewed_at: T0 }), 'not a time')).toBe(false);
    expect(estimateOpenedAfter(estimateRow({ viewed_at: T0 }), null)).toBe(false);
  });
});

describe('buildEstimateOpenedEmail', () => {
  const TWO_ROWS = ['When can I start?', 'Is the price locked in?'];
  const { html_body: html, text_body: text } = buildEstimateOpenedEmail();

  test('the two answers are the engine\'s general ones', () => {
    expect(ESTIMATE_SENT_FAQ.start).toBe('Whenever works for you. Most new customers pick a start date within 1–2 weeks.');
    expect(ESTIMATE_SENT_FAQ.price).toContain('your price holds until the expiration date on your estimate');
    expect(Object.isFrozen(ESTIMATE_SENT_FAQ)).toBe(true);
  });

  test('kept greeting and closing, the thank-you line, the heading and exactly the two rows', () => {
    expect(OPENED_PARAGRAPH).toBe('Thanks for taking a look at your Waves estimate. Any questions? Just reply to this email and a real person answers.');
    expect(html).toContain('<h2>Hi {{first_name}} — thanks for considering Waves</h2>');
    expect(html).toContain(`<p>${OPENED_PARAGRAPH}</p>`);
    expect(html).toContain('<h2>A few things folks usually ask</h2>');
    expect([...html.matchAll(/<li><strong>([^<]+)<\/strong>/g)].map((m) => m[1])).toEqual(TWO_ROWS);
    expect(html).toContain(ESTIMATE_SENT_FAQ.start);
    expect(html).toContain("If you've got a question that's not on that list");
    expect(html).toContain('<p>— The Waves Pest Control team</p>');
    expect(text).toContain(OPENED_PARAGRAPH);
    expect(html).not.toMatch(/landed|just making sure|View my estimate|ready whenever/i);
  });

  test('no link to an estimate, no price, no service word', () => {
    const urls = [...(html + text).matchAll(/https?:\/\/[^\s"'<)]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    urls.forEach((url) => expect(url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/app-email\/videos\/waves-app-tour(-poster\.jpg|\.mp4)$/));
    expect(html + text).not.toMatch(/estimate\/|\$\d|lawn|termite|mosquito|commercial|trench|rodent|callback|guarantee|money-back|re-service|commitment|cancel/i);
    expect(html).not.toContain('dm-gold');
  });

  test('the Waves app block sits after the question rows and before the closing', () => {
    expect(APP_PARAGRAPH).toBe('The Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule a visit yourself, right from the app.');
    expect(APP_TOUR_POSTER_URL).toBe('https://portal.wavespestcontrol.com/app-email/videos/waves-app-tour-poster.jpg');
    expect(APP_TOUR_VIDEO_URL).toBe('https://portal.wavespestcontrol.com/app-email/videos/waves-app-tour.mp4');
    expect(APP_CAPTION).toBe('Tap to watch the Waves app in action.');
    expect(html).toContain(`<p>${APP_PARAGRAPH}</p>`);
    expect(html).toContain(`<a href="${APP_TOUR_VIDEO_URL}"><img src="${APP_TOUR_POSTER_URL}"`);
    expect(html).toContain('alt="Tap to watch: the Waves app — visits, reports, reschedule, and payments in one place"');
    expect(APP_IMAGE_ALT).toContain('Tap to watch: the Waves app');
    expect(html).toContain('width="520"');
    expect(html).toContain('max-width:100%');
    expect(html).toContain('border-radius:18px');
    expect(html).toContain(APP_CAPTION);
    const at = html.indexOf('The Waves app keeps everything');
    expect(at).toBeGreaterThan(html.lastIndexOf('<li>'));
    expect(at).toBeLessThan(html.indexOf("If you've got a question"));
    expect(text).toContain(`${APP_PARAGRAPH}\nWatch the Waves app in action: ${APP_TOUR_VIDEO_URL}`);
    expect(text.indexOf('The Waves app keeps')).toBeLessThan(text.indexOf("If you've got a question"));
  });

  test('takes no estimate: the same text for every call', () => {
    expect(buildEstimateOpenedEmail()).toEqual({ html_body: html, text_body: text });
    expect(buildEstimateOpenedEmail.length).toBe(0);
  });
});

// ---------------------------------------------------------------- the runner

function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNot', 'join', 'whereNotNull', 'whereNull', 'orWhereNotNull', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => Promise.resolve(1));
  q.del = jest.fn(() => Promise.resolve(1));
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(() => Promise.resolve(returning || []));
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => db(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    return fn(trx);
  });
}

const ENROLLED_AT = new Date('2026-11-20T17:00:00Z');
const STEP_HTML = '<p>Old body: just making sure it landed.</p>';

// The email log read behind the proof the estimate was emailed to the address: rows by the lower-cased address the query asks for.
function emailLog(rowsByAddress, { fail = false } = {}) {
  const q = chain();
  q.asked = {};
  q.whereRaw = jest.fn((sql, [address]) => { q.asked.address = address; q.asked.sql = sql; return q; });
  q.select = jest.fn((...columns) => { q.asked.select = columns; return q; });
  q.where = jest.fn((clause) => { q.asked.where = clause; return q; });
  q.whereIn = jest.fn((column, values) => { q.asked[column] = values; return q; });
  q.then = (resolve, reject) => (fail
    ? Promise.reject(Object.assign(new Error('select 941-555-0100'), { code: '57P01' }))
    : Promise.resolve(rowsByAddress[q.asked.address] || [])).then(resolve, reject);
  return q;
}
// The estimate was emailed to Pat at 15:00 (sent_at); a view at 16:00 comes after it.
const DELIVERED_AT = '2026-11-20T15:00:05Z';
const SENT_TO_PAT = { 'pat@example.com': [{ status: 'delivered', sent_at: DELIVERED_AT, queued_at: '2026-11-20T15:00:00Z' }] };

const STEP_ZERO = { id: 'step-1', step_order: 0, subject: 'A quick note on your Waves estimate, {{first_name}}',
  html_body: STEP_HTML, text_body: 'Old text: making sure it landed.', from_email: 'automations@wavespestcontrol.com', enabled: true };

// estimateRows: the answers to each read of `estimates`, in order. The accepted-stop read is first.
function queues({ estimateRows, enrollment: overrides = {}, log = emailLog(SENT_TO_PAT), steps = [STEP_ZERO] }) {
  const enrollment = {
    id: 'enrollment-n', template_key: 'estimate_sent', customer_id: 'cust-n', status: 'active', current_step: 0,
    email: 'pat@example.com', first_name: 'Pat', last_name: 'Synthetic', enrolled_at: ENROLLED_AT,
    metadata: { estimate_id: 'est-1' }, ...overrides,
  };
  const enrollmentUpdate = chain();
  const sendUpdate = chain();
  setDbQueues({
    automation_enrollments: [chain({ first: enrollment }), chain({ first: enrollment }), enrollmentUpdate],
    automation_templates: [chain({ first: { key: 'estimate_sent', name: 'Estimate Sent', asm_group: 'service' } })],
    automation_steps: [chain({ result: steps })],
    automation_step_sends: [chain({ returning: [{ id: 'send-n' }] }), sendUpdate],
    email_suppressions: [chain({ result: [] })],
    estimates: estimateRows.map((row) => chain({ first: row })),
    email_messages: [log],
  });
  return { enrollmentUpdate, sendUpdate, log };
}

function cancelledWith(enrollmentUpdate, reason) {
  expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'cancelled',
    metadata: { sql: expect.stringContaining('{cancel_reason}'), bindings: [JSON.stringify(reason)] },
  }));
}

describe('estimate_sent at delivery', () => {
  const OLD_BODY = 'Old body: just making sure it landed.';
  const OLD_TEXT = 'Old text: making sure it landed.';
  const NEW_BODY = /Thanks for taking a look at your Waves estimate\./;
  const sendOnce = async () => {
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-x' });
    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    return sendgrid.sendOne.mock.calls.at(-1)[0];
  };
  const expectTodaysBody = (sent) => {
    expect(sent.html).toContain(OLD_BODY);
    expect(sent.text).toContain(OLD_TEXT);
    expect(sent.html).not.toMatch(/Thanks for taking a look|Waves app keeps|waves-app-tour/);
    expect(authority.estimateDeliverableUnderGate).not.toHaveBeenCalled();
    expect(followUp._private.mintStageLinks).not.toHaveBeenCalled();
  };

  test('gate off: today\'s step body goes, and no extra estimate read happens', async () => {
    delete process.env.GATE_ESTIMATE_TWO_HOUR_EMAIL;
    queues({ estimateRows: [undefined] });
    const sent = await sendOnce();
    expectTodaysBody(sent);
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test.each([
    ['viewed_at', { viewed_at: new Date() }],
    ['last_viewed_at', { last_viewed_at: new Date() }],
  ])('gate on: opened (%s) after the delivery + proof + matching address gets the new body; the subject stays the step\'s', async (_name, extra) => {
    const { log } = queues({ estimateRows: [undefined, estimateRow(extra)] });
    const sent = await sendOnce();
    expect(sent.subject).toBe('A quick note on your Waves estimate, Pat');
    expect(sent.html).toContain('Hi Pat — thanks for considering Waves');
    expect(sent.html).toMatch(NEW_BODY);
    expect(sent.html).toContain('The Waves app keeps everything in one place');
    expect(sent.html).not.toContain('Old body');
    expect(sent.text).toMatch(NEW_BODY);
    expect(sent.html).not.toMatch(/View my estimate|portal\.wavespestcontrol\.com\/estimate/);
    expect(authority.estimateDeliverableUnderGate).not.toHaveBeenCalled();
    expect(followUp._private.mintStageLinks).not.toHaveBeenCalled();
    expect(log.asked.where).toEqual({ estimate_id: 'est-1' });
    expect(log.asked.template_key).toEqual(['estimate.delivery', 'estimate.proposal_delivery', 'estimate.updated_delivery']);
    expect(log.asked.status).toEqual(expect.arrayContaining(['sent', 'delivered']));
    expect(log.asked.address).toBe('pat@example.com');
    expect(log.asked.sql).toBe('LOWER(TRIM(recipient_email_snapshot)) = ?');
    expect(log.asked.select).toEqual(['status', 'sent_at', 'queued_at']);
  });

  test.each([
    ['an unopened estimate', {}],
    ['a view_count with no view timestamp', { view_count: 3 }],
    ['an unreadable view time', { viewed_at: 'not a time' }],
  ])('gate on: %s (with proof and a matching address) gets today\'s DB body exactly, and no log read', async (_name, extra) => {
    queues({ estimateRows: [undefined, estimateRow(extra)] });
    expectTodaysBody(await sendOnce());
    expect(db).not.toHaveBeenCalledWith('email_messages');
  });

  test.each([
    ['no proof (an SMS-only send: no delivery email row)', emailLog({})],
    ['a delivery email row for another address', emailLog({ 'other@example.com': [{ status: 'sent', sent_at: DELIVERED_AT }] })],
    ['a delivery email that was only queued or failed', emailLog({ 'pat@example.com': [{ status: 'failed', queued_at: DELIVERED_AT }, { status: 'queued', queued_at: DELIVERED_AT }] })],
    ['a delivery email with an unreadable time', emailLog({ 'pat@example.com': [{ status: 'delivered', sent_at: 'not a time', queued_at: null }] })],
    ['a view before the delivery to this address (an earlier recipient\'s open)', emailLog({ 'pat@example.com': [{ status: 'delivered', sent_at: '2026-11-20T17:00:00Z' }] })],
    ['a failed read of the email log', emailLog({}, { fail: true })],
  ])('gate on: an opened estimate with %s gets today\'s DB body exactly', async (_name, log) => {
    queues({ estimateRows: [undefined, opened()], log });
    expectTodaysBody(await sendOnce());
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('941-555-0100');
  });

  test('gate on: the EARLIEST accepted delivery to this address is the one the view is compared with', async () => {
    const log = emailLog({ 'pat@example.com': [
      { status: 'delivered', sent_at: '2026-11-20T18:00:00Z' },
      { status: 'sent', sent_at: null, queued_at: '2026-11-20T15:30:00Z' },
      { status: 'failed', sent_at: '2026-11-20T10:00:00Z' },
    ] });
    queues({ estimateRows: [undefined, opened()], log });
    expect((await sendOnce()).html).toMatch(NEW_BODY);
  });

  test('gate on: an opened estimate whose step goes to another address (the account holder) gets today\'s DB body, no log read', async () => {
    queues({ estimateRows: [undefined, opened()], enrollment: { email: 'holder@example.com' } });
    const sent = await sendOnce();
    expect(sent.to).toBe('holder@example.com');
    expectTodaysBody(sent);
    expect(db).not.toHaveBeenCalledWith('email_messages');
  });

  describe('a later step of the template (step_order 1)', () => {
    const second = { ...STEP_ZERO, id: 'step-2', step_order: 1, html_body: '<p>Second step body.</p>', text_body: 'Second step text.' };
    const laterStep = (estimateRows) => queues({ estimateRows, steps: [STEP_ZERO, second], enrollment: { current_step: 1 } });

    test('keeps its own body, even for an opened estimate with proof; only the accept stop read the estimate', async () => {
      laterStep([undefined]);
      const sent = await sendOnce();
      expect(sent.html).toContain('Second step body.');
      expect(sent.text).toContain('Second step text.');
      expect(sent.html).not.toContain('The Waves app keeps everything in one place');
      expect(db.mock.calls.filter(([table]) => table === 'estimates')).toHaveLength(1);
      expect(db).not.toHaveBeenCalledWith('email_messages');
    });

    test('a recorded reply does not cancel it', async () => {
      followUp.hasRepliedSince.mockResolvedValue(true);
      const { enrollmentUpdate } = laterStep([undefined]);
      expect((await sendOnce()).html).toContain('Second step body.');
      expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
      expect(enrollmentUpdate.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    });

    test('a closed or archived estimate does not cancel it', async () => {
      const { enrollmentUpdate } = laterStep([undefined, { ...estimateRow(), status: 'declined', archived_at: new Date() }]);
      expect((await sendOnce()).html).toContain('Second step body.');
      expect(enrollmentUpdate.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    });

    test('the accept stop still cancels it', async () => {
      const { enrollmentUpdate } = laterStep([{ id: 'est-1' }]);
      await expect(sendStep('enrollment-n')).resolves.toEqual({ sent: false, blocked: true, reason: 'The customer accepted the estimate' });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      cancelledWith(enrollmentUpdate, 'estimate_accepted');
    });
  });

  test('gate on: the stops and the body use one read of the estimate', async () => {
    // A third read would see an archived row; there is none: the body comes from the stop row (the opened one).
    queues({ estimateRows: [undefined, opened(), opened({ archived_at: new Date() })] });
    const sent = await sendOnce();
    expect(sent.html).toMatch(NEW_BODY);
    expect(db.mock.calls.filter(([table]) => table === 'estimates')).toHaveLength(2);
  });

  test('gate on: a row that is no longer open when the stops read it sends nothing and cancels the enrollment', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, { ...estimateRow(), accepted_at: new Date(), status: 'accepted' }] });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ blocked: true, reason: 'The estimate is no longer open' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    cancelledWith(enrollmentUpdate, 'estimate_closed');
  });

  test('gate on: an archived estimate cancels as estimate_closed', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, { ...estimateRow(), archived_at: new Date('2026-11-20T20:00:00Z') }] });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ blocked: true, reason: 'The estimate is no longer open' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    cancelledWith(enrollmentUpdate, 'estimate_closed');
  });

  test('gate on: an estimate past its expires_at cancels as estimate_closed though its status still reads sent', async () => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, { ...estimateRow(), status: 'viewed', expires_at: new Date(Date.now() - 3600000) }] });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ blocked: true, reason: 'The estimate is no longer open' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    cancelledWith(enrollmentUpdate, 'estimate_closed');
  });

  test.each([['accepted'], ['declined'], ['expired'], ['void']])('gate on: terminal status %s cancels as estimate_closed', async (status) => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, { ...estimateRow(), status }] });

    await expect(sendStep('enrollment-n')).resolves.toEqual({ sent: false, blocked: true, reason: 'The estimate is no longer open' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    cancelledWith(enrollmentUpdate, 'estimate_closed');
  });

  test.each([['sending'], ['draft'], ['scheduled'], ['send_failed']])('gate on: a transient status (%s) is no stop and gets no new body: the DB body goes', async (status) => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, { ...opened(), status }] });

    expectTodaysBody(await sendOnce());
    expect(enrollmentUpdate.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalledWith('email_messages');
  });

  test('gate on: an estimate opted out of follow-ups cancels', async () => {
    const row = { ...estimateRow(), estimate_data: { noEngagementAutomation: true } };
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, row] });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ blocked: true, reason: 'The estimate opted out of follow-ups' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    cancelledWith(enrollmentUpdate, 'estimate_opted_out');
  });

  test('gate on: a reply since the estimate went out cancels; the window starts at sent_at', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, estimateRow()] });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ blocked: true, reason: 'The customer replied since the estimate went out' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(followUp.hasRepliedSince).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-1' }), new Date('2026-11-20T15:00:00Z'));
    cancelledWith(enrollmentUpdate, 'estimate_replied');
  });

  test('gate on: with no sent_at the window starts at the enrollment', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    queues({ estimateRows: [undefined, { ...estimateRow(), sent_at: null }] });

    await sendStep('enrollment-n');
    expect(followUp.hasRepliedSince).toHaveBeenCalledWith(expect.anything(), ENROLLED_AT);
  });

  test('gate on: a failed reply read fails open (the email goes) and logs only the error code', async () => {
    followUp.hasRepliedSince.mockRejectedValue(Object.assign(new Error('select ... 941-555-0100'), { code: '57P01' }));
    queues({ estimateRows: [undefined, estimateRow()] });
    await sendOnce();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('57P01');
    expect(logged).not.toContain('941-555-0100');
  });

  test('gate on: no estimate id on the enrollment keeps today\'s path', async () => {
    queues({ estimateRows: [undefined], enrollment: { metadata: {} } });
    expectTodaysBody(await sendOnce());
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('gate on: an estimate row that is missing keeps today\'s path', async () => {
    queues({ estimateRows: [undefined, undefined] });
    expectTodaysBody(await sendOnce());
  });

  test('gate on: a test send never reads the estimate and sends the step body', async () => {
    queues({ estimateRows: [] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-8' });
    await sendStep('enrollment-n', { testRecipient: 'owner@example.com' });
    expectTodaysBody(sendgrid.sendOne.mock.calls[0][0]);
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });
});
