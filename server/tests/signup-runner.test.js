jest.mock('../services/seo/link-prospect-worker', () => ({
  claim: jest.fn(),
  report: jest.fn(async () => ({ ok: true })),
  releaseClaims: jest.fn(async () => ({ released: 0 })),
  businessProfile: () => ({ brand: 'Waves Pest Control', website: 'https://wavespestcontrol.com', contact_email: 'contact@wavespestcontrol.com', default_location_id: 'bradenton', locations: [{ id: 'bradenton', name: 'Bradenton, FL', address: '13649 Luxe Ave #110, Bradenton, FL 34211', phone: '(941) 318-7612' }] }),
}));
jest.mock('../services/seo/browser-form-filler', () => ({ fillCitationForm: jest.fn() }));
jest.mock('../services/seo/signup-evidence', () => ({ uploadEvidence: jest.fn(async () => 'backlink-evidence/x.png') }));
// Stub the SSRF helpers so URL validation is deterministic + offline (no real DNS).
// Shape/host rejections in validateSubmitUrl happen BEFORE these are consulted.
jest.mock('../services/seo/contact-finder', () => ({ _internals: { isBlockedHostname: () => false, hostResolvesPublic: async () => true } }));

// Minimal knex-ish mock: db('table').insert(...) and db('table').where(...).update(...)
// (jest.mock factories may only reference `mock`-prefixed outer variables.)
const mockUpdate = jest.fn(async () => 1);
const mockInsert = jest.fn(async () => [1]);
jest.mock('../models/db', () => jest.fn(() => ({ insert: mockInsert, where: jest.fn(() => ({ update: mockUpdate })) })));

const worker = require('../services/seo/link-prospect-worker');
const { fillCitationForm } = require('../services/seo/browser-form-filler');
const runner = require('../services/seo/signup-runner');
const { buildNap, parseAddress, validateSubmitUrl } = runner._internals;

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

describe('validateSubmitUrl (SSRF/host guard)', () => {
  test('accepts an http(s) URL whose host equals the allowlisted domain', async () => {
    expect(await validateSubmitUrl('https://citysquares.com/add', 'citysquares.com')).toBe('https://citysquares.com/add');
  });
  test('rejects a URL whose host differs from the allowlisted domain', async () => {
    expect(await validateSubmitUrl('https://evil.com/add', 'citysquares.com')).toBeNull();
  });
  test('rejects non-http(s) schemes (file:, data:)', async () => {
    expect(await validateSubmitUrl('file:///etc/passwd', 'citysquares.com')).toBeNull();
    expect(await validateSubmitUrl('data:text/html,x', 'citysquares.com')).toBeNull();
  });
  test('rejects garbage / empty', async () => {
    expect(await validateSubmitUrl('not a url', 'citysquares.com')).toBeNull();
    expect(await validateSubmitUrl('', 'citysquares.com')).toBeNull();
  });
});

describe('run — safety gates', () => {
  test('live run with NO allowlist refuses to submit', async () => {
    const r = await runner.run({ dryRun: false, allow: [] });
    expect(r.note).toBe('no_allowlist');
    expect(worker.claim).not.toHaveBeenCalled();
  });
  test('dry-run claims all submit_free (no domain filter)', async () => {
    worker.claim.mockResolvedValue([]);
    await runner.run({ dryRun: true, allow: ['citysquares.com'] });
    expect(worker.claim).toHaveBeenCalledWith({ n: 5, type: 'signup', automationPolicy: 'submit_free' });
  });
  test('live run pushes the allowlist into the claim query', async () => {
    worker.claim.mockResolvedValue([]);
    await runner.run({ dryRun: false, allow: ['citysquares.com'] });
    expect(worker.claim).toHaveBeenCalledWith({ n: 5, type: 'signup', automationPolicy: 'submit_free', domains: ['citysquares.com'] });
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
  test('target_url whose host ≠ allowlisted domain is PARKED (skip), never navigated', async () => {
    // allowlist passes on target_domain, but the stored target_url points elsewhere.
    worker.claim.mockResolvedValue([prospect({ target_url: 'https://evil.com/add' })]);
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(fillCitationForm).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ automation_policy: 'skip', claimed_at: null }));
    expect(worker.report).not.toHaveBeenCalled();
  });
  test('placed with NO live_url → reported as pending (never a stranded placement)', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    fillCitationForm.mockResolvedValue({ outcome: 'placed', liveUrl: null, pending: false, screenshot: Buffer.from('png') });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.placed).toBe(1);
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'placed', live_url: null, pending: true }));
  });
  test('a rejected placed report (e.g. stale lease) counts as failed, not placed', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    worker.report.mockResolvedValue({ ok: false, code: 'stale_lease' });
    fillCitationForm.mockResolvedValue({ outcome: 'placed', liveUrl: 'https://citysquares.com/biz/waves', pending: false, screenshot: Buffer.from('png') });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.placed).toBe(0);
    expect(r.failed).toBe(1);
  });
});
