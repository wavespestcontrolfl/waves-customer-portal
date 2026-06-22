jest.mock('../services/seo/link-prospect-worker', () => ({
  claim: jest.fn(),
  report: jest.fn(async () => ({ ok: true })),
  releaseClaims: jest.fn(async () => ({ released: 0 })),
  businessProfile: () => ({ brand: 'Waves Pest Control', website: 'https://wavespestcontrol.com', contact_email: 'contact@wavespestcontrol.com', default_location_id: 'bradenton', locations: [{ id: 'bradenton', name: 'Bradenton, FL', address: '13649 Luxe Ave #110, Bradenton, FL 34211', phone: '(941) 318-7612' }] }),
}));
jest.mock('../services/seo/browser-form-filler', () => ({ fillCitationForm: jest.fn() }));
jest.mock('../services/seo/signup-evidence', () => ({ uploadEvidence: jest.fn(async () => 'backlink-evidence/x.png') }));

// Minimal knex-ish mock: db('table').insert(...) and db('table').where(...).update(...)
// (jest.mock factories may only reference `mock`-prefixed outer variables.)
const mockUpdate = jest.fn(async () => 1);
const mockInsert = jest.fn(async () => [1]);
jest.mock('../models/db', () => jest.fn(() => ({ insert: mockInsert, where: jest.fn(() => ({ update: mockUpdate })) })));

const worker = require('../services/seo/link-prospect-worker');
const { fillCitationForm } = require('../services/seo/browser-form-filler');
const runner = require('../services/seo/signup-runner');
const { buildNap, parseAddress } = runner._internals;

const prospect = (o = {}) => ({ id: 'p1', target_domain: 'citysquares.com', target_url: 'https://citysquares.com/add', offered_link_rel: 'nofollow', lease_token: '2026-06-22T00:00:00.000Z', ...o });

beforeEach(() => {
  worker.claim.mockReset(); worker.report.mockReset(); worker.report.mockResolvedValue({ ok: true });
  worker.releaseClaims.mockReset(); worker.releaseClaims.mockResolvedValue({ released: 0 });
  fillCitationForm.mockReset(); mockUpdate.mockClear(); mockInsert.mockClear();
});

describe('buildNap / parseAddress', () => {
  test('parses the canonical address line into structured fields', () => {
    expect(parseAddress('13649 Luxe Ave #110, Bradenton, FL 34211')).toEqual({ street: '13649 Luxe Ave #110', city: 'Bradenton', state: 'FL', zip: '34211' });
  });
  test('assembles NAP from the business profile default location', () => {
    const nap = buildNap(worker.businessProfile());
    expect(nap).toMatchObject({ business_name: 'Waves Pest Control', phone: '(941) 318-7612', address: { city: 'Bradenton', zip: '34211' } });
  });
});

describe('run — safety gates', () => {
  test('live run with NO allowlist refuses to submit', async () => {
    const r = await runner.run({ dryRun: false, allow: [] });
    expect(r.note).toBe('no_allowlist');
    expect(worker.claim).not.toHaveBeenCalled();
  });
  test('claims only submit_free signup prospects', async () => {
    worker.claim.mockResolvedValue([]);
    await runner.run({ dryRun: true, allow: ['citysquares.com'] });
    expect(worker.claim).toHaveBeenCalledWith({ n: 5, type: 'signup', automationPolicy: 'submit_free' });
  });
  test('dry-run previews + releases, never submits', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    const r = await runner.run({ dryRun: true, allow: ['citysquares.com'] });
    expect(fillCitationForm).not.toHaveBeenCalled();
    expect(worker.releaseClaims).toHaveBeenCalledWith([{ id: 'p1', lease_token: '2026-06-22T00:00:00.000Z' }]);
    expect(r.samples[0]).toMatchObject({ domain: 'citysquares.com' });
  });
  test('non-allowlisted claimed prospects are released, not submitted', async () => {
    worker.claim.mockResolvedValue([prospect({ id: 'p2', target_domain: 'notallowed.com' })]);
    await runner.run({ allow: ['citysquares.com'] });
    expect(fillCitationForm).not.toHaveBeenCalled();
    expect(worker.releaseClaims).toHaveBeenCalledWith([{ id: 'p2', lease_token: '2026-06-22T00:00:00.000Z' }]);
  });
});

describe('run — outcomes', () => {
  test('placed → reports placed + writes a ledger row', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    fillCitationForm.mockResolvedValue({ outcome: 'placed', liveUrl: 'https://citysquares.com/biz/waves', pending: false, screenshot: Buffer.from('png') });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.placed).toBe(1);
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'placed', live_url: 'https://citysquares.com/biz/waves', evidence_url: 'backlink-evidence/x.png' }));
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'placed', mode: 'auto' }));
  });
  test('blocked_captcha → RECLASSIFIES (needs_account) + releases, no retry report', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    fillCitationForm.mockResolvedValue({ outcome: 'blocked_captcha', errorCode: 'blocked_captcha', screenshot: Buffer.from('png') });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.blocked).toBe(1);
    expect(worker.report).not.toHaveBeenCalled(); // not a retryable failure
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ automation_policy: 'needs_account', requires_captcha: true, claimed_at: null }));
  });
  test('engine failure → reports failed (retryable)', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    fillCitationForm.mockResolvedValue({ outcome: 'failed', errorCode: 'engine_error' });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.failed).toBe(1);
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });
});
