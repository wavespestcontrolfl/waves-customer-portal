/**
 * GATE_ESTIMATE_FOLLOWUP_MONTHLY_AVERAGE (owner 2026-10-21, "follow-ups too"):
 * the unviewed, viewed, final and expiring follow-up emails show the same
 * monthly average the delivery email does, built by the same resolver
 * (emailAverageParts) from a row read at send time. Gate off = the payload is
 * the very same object the sender built before.
 */
const mockGates = { followup: true, base: true, months: false };
const NOTE_BLOCKS = [
  { type: 'details', rows: [{ label: 'Estimate', value: '{{price_summary}}' }] },
  { type: 'paragraph', content: '{{estimate_average_note}}' },
];
const mockTemplate = { activeVersion: { blocks: NOTE_BLOCKS, text_body: null } };
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'estimateFollowupMonthlyAverage' ? mockGates.followup
    : gate === 'estimateMonthlyAverage' ? mockGates.base
      : gate === 'estimateApplicationMonths' ? mockGates.months : false)),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  loadTemplateByKey: jest.fn(async () => ({ template: { status: 'active' }, activeVersion: mockTemplate.activeVersion })),
  redactEmailAddresses: (s) => String(s || ''),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url, opts = {}) => `https://short.test/${opts.channel}`) }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => 'SMS body'), isTemplateActive: jest.fn(async () => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-conversion-guard', () => ({ customerConvertedSince: jest.fn(async () => ({ converted: false })) }));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn(async () => 'lead-9') }));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({ eligible: false })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));
const mockPdf = { copy: { attachments: [], payload: {} } };
jest.mock('../services/estimate-email-pdf', () => ({
  openEstimateEmailPdf: jest.fn(async () => mockPdf.copy),
}));
const mockBilling = { ctx: { billsPerApplication: true, livePricing: null } };
jest.mock('../services/estimate-proposal-billing', () => ({
  resolveProposalBillingContext: jest.fn(async () => mockBilling.ctx),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const EstimateFollowUp = require('../services/estimate-follow-up');
const { _private } = EstimateFollowUp;

const NOW = new Date('2026-06-10T15:00:00Z');
const H = 3600000;
const DAY = 24 * H;

const pestBundle = { frequencies: [{ key: 'quarterly', perTreatment: 94, visitsPerYear: 4, monthly: 31.33, annual: 376 }] };
const multiBundle = {
  combinedRecurring: { waveGuardDiscountPct: 0.1 },
  frequencies: [{
    key: 'quarterly', monthly: 72.3, annual: 867.6,
    perServiceTreatments: [
      { label: 'Lawn Care', service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 9, monthly: 42.3 },
      { label: 'Pest Control', service: 'pest_control', displayPrice: 90, visitsPerYear: 4, monthly: 30 },
    ],
  }],
  oneTimeBreakdown: { items: [{ kind: 'charge', service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup' }] },
};
const row = (overrides = {}) => ({
  id: 'est-1', status: 'sent', category: 'RESIDENTIAL', customer_id: 'cust-1', customer_name: 'Taylor Doe',
  customer_phone: '+19415550100', customer_email: 'taylor@example.com', token: 'tok-xyz', service_interest: 'Pest Control',
  address: '1 Main St', monthly_total: '31.33', annual_total: '376.00', onetime_total: '0',
  sent_at: new Date(NOW.getTime() - 30 * H), viewed_at: null, created_at: new Date(NOW.getTime() - 31 * H),
  expires_at: new Date(NOW.getTime() + 2 * DAY),
  estimate_data: { sendSnapshot: { pricingBundle: pestBundle } },
  ...overrides,
});
const multiRow = (overrides = {}) => row({
  service_interest: 'Lawn + Pest', monthly_total: '72.30', annual_total: '867.60', onetime_total: '99',
  estimate_data: { sendSnapshot: { pricingBundle: multiBundle } }, ...overrides,
});

let candidate; // the row the stage query returns, and the fresh read returns
let freshOverride;
let stageWanted;

function stageOf(calls) {
  const where = calls.filter((c) => c[0] === 'where');
  if (calls.some((c) => c[0] === 'whereBetween')) return 'expiring';
  const status = where.find((c) => c[1] && typeof c[1] === 'object' && c[1].status)?.[1].status;
  if (status === 'sent') return 'unviewed';
  if (status === 'viewed') {
    const lt = where.find((c) => c[1] === 'viewed_at' && c[2] === '<');
    const age = lt ? NOW.getTime() - new Date(lt[3]).getTime() : 0;
    return age > 4 * DAY ? 'final' : 'viewed';
  }
  return null;
}

function makeBuilder(table) {
  const calls = [];
  const b = {};
  for (const m of ['join', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereNot', 'where', 'whereBetween', 'select', 'groupBy', 'max', 'as', 'orderBy', 'orWhereNull', 'andWhere', 'whereNotExists', 'whereRaw']) {
    b[m] = jest.fn((...args) => { calls.push([m, ...args]); return b; });
  }
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.update = jest.fn(() => { b._mode = 'update'; return b; });
  b.then = (resolve, reject) => {
    let value;
    if (table !== 'estimates') value = b._mode === 'first' ? undefined : (b._mode === 'update' ? 1 : []);
    else if (b._mode === 'update') value = 1;
    else if (b._mode === 'first') value = freshOverride === undefined ? candidate : freshOverride;
    else value = stageOf(calls) === stageWanted ? [candidate] : [];
    return Promise.resolve(value).then(resolve, reject);
  };
  b.catch = (onRejected) => b.then(undefined, onRejected);
  return b;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(NOW);
  jest.clearAllMocks();
  mockGates.followup = true;
  mockGates.base = true;
  mockGates.months = false;
  mockBilling.ctx = { billsPerApplication: true, livePricing: null };
  mockPdf.copy = { attachments: [], payload: {} };
  mockTemplate.activeVersion = { id: 'ver-1', blocks: NOTE_BLOCKS, text_body: null };
  candidate = row();
  freshOverride = undefined;
  stageWanted = 'unviewed';
  db.mockImplementation((table) => makeBuilder(table));
});
afterEach(() => { jest.useRealTimers(); });

const STAGES = [
  ['unviewed', 'estimate.unviewed_followup', (r) => r],
  ['viewed', 'estimate.viewed_followup', (r) => ({ ...r, status: 'viewed', viewed_at: new Date(NOW.getTime() - 50 * H) })],
  ['final', 'estimate.followup_final', (r) => ({ ...r, status: 'viewed', viewed_at: new Date(NOW.getTime() - 5.5 * DAY) })],
  ['expiring', 'estimate.expiring_notice', (r) => r],
];

async function runStage(stage, mutate, makeRow = row) {
  stageWanted = stage;
  candidate = mutate(makeRow());
  EmailTemplates.sendTemplate.mockClear();
  await EstimateFollowUp.checkAll();
  return EmailTemplates.sendTemplate.mock.calls.map((c) => c[0]).find((a) => a.templateKey);
}

describe.each(STAGES)('%s stage (%s)', (stage, templateKey, mutate) => {
  test('single service: the price row carries the average and the context sentence rides in the note variable', async () => {
    const sent = await runStage(stage, mutate);
    expect(sent.templateKey).toBe(templateKey);
    expect(sent.payload.price_summary).toBe('$94.00 per application · $31.33 a month');
    expect(sent.payload.estimate_average_note).toBe('Averaged over the year. You pay after each application.');
  });

  test('multi service: plan average, bundle savings and the one-time setup wording', async () => {
    const sent = await runStage(stage, mutate, multiRow);
    expect(sent.payload.price_summary).toBe('Priced per application · plan averages $72.30 a month');
    expect(sent.payload.estimate_average_note).toBe('Averaged over the year, bundle savings included. You pay after each application. One-time setup $99.00, not in the average.');
  });

  test('gate off: the payload is the sender\'s own, with no average key and today\'s price line', async () => {
    mockGates.followup = false;
    const sent = await runStage(stage, mutate);
    expect(sent.payload.price_summary).toBe('Priced per application — full breakdown inside');
    expect(sent.payload).not.toHaveProperty('estimate_average_note');
  });

  test('the base average gate off also withholds it', async () => {
    mockGates.base = false;
    const sent = await runStage(stage, mutate);
    expect(sent.payload.price_summary).toBe('Priced per application — full breakdown inside');
    expect(sent.payload).not.toHaveProperty('estimate_average_note');
  });
});

describe('withMonthlyAverage: plans the delivery email leaves alone are left alone here', () => {
  const unchanged = async (est) => {
    const payload = _private.estimateEmailPayload(est, 'Taylor', 'https://x.test');
    freshOverride = est;
    const out = await _private.withMonthlyAverage(payload, est, 'estimate.unviewed_followup');
    expect(out).toBe(payload); // the very same object: byte-identical
  };

  test('commercial (category and the data marker on a residential-labelled draft), quote-required, closed rows', async () => {
    await unchanged(row({ category: 'COMMERCIAL' }));
    await unchanged(row({ estimate_data: { commercialEstimatedPricing: true, sendSnapshot: { pricingBundle: pestBundle } } }));
    await unchanged(row({ status: 'quote_required' }));
    await unchanged(row({ status: 'accepted' }));
    await unchanged(row({ status: 'declined' }));
  });

  test('annual prepay / monthly-billed (billing lane says not per application), one-time only, stale total', async () => {
    mockBilling.ctx = { billsPerApplication: false, livePricing: null };
    await unchanged(row());
    mockBilling.ctx = { billsPerApplication: true, livePricing: null };
    await unchanged(row({ monthly_total: '0', annual_total: '0', onetime_total: '250', estimate_data: {} }));
    await unchanged(row({ monthly_total: '40.00' }));
  });

  test('a failure resolving the average never blocks the follow-up: the payload is returned as built', async () => {
    const payload = _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test');
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    expect(await _private.withMonthlyAverage(payload, row(), 'estimate.unviewed_followup')).toBe(payload);
  });

  test('it reads the row now, not the candidate it was handed (a price edit since the stage query)', async () => {
    const payload = _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test');
    freshOverride = row({ monthly_total: '40.00' }); // no longer matches the lines
    expect(await _private.withMonthlyAverage(payload, row(), 'estimate.unviewed_followup')).toBe(payload);
  });
});

describe('withMonthlyAverage: only a template whose active version can show the note gets the average', () => {
  const KEY = 'estimate.unviewed_followup';
  const apply = async () => {
    const payload = _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test');
    freshOverride = row();
    return { payload, out: await _private.withMonthlyAverage(payload, row(), KEY) };
  };

  test('a template the migration skipped (no note block) keeps the original payload', async () => {
    mockTemplate.activeVersion = { id: 'ver-1', blocks: [NOTE_BLOCKS[0]], text_body: null };
    const { payload, out } = await apply();
    expect(out).toBe(payload);
    expect(out.price_summary).toBe('Priced per application — full breakdown inside');
  });

  test('a custom plain-text body that lacks the variable keeps the original payload', async () => {
    mockTemplate.activeVersion = { id: 'ver-1', blocks: NOTE_BLOCKS, text_body: 'Custom text. {{price_summary}}' };
    const { payload, out } = await apply();
    expect(out).toBe(payload);
  });

  test('a custom plain-text body that also carries the variable gets the average', async () => {
    mockTemplate.activeVersion = { id: 'ver-1', blocks: NOTE_BLOCKS, text_body: 'Custom text. {{price_summary}} {{estimate_average_note}}' };
    const { out } = await apply();
    expect(out.estimate_average_note).toBe('Averaged over the year. You pay after each application.');
  });

  test('a custom plain-text body that carries only one of the two tokens keeps the original payload', async () => {
    for (const text_body of ['Custom text. {{estimate_average_note}}', 'Custom text. {{price_summary}}']) {
      mockTemplate.activeVersion = { id: 'ver-1', blocks: NOTE_BLOCKS, text_body };
      const { payload, out } = await apply();
      expect(out).toBe(payload);
    }
  });

  test('a version whose blocks lack the price row (note only) or the note (price only) keeps the original payload', async () => {
    mockTemplate.activeVersion = { id: 'ver-1', blocks: [NOTE_BLOCKS[1]], text_body: null };
    let r = await apply();
    expect(r.out).toBe(r.payload);
    mockTemplate.activeVersion = { id: 'ver-1', blocks: [NOTE_BLOCKS[0]], text_body: null };
    r = await apply();
    expect(r.out).toBe(r.payload);
  });

  test('a blank text body and blocks stored as a JSON string still count as supported', async () => {
    mockTemplate.activeVersion = { id: 'ver-1', blocks: JSON.stringify(NOTE_BLOCKS), text_body: '  ' };
    const { out } = await apply();
    expect(out.price_summary).toBe('$94.00 per application · $31.33 a month');
  });

  test('no active version, a missing template or a loader failure keeps the original payload', async () => {
    const EmailTemplatesMock = require('../services/email-template-library');
    const payload = _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test');
    freshOverride = row();
    mockTemplate.activeVersion = null;
    expect(await _private.withMonthlyAverage(payload, row(), KEY)).toBe(payload);
    EmailTemplatesMock.loadTemplateByKey.mockResolvedValueOnce(null);
    expect(await _private.withMonthlyAverage(payload, row(), KEY)).toBe(payload);
    EmailTemplatesMock.loadTemplateByKey.mockRejectedValueOnce(new Error('library down'));
    expect(await _private.withMonthlyAverage(payload, row(), KEY)).toBe(payload);
  });

  test('through checkAll: a skipped expiring template sends the original price row', async () => {
    mockTemplate.activeVersion = { id: 'ver-1', blocks: [NOTE_BLOCKS[0]], text_body: null };
    const sent = await runStage('expiring', (r) => r);
    expect(sent.payload.price_summary).toBe('Priced per application — full breakdown inside');
    expect(sent.payload).not.toHaveProperty('estimate_average_note');
  });
});

describe('the send is pinned to the template version whose tokens were checked', () => {
  const pinnedSend = (calls) => calls.map((c) => c[0]).find((a) => a.templateKey);

  test.each(STAGES)('%s: versionId rides to sendTemplate when the average is applied', async (stage, templateKey, mutate) => {
    await runStage(stage, mutate);
    expect(pinnedSend(EmailTemplates.sendTemplate.mock.calls)).toMatchObject({ templateKey, versionId: 'ver-1' });
  });

  test.each(STAGES)('%s: no versionId key without the average (gate off)', async (stage, templateKey, mutate) => {
    mockGates.followup = false;
    await runStage(stage, mutate);
    expect(pinnedSend(EmailTemplates.sendTemplate.mock.calls)).not.toHaveProperty('versionId');
  });

  test('no versionId key when the template cannot show the note, or the plan gets no average', async () => {
    mockTemplate.activeVersion = { id: 'ver-1', blocks: [NOTE_BLOCKS[0]], text_body: null };
    await runStage('unviewed', (r) => r);
    expect(pinnedSend(EmailTemplates.sendTemplate.mock.calls)).not.toHaveProperty('versionId');
    mockTemplate.activeVersion = { id: 'ver-1', blocks: NOTE_BLOCKS, text_body: null };
    await runStage('unviewed', (r) => ({ ...r, category: 'COMMERCIAL' }));
    expect(pinnedSend(EmailTemplates.sendTemplate.mock.calls)).not.toHaveProperty('versionId');
  });

  test('withAverageEmail: the same spec object comes back unpinned; a supported one carries the id', async () => {
    freshOverride = row();
    const plain = { templateKey: 'estimate.unviewed_followup', stage: 'unviewed', payload: _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test') };
    const pinned = await _private.withAverageEmail(plain, row());
    expect(pinned).toMatchObject({ versionId: 'ver-1', stage: 'unviewed' });
    expect(pinned.payload.estimate_average_note).toBeTruthy();
    mockTemplate.activeVersion = null;
    expect(await _private.withAverageEmail(plain, row())).toBe(plain);
  });

  test('an admin publish after the check does not change the pinned id (the loader now answers ver-2)', async () => {
    freshOverride = row();
    const plain = { templateKey: 'estimate.unviewed_followup', stage: 'unviewed', payload: _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test') };
    const pinned = await _private.withAverageEmail(plain, row());
    mockTemplate.activeVersion = { id: 'ver-2', blocks: [], text_body: null }; // published afterwards, no tokens
    EmailTemplates.sendTemplate.mockClear();
    await _private.sendDualChannel(row(), { sms: null, email: pinned });
    expect(pinnedSend(EmailTemplates.sendTemplate.mock.calls)).toMatchObject({ versionId: 'ver-1' });
  });
});

describe('send-time check: the average is re-read at the provider boundary', () => {
  const KEY = 'estimate.unviewed_followup';
  const pinned = async () => {
    freshOverride = row();
    return _private.withAverageEmail(
      { templateKey: KEY, stage: 'unviewed', payload: _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test') },
      row(),
    );
  };
  // Hands the library's dispatch to the handoff the follow-up installed and returns the check it was given.
  const checkOf = async (handoff) => {
    let check;
    const verdict = await handoff(async (_database, providerCheck) => { check = providerCheck; });
    expect(verdict).toEqual({ ok: true });
    return check;
  };
  const installedHandoff = async (email) => {
    EmailTemplates.sendTemplate.mockClear();
    await _private.sendDualChannel(row(), { sms: null, email });
    return EmailTemplates.sendTemplate.mock.calls[0][0].withProviderHandoff;
  };

  test('the email spec records the exact copy it carries; an unpinned email installs no handoff', async () => {
    const email = await pinned();
    expect(email.averageText).toBe('$94.00 per application · $31.33 a month\nAveraged over the year. You pay after each application.');
    mockGates.followup = false;
    const plain = { templateKey: KEY, stage: 'unviewed', payload: { first_name: 'T' } };
    expect(await installedHandoff(await _private.withAverageEmail(plain, row()))).toBeUndefined();
  });

  test('unchanged row: the check passes (PDF gate off)', async () => {
    const check = await checkOf(await installedHandoff(await pinned()));
    freshOverride = row();
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
  });

  test('a price edit between build and handoff vetoes the send (PDF gate off)', async () => {
    const check = await checkOf(await installedHandoff(await pinned()));
    freshOverride = row({ estimate_data: { sendSnapshot: { pricingBundle: { frequencies: [{ key: 'quarterly', perTreatment: 99, visitsPerYear: 4, monthly: 33, annual: 396 }] } } }, monthly_total: '33.00' });
    await expect(check({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'monthly_average_changed' });
  });

  test('the estimate turning ineligible (accepted) or disappearing vetoes it', async () => {
    const check = await checkOf(await installedHandoff(await pinned()));
    freshOverride = row({ status: 'accepted' });
    await expect(check()).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'monthly_average_changed' });
    freshOverride = null;
    await expect(check()).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'monthly_average_changed' });
  });

  test('a read failure is a retryable check failure, not a veto', async () => {
    const check = await checkOf(await installedHandoff(await pinned()));
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(check()).rejects.toMatchObject({ providerBoundaryCheckFailed: true });
    freshOverride = row();
    await expect(check()).resolves.toEqual({ ok: true }); // the next sweep's check passes again
  });

  test('with the PDF fence both run, the PDF fence first; a PDF veto or a price edit each stops the send', async () => {
    const pdfCheck = jest.fn(async () => ({ ok: true }));
    const pdfHandoff = jest.fn(async (dispatch) => { await dispatch(undefined, pdfCheck); return { ok: true }; });
    mockPdf.copy = { attachments: [], payload: {}, withProviderHandoff: pdfHandoff };
    const check = await checkOf(await installedHandoff(await pinned()));
    expect(pdfHandoff).toHaveBeenCalledTimes(1);

    freshOverride = row();
    await expect(check()).resolves.toEqual({ ok: true });
    expect(pdfCheck).toHaveBeenCalledTimes(1);

    pdfCheck.mockRejectedValueOnce(Object.assign(new Error('pdf veto'), { providerBoundaryBlocked: true, reason: 'estimate_changed_since_render' }));
    await expect(check()).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'estimate_changed_since_render' });

    freshOverride = row({ monthly_total: '40.00' });
    await expect(check()).rejects.toMatchObject({ reason: 'monthly_average_changed' });
  });

  test('a PDF-only email (no average) keeps the PDF handoff untouched', async () => {
    const pdfHandoff = jest.fn(async (dispatch) => { await dispatch(); return { ok: true }; });
    mockPdf.copy = { attachments: [], payload: {}, withProviderHandoff: pdfHandoff };
    mockGates.followup = false;
    const email = { templateKey: KEY, stage: 'unviewed', payload: { first_name: 'T' } };
    expect(await installedHandoff(await _private.withAverageEmail(email, row()))).toBe(pdfHandoff);
  });

  test('a vetoed send (no text went out) takes the existing abort path: counters stay, the stage claim is released', async () => {
    require('../routes/admin-sms-templates').getTemplate.mockResolvedValueOnce(null);
    stageWanted = 'unviewed';
    candidate = row();
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: false, aborted: true, boundaryBlocked: true, reason: 'provider_boundary_blocked' });
    await EstimateFollowUp.checkAll();
    const updates = db.mock.results.map((r) => r.value).flatMap((b) => b?.update?.mock?.calls || []).map((c) => c[0]);
    expect(updates.some((u) => u && u.follow_up_count)).toBe(false);
    expect(updates).toContainEqual({ followup_unviewed_sent: false });
  });

  test('the stored row is marked off the retry rails only when the average is in it', async () => {
    const withAverage = await pinned();
    EmailTemplates.sendTemplate.mockClear();
    await _private.sendDualChannel(row(), { sms: null, email: withAverage });
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].categories).toEqual([
      'estimate_followup', 'estimate_followup_unviewed', 'estimate_followup_monthly_average',
    ]);
    mockGates.followup = false;
    EmailTemplates.sendTemplate.mockClear();
    const plain = await _private.withAverageEmail({ templateKey: KEY, stage: 'unviewed', payload: { first_name: 'T' } }, row());
    await _private.sendDualChannel(row(), { sms: null, email: plain });
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].categories).toEqual(['estimate_followup', 'estimate_followup_unviewed']);
  });

  test.each([
    ['a thrown provider rejection', () => EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('SendGrid 400'), { status: 400 }))],
    ['a rejected result row', () => EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: false, aborted: false, reason: 'provider_rejected' })],
  ])('sendDualChannel with no text reports not attempted on %s, so the stage claim is released for the next sweep', async (_name, arrange) => {
    arrange();
    const email = await pinned();
    expect(await _private.sendDualChannel(row(), { sms: null, email })).toBe(false);
  });

  test('through checkAll: a provider rejection with no text releases the stage and bumps no counter', async () => {
    require('../routes/admin-sms-templates').getTemplate.mockResolvedValueOnce(null);
    stageWanted = 'unviewed';
    candidate = row();
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('SendGrid 400'), { status: 400 }));
    await EstimateFollowUp.checkAll();
    const updates = db.mock.results.map((r) => r.value).flatMap((b) => b?.update?.mock?.calls || []).map((c) => c[0]);
    expect(updates.some((u) => u && u.follow_up_count)).toBe(false);
    expect(updates).toContainEqual({ followup_unviewed_sent: false });
    // The next sweep sends the touch again under the same idempotency key (fresh copy),
    // because the rails above never re-send the marked stored row.
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true });
    await EstimateFollowUp.checkAll();
    expect(EmailTemplates.sendTemplate.mock.calls.filter((c) => c[0].templateKey).map((c) => c[0].idempotencyKey)).toEqual([
      'estimate_followup_unviewed:est-1', 'estimate_followup_unviewed:est-1',
    ]);
  });
});

describe('application months (GATE_ESTIMATE_APPLICATION_MONTHS) in the follow-ups', () => {
  const KEY = 'estimate.unviewed_followup';
  const BREAKDOWN = 'Months with Pest Control (4 a year): $189.90. Other months (8 a year): $74.70, Mosquito only.';
  const pestMosquitoBundle = {
    combinedRecurring: { waveGuardDiscountPct: 0.1 },
    frequencies: [{
      key: 'quarterly', monthly: 113.1, annual: 1357.2,
      perServiceTreatments: [
        { label: 'Pest Control', service: 'pest_control', displayPrice: 115.2, visitsPerYear: 4, monthly: 38.4 },
        { label: 'Mosquito', service: 'mosquito', displayPrice: 74.7, visitsPerYear: 12, monthly: 74.7 },
      ],
    }],
  };
  const est1185 = (overrides = {}) => row({
    service_interest: 'Pest + Mosquito', monthly_total: '113.10', annual_total: '1357.20', onetime_total: '0',
    estimate_data: { sendSnapshot: { pricingBundle: pestMosquitoBundle } }, ...overrides,
  });

  test.each(STAGES)('%s: EST-2026-1185 shows the plan average in the row and the two month amounts in the note', async (stage, templateKey, mutate) => {
    mockGates.months = true;
    const sent = await runStage(stage, mutate, est1185);
    expect(sent.templateKey).toBe(templateKey);
    expect(sent.payload.price_summary).toBe('Priced per application · plan averages $113.10 a month');
    expect(sent.payload.estimate_average_note).toBe(`${BREAKDOWN} Averaged over the year, bundle savings included. You pay after each application.`);
  });

  test('months gate off: the same plan reads as the monthly-average follow-up did', async () => {
    const sent = await runStage('unviewed', (r) => r, est1185);
    expect(sent.payload.estimate_average_note).toBe('Averaged over the year, bundle savings included. You pay after each application.');
  });

  test('plans the breakdown does not cover are unchanged with the gate on', async () => {
    mockGates.months = true;
    const sent = await runStage('unviewed', (r) => r);
    expect(sent.payload.price_summary).toBe('$94.00 per application · $31.33 a month');
    expect(sent.payload.estimate_average_note).toBe('Averaged over the year. You pay after each application.');
  });

  test('the send-time check compares the same text: it passes unchanged and vetoes when the gate flips off in between', async () => {
    mockGates.months = true;
    freshOverride = est1185();
    const email = await _private.withAverageEmail(
      { templateKey: KEY, stage: 'unviewed', payload: _private.estimateEmailPayload(est1185(), 'Taylor', 'https://x.test') },
      est1185(),
    );
    expect(email.averageText).toContain(BREAKDOWN);
    EmailTemplates.sendTemplate.mockClear();
    await _private.sendDualChannel(est1185(), { sms: null, email });
    const check = await (async () => {
      let c;
      await EmailTemplates.sendTemplate.mock.calls[0][0].withProviderHandoff(async (_d, providerCheck) => { c = providerCheck; });
      return c;
    })();
    freshOverride = est1185();
    await expect(check()).resolves.toEqual({ ok: true });
    mockGates.months = false;
    await expect(check()).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'monthly_average_changed' });
  });
});
