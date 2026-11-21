/**
 * GATE_ESTIMATE_EMAILS_NAME_SERVICE, the 2-hour estimate_sent email (owner 2026-11-21): the pure body builder and the
 * runner wiring (stops at delivery, the minted link behind the pricing-authority guard, today's path when the gate is
 * off). Synthetic names and estimates only.
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
jest.mock('../routes/estimate-public', () => ({
  isStructuralOneTimeOnlyEstimate: (_data, est) => (Number(est.monthly_total) || 0) <= 0 && (Number(est.annual_total) || 0) <= 0
    && (Number(est.onetime_total) || 0) > 0,
}));
// The engine's reply arms and link builder, and the pricing-authority guard, have their own suites.
jest.mock('../services/estimate-follow-up', () => ({
  hasRepliedSince: jest.fn(async () => false),
  _private: { mintStageLinks: jest.fn(async () => ({ smsUrl: 'unused', emailUrl: 'https://waves.test/l/abc123' })) },
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
  buildEstimateSentEmail, APP_PARAGRAPH, APP_IMAGE_ALT, APP_CAPTION, APP_TOUR_POSTER_URL, APP_TOUR_VIDEO_URL,
} = require('../services/estimate-sent-email-by-service');

function recurring(...services) {
  return {
    id: 'est-1', status: 'sent', token: 'tok-synthetic', customer_email: 'pat@example.com',
    monthly_total: 90, annual_total: 1080, onetime_total: 0, sent_at: new Date('2026-11-20T15:00:00Z'),
    estimate_data: { result: { recurring: { services: services.map((service) => ({ service, mo: 30 })) } } },
  };
}

let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE;
  process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE = 'true';
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  followUp.hasRepliedSince.mockResolvedValue(false);
  followUp._private.mintStageLinks.mockResolvedValue({ smsUrl: 'unused', emailUrl: 'https://waves.test/l/abc123' });
  authority.estimateDeliverableUnderGate.mockResolvedValue(true);
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE;
  else process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE = savedGate;
});

describe('buildEstimateSentEmail', () => {
  const link = 'https://waves.test/l/abc123?x=1&y=2';

  test('an opened estimate: thanks line, service named, button, the five question rows, kept greeting and closing', () => {
    const { html_body: html, text_body: text, service } = buildEstimateSentEmail({
      estimate: { ...recurring('Pest Control', 'Lawn Care'), viewed_at: new Date() }, estimateUrl: link,
    });
    expect(service).toBe('lawn care and pest control');
    expect(html).toContain('<h2>Hi {{first_name}} — thanks for considering Waves</h2>');
    expect(html).toContain('<p>Thanks for taking a look at your lawn care and pest control estimate. Any questions? Just reply to this email and a real person answers.</p>');
    expect(html).not.toMatch(/landed|just making sure/i);
    expect(html).toContain('View my estimate');
    expect(html).toContain('href="https://waves.test/l/abc123?x=1&amp;y=2"');
    expect(html).toContain('<h2>A few things folks usually ask</h2>');
    ['What is included?', 'When can I start?', 'Am I locked in?', 'What if I see activity between visits?', 'Is the price locked in?']
      .forEach((q) => expect(html).toContain(`<strong>${q}</strong>`));
    expect(html.indexOf('What is included?')).toBeLessThan(html.indexOf('When can I start?'));
    expect(html).toContain('Pest control: exterior and interior protection on a recurring schedule');
    expect(html).toContain('<p>— The Waves Pest Control team</p>');
    expect(text).toContain('Thanks for taking a look at your lawn care and pest control estimate.');
    expect(text).toContain(`View my estimate: ${link}`);
    expect(text).not.toMatch(/landed/i);
  });

  test.each([
    ['viewed_at', { viewed_at: new Date() }],
    ['view_count', { view_count: 2 }],
  ])('%s makes it an opened estimate', (_name, extra) => {
    const { html_body: html } = buildEstimateSentEmail({ estimate: { ...recurring('Pest Control'), ...extra }, estimateUrl: link });
    expect(html).toContain('Thanks for taking a look at your pest control estimate.');
  });

  test('an unopened estimate says it is ready whenever the customer is', () => {
    const { html_body: html, text_body: text } = buildEstimateSentEmail({ estimate: recurring('Pest Control'), estimateUrl: link });
    expect(html).toContain('<p>Your pest control estimate is ready whenever you are.</p>');
    expect(text).toContain('Your pest control estimate is ready whenever you are.');
    expect(html).not.toContain('Thanks for taking a look');
  });

  test('no link means no button and no link line, and the rest goes', () => {
    const { html_body: html, text_body: text } = buildEstimateSentEmail({ estimate: recurring('Pest Control'), estimateUrl: null });
    expect(html).not.toContain('View my estimate');
    expect(html).not.toContain('waves.test');
    expect(html).not.toContain('class="dm-gold"');
    expect(text).not.toContain('View my estimate');
    expect(html).toContain('A few things folks usually ask');
  });

  test('a one-time job drops the contract and between-visits rows', () => {
    const est = {
      id: 'one', status: 'sent', monthly_total: 0, annual_total: 0, onetime_total: 150,
      estimate_data: { inputs: { svcOnetimePest: true } },
    };
    const { html_body: html, service } = buildEstimateSentEmail({ estimate: est, estimateUrl: link });
    expect(service).toBe('one-time pest control');
    expect(html).toContain('Your one-time pest control estimate is ready');
    expect(html).toContain('<strong>What is included?</strong>');
    expect(html).toContain('<strong>When can I start?</strong>');
    expect(html).toContain('<strong>Is the price locked in?</strong>');
    expect(html).not.toContain('Am I locked in?');
    expect(html).not.toContain('between visits');
  });

  test('a termite estimate carries no guarantee line and no contract row', () => {
    const { html_body: html, text_body: text } = buildEstimateSentEmail({ estimate: recurring('Termite Bait Monitoring'), estimateUrl: link });
    expect(html).toContain('Your termite protection estimate is ready');
    expect(html).not.toMatch(/guarantee|callbacks|money-back/i);
    expect(text).not.toMatch(/guarantee|callbacks|money-back/i);
    expect(html).not.toContain('Am I locked in?');
  });

  describe('the Waves app block', () => {
    const oneTime = { id: 'one', status: 'sent', monthly_total: 0, annual_total: 0, onetime_total: 150, estimate_data: { inputs: { svcOnetimePest: true } } };
    test.each([
      ['a recurring plan', recurring('Pest Control', 'Lawn Care')],
      ['a one-time job', oneTime],
      ['a termite estimate', recurring('Termite Bait Monitoring')],
    ])('%s: paragraph, linked poster and caption sit after the question rows and before the closing', (_name, estimate) => {
      const { html_body: html, text_body: text } = buildEstimateSentEmail({ estimate, estimateUrl: 'https://waves.test/l/abc123' });
      expect(APP_PARAGRAPH).toBe('The Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule any visit yourself, right from the app.');
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
  });

  test('every merged value is escaped in the HTML body', () => {
    const { html_body: html } = buildEstimateSentEmail({
      estimate: { ...recurring('Tree & Shrub Care'), viewed_at: new Date() },
      estimateUrl: 'https://waves.test/l/a"><script>alert(1)</script>',
    });
    expect(html).toContain('tree &amp; shrub care estimate');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

// ---------------------------------------------------------------- the runner

function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNot', 'join', 'whereNotNull', 'whereNull', 'orWhereNotNull', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit']
    .forEach((m) => { q[m] = jest.fn(() => q); });
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

// estimateRows: the answers to each read of `estimates`, in order. The accepted-stop read is first.
function queues({ estimateRows, enrollment: overrides = {} }) {
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
    automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, subject: 'A quick note on your Waves estimate, {{first_name}}',
      html_body: STEP_HTML, text_body: 'Old text: making sure it landed.', from_email: 'automations@wavespestcontrol.com', enabled: true }] })],
    automation_step_sends: [chain({ returning: [{ id: 'send-n' }] }), sendUpdate],
    email_suppressions: [chain({ result: [] })],
    estimates: estimateRows.map((row) => chain({ first: row })),
  });
  return { enrollmentUpdate, sendUpdate };
}

function cancelledWith(enrollmentUpdate, reason) {
  expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'cancelled',
    metadata: { sql: expect.stringContaining('{cancel_reason}'), bindings: [JSON.stringify(reason)] },
  }));
}

describe('estimate_sent at delivery', () => {
  test('gate off: today\'s step body goes, and no extra estimate read happens', async () => {
    delete process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE;
    queues({ estimateRows: [undefined] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    const sent = sendgrid.sendOne.mock.calls[0][0];
    expect(sent.html).toContain('Old body: just making sure it landed.');
    expect(sent.text).toContain('Old text');
    expect(sent.html).not.toContain('The Waves app keeps everything in one place');
    expect(sent.html).not.toContain('waves-app-tour');
    expect(followUp._private.mintStageLinks).not.toHaveBeenCalled();
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('gate on: the per-estimate body replaces the step body; subject stays the step\'s', async () => {
    queues({ estimateRows: [undefined, recurring('Pest Control'), recurring('Pest Control')] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-2' });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    const sent = sendgrid.sendOne.mock.calls[0][0];
    expect(sent.subject).toBe('A quick note on your Waves estimate, Pat');
    expect(sent.html).toContain('Hi Pat — thanks for considering Waves');
    expect(sent.html).toContain('Your pest control estimate is ready whenever you are.');
    expect(sent.html).toContain('https://waves.test/l/abc123');
    expect(sent.html).not.toContain('Old body');
    expect(sent.html).toContain('The Waves app keeps everything in one place');
    expect(sent.text).toContain('View my estimate: https://waves.test/l/abc123');
    expect(followUp._private.mintStageLinks).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-1' }), 'estimate_sent_automation', { emailOnly: true });
  });

  test('gate on: the guard refusing the estimate leaves the button out, the rest goes', async () => {
    authority.estimateDeliverableUnderGate.mockResolvedValue(false);
    queues({ estimateRows: [undefined, recurring('Pest Control'), recurring('Pest Control')] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-3' });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    const sent = sendgrid.sendOne.mock.calls[0][0];
    expect(sent.html).not.toContain('View my estimate');
    expect(sent.html).toContain('A few things folks usually ask');
    expect(followUp._private.mintStageLinks).not.toHaveBeenCalled();
  });

  test('gate on: a failed link mint leaves the button out, the rest goes', async () => {
    followUp._private.mintStageLinks.mockRejectedValue(Object.assign(new Error('secret 941-555-0100'), { code: 'ECONNRESET' }));
    queues({ estimateRows: [undefined, recurring('Pest Control'), recurring('Pest Control')] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-4' });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    expect(sendgrid.sendOne.mock.calls[0][0].html).not.toContain('View my estimate');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('941-555-0100');
  });

  test.each([['accepted'], ['declined'], ['expired'], ['void'], ['draft']])('gate on: status %s cancels as estimate_closed', async (status) => {
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, { ...recurring('Pest Control'), status }] });

    await expect(sendStep('enrollment-n')).resolves.toEqual({ sent: false, blocked: true, reason: 'The estimate is no longer open' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    cancelledWith(enrollmentUpdate, 'estimate_closed');
  });

  test('gate on: an estimate opted out of follow-ups cancels', async () => {
    const row = { ...recurring('Pest Control'), estimate_data: { noEngagementAutomation: true } };
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, row] });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ blocked: true, reason: 'The estimate opted out of follow-ups' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    cancelledWith(enrollmentUpdate, 'estimate_opted_out');
  });

  test('gate on: a reply since the estimate went out cancels; the window starts at sent_at', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = queues({ estimateRows: [undefined, recurring('Pest Control')] });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ blocked: true, reason: 'The customer replied since the estimate went out' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(followUp.hasRepliedSince).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-1' }), new Date('2026-11-20T15:00:00Z'));
    cancelledWith(enrollmentUpdate, 'estimate_replied');
  });

  test('gate on: with no sent_at the window starts at the enrollment', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    queues({ estimateRows: [undefined, { ...recurring('Pest Control'), sent_at: null }] });

    await sendStep('enrollment-n');
    expect(followUp.hasRepliedSince).toHaveBeenCalledWith(expect.anything(), ENROLLED_AT);
  });

  test('gate on: a failed reply read fails open (the email goes) and logs only the error code', async () => {
    followUp.hasRepliedSince.mockRejectedValue(Object.assign(new Error('select ... 941-555-0100'), { code: '57P01' }));
    queues({ estimateRows: [undefined, recurring('Pest Control'), recurring('Pest Control')] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-5' });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('57P01');
    expect(logged).not.toContain('941-555-0100');
  });

  test('gate on: no estimate id on the enrollment keeps today\'s path', async () => {
    queues({ estimateRows: [undefined], enrollment: { metadata: {} } });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-6' });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    expect(sendgrid.sendOne.mock.calls[0][0].html).toContain('Old body');
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('gate on: an estimate row that is missing keeps today\'s path', async () => {
    queues({ estimateRows: [undefined, undefined, undefined] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-7' });

    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
    expect(sendgrid.sendOne.mock.calls[0][0].html).toContain('Old body');
  });

  test('gate on: a test send never reads the estimate and sends the step body', async () => {
    queues({ estimateRows: [] });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-8' });

    await sendStep('enrollment-n', { testRecipient: 'owner@example.com' });
    expect(sendgrid.sendOne.mock.calls[0][0].html).toContain('Old body');
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });
});
