jest.mock('../services/seo/link-prospect-worker', () => ({
  claim: jest.fn(),
  report: jest.fn(async () => ({ ok: true })),
  releaseClaims: jest.fn(async () => ({ released: 0 })),
  settleReleasedPlacements: jest.fn(async () => 0),
  businessProfile: () => ({ brand: 'Waves Pest Control', website: 'https://wavespestcontrol.com', contact_email: 'contact@wavespestcontrol.com', default_location_id: 'bradenton', locations: [
    { id: 'bradenton', name: 'Bradenton, FL', address: '13649 Luxe Ave #110, Bradenton, FL 34211', phone: '(941) 318-7612' },
    { id: 'sarasota', name: 'Sarasota, FL', address: '100 Main St, Sarasota, FL 34236', phone: '(941) 555-2000' },
  ] }),
}));
jest.mock('../services/seo/browser-form-filler', () => ({ fillCitationForm: jest.fn() }));
// v2 step 1: run() starts with the idempotent legacy-attempts catch-up (expand/contract).
jest.mock('../services/seo/link-registry-backfill', () => ({ backfillLegacyAttempts: jest.fn(async () => ({ copied: 0, scanned: 0 })), backfillLegacyBoard: jest.fn(async () => ({})) }));
jest.mock('../services/seo/signup-evidence', () => ({ uploadEvidence: jest.fn(async () => 'backlink-evidence/x.png') }));
// Stub the SSRF helpers so URL validation is deterministic + offline (no real DNS).
// Shape/host rejections in validateSubmitUrl happen BEFORE these are consulted.
jest.mock('../services/seo/contact-finder', () => ({ _internals: { isBlockedHostname: () => false, hostResolvesPublic: async () => true } }));

// Minimal knex-ish mock. Supports the three chains the runner uses:
//  - db('t').insert(...)                                         (recordAttempt)
//  - db('t').where({id}).where('claimed_at', lease).update(...)  (leaseGuardedReclassify)
//  - db('t').whereIn(...).whereRaw(...).whereRaw(...).first()    (alreadyPlacedAt)
// alreadyPlacedAt is answered from an in-memory placement registry (mockPlaced) that
// worker.report populates on a 'placed' report — faithfully simulating the durable DB
// placement the real report writes, so the in-batch + cross-run de-dupe is exercised
// end-to-end. mockQueryKey captures the (domain, location) the last alreadyPlacedAt
// filtered on, so the following placed report records exactly that key.
// (jest.mock factories may only reference `mock`-prefixed outer variables.)
const mockUpdate = jest.fn(async () => 1);
const mockInsert = jest.fn(async () => [1]);
const mockWhere = jest.fn();
const mockPlaced = new Set();
const mockQueryKey = { domain: null, location: null, last: null };
jest.mock('../models/db', () => {
  const builder = {
    insert: mockInsert,
    update: mockUpdate,
    whereIn: () => builder,
    whereRaw: (sql, bindings) => {
      const v = Array.isArray(bindings) ? bindings[0] : undefined;
      if (/target_domain/.test(sql)) mockQueryKey.domain = v;
      else if (/location/.test(sql)) mockQueryKey.location = v;
      return builder;
    },
    first: async () => {
      mockQueryKey.last = `${mockQueryKey.domain}|${mockQueryKey.location}`;
      return mockPlaced.has(mockQueryKey.last) ? { id: 'existing' } : undefined;
    },
  };
  mockWhere.mockImplementation(() => builder); // chainable: .where(...).where(...)
  builder.where = mockWhere;
  const fn = jest.fn(() => builder);
  fn.raw = (sql, bindings) => ({ sql, bindings });
  fn.transaction = async (cb) => cb(fn); // reclassify releases + settles in one transaction
  return fn;
});

const worker = require('../services/seo/link-prospect-worker');
worker.SIGNUP_TYPES = ['directory', 'citation', 'social'];
const { fillCitationForm } = require('../services/seo/browser-form-filler');
const runner = require('../services/seo/signup-runner');
const { buildNap, parseAddress, validateSubmitUrl, leaseGuardedReclassify, LOCATION_MATCH_SQL } = runner._internals;

describe('alreadyPlacedAt location predicate (v2 identity)', () => {
  test('identity is location_key alone — the step-1 rolling-deploy fallback on quality_signals.location is gone (step 2 backfilled it)', () => {
    const knex = require('knex')({ client: 'pg' });
    const c = knex('seo_link_prospects').whereRaw(LOCATION_MATCH_SQL, ['bradenton']).toSQL().toNative();
    expect(c.bindings).toEqual(['bradenton']);
    expect(c.sql).toMatch(/location_key = \$1$/);
    expect(c.sql).not.toMatch(/quality_signals/);
  });
});

const prospect = (o = {}) => ({ id: 'p1', link_type: 'directory', target_domain: 'citysquares.com', target_url: 'https://citysquares.com/add', offered_link_rel: 'nofollow', lease_token: '2026-06-22T00:00:00.000Z', ...o });

beforeEach(() => {
  worker.claim.mockReset(); worker.report.mockReset();
  // A 'placed' report stores the reported location_key in the real worker;
  // mirror that into the placement registry so the next prospect's alreadyPlacedAt sees it.
  worker.report.mockImplementation(async (body) => {
    if (body && body.outcome === 'placed' && body.location) mockPlaced.add(`${mockQueryKey.domain}|${body.location}`);
    return { ok: true };
  });
  worker.releaseClaims.mockReset(); worker.releaseClaims.mockResolvedValue({ released: 0 });
  fillCitationForm.mockReset(); mockUpdate.mockClear(); mockInsert.mockClear(); mockWhere.mockClear();
  mockUpdate.mockResolvedValue(1);
  mockPlaced.clear(); mockQueryKey.domain = null; mockQueryKey.location = null; mockQueryKey.last = null;
});

describe('leaseGuardedReclassify (optimistic lease guard)', () => {
  test('updates with the lease (claimed_at) guard + clears the lease', async () => {
    const n = await leaseGuardedReclassify({ id: 'p1', lease_token: '2026-06-22T00:00:00.000Z', target_domain: 'x.com' }, { automation_policy: 'skip' });
    // .where({id}).where('claimed_at', <lease date>).update(...)
    expect(mockWhere).toHaveBeenCalledWith('claimed_at', new Date('2026-06-22T00:00:00.000Z'));
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ automation_policy: 'skip', claimed_at: null, claimed_by: null, leased_provider: null, lease_mode: null }));
    expect(n).toBe(1);
    // a reclassify IS a lease release: the placement settles onto its live path (Codex PR #3687 r29 P1)
    expect(require('../services/seo/link-prospect-worker').settleReleasedPlacements).toHaveBeenCalledWith(['p1'], expect.anything()); // inside the release transaction
  });
  test('no-op (returns 0, no DB write) without a valid lease_token', async () => {
    const n = await leaseGuardedReclassify({ id: 'p1', lease_token: 'not-a-date' }, { automation_policy: 'skip' });
    expect(n).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
  test('0 rows updated (row reclaimed) is surfaced as stale (returns 0)', async () => {
    mockUpdate.mockResolvedValueOnce(0);
    const n = await leaseGuardedReclassify({ id: 'p1', lease_token: '2026-06-22T00:00:00.000Z', target_domain: 'x.com' }, { automation_policy: 'skip' });
    expect(n).toBe(0);
  });
});

describe('buildNap / parseAddress', () => {
  test('parses the canonical address line into structured fields', () => {
    expect(parseAddress('13649 Luxe Ave #110, Bradenton, FL 34211')).toEqual({ street: '13649 Luxe Ave #110', city: 'Bradenton', state: 'FL', zip: '34211' });
  });
  test('assembles NAP from the default (primary) location when no prospect / no match', () => {
    const nap = buildNap(worker.businessProfile());
    expect(nap).toMatchObject({ business_name: 'Waves Pest Control', phone: '(941) 318-7612', address: { city: 'Bradenton', zip: '34211' } });
  });
  test('picks the per-location NAP when the prospect page maps to a GBP city', () => {
    const nap = buildNap(worker.businessProfile(), { target_page: 'https://wavespestcontrol.com/pest-control-sarasota-fl', target_domain: 'citysquares.com' });
    expect(nap).toMatchObject({ phone: '(941) 555-2000', address: { city: 'Sarasota', zip: '34236' } });
    expect(nap.website).toBe('https://wavespestcontrol.com'); // always the homepage for citations
  });
  test('falls back to the primary NAP when the prospect maps to no known city', () => {
    const nap = buildNap(worker.businessProfile(), { target_page: 'https://wavespestcontrol.com/', target_domain: 'citysquares.com' });
    expect(nap.address.city).toBe('Bradenton');
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

jest.mock('../services/seo/link-execution-authority', () => ({ releaseSlots: jest.fn(async () => {}), beginSubmission: jest.fn(async () => true) }));

describe('run — safety gates', () => {
  test('without a domain filter, the authority claim decides whether any work is allowed', async () => {
    worker.claim.mockResolvedValueOnce([]);
    const r = await runner.run({ dryRun: false, allow: [] });
    expect(r.claimed).toBe(0);
    expect(worker.claim).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deterministic_runner', mode: 'acquire' }));
  });
  test('dry-run skips both registry catch-ups (no writes of any kind); a live run performs board→registry, then attempts, BEFORE claiming', async () => {
    const { backfillLegacyAttempts, backfillLegacyBoard } = require('../services/seo/link-registry-backfill');
    backfillLegacyAttempts.mockClear(); backfillLegacyBoard.mockClear();
    worker.claim.mockResolvedValue([]);
    await runner.run({ dryRun: true, allow: ['citysquares.com'] });
    expect(backfillLegacyAttempts).not.toHaveBeenCalled();
    expect(backfillLegacyBoard).not.toHaveBeenCalled();
    await runner.run({ dryRun: false, allow: ['citysquares.com'] });
    expect(backfillLegacyBoard).toHaveBeenCalledTimes(1);
    expect(backfillLegacyAttempts).toHaveBeenCalledTimes(1);
    expect(backfillLegacyBoard.mock.invocationCallOrder[0]).toBeLessThan(backfillLegacyAttempts.mock.invocationCallOrder[0]);
    expect(backfillLegacyAttempts.mock.invocationCallOrder[0]).toBeLessThan(worker.claim.mock.invocationCallOrder.at(-1));
    // the attempt row carries the prospect's path (linked by the catch-up above)
    expect(runner._internals.attemptRowFor({ id: 'p', path_id: 'path-9' }, { outcome: 'blocked_phone_verification' }, null)).toMatchObject({ path_id: 'path-9', outcome: 'needs_owner' });
  });
  test('a failing board→registry catch-up ABORTS the run before any claim (no unlinked prospect is ever submitted)', async () => {
    const { backfillLegacyAttempts, backfillLegacyBoard } = require('../services/seo/link-registry-backfill');
    backfillLegacyAttempts.mockClear(); backfillLegacyBoard.mockClear();
    backfillLegacyBoard.mockRejectedValueOnce(new Error('boom'));
    const r = await runner.run({ dryRun: false, allow: ['citysquares.com'] });
    expect(r).toEqual({ claimed: 0, placed: 0, blocked: 0, failed: 0, skipped: 0, aborted: 'registry_catchup_failed' });
    expect(worker.claim).not.toHaveBeenCalled();
    expect(backfillLegacyAttempts).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    // an attempts catch-up failure only logs
    backfillLegacyAttempts.mockRejectedValueOnce(new Error('boom'));
    worker.claim.mockResolvedValue([]);
    await expect(runner.run({ dryRun: false, allow: ['citysquares.com'] })).resolves.toMatchObject({ claimed: 0 });
    expect(worker.claim).toHaveBeenCalledTimes(1);
  });
  test('dry-run uses a READ-ONLY preview claim (no lease/write)', async () => {
    worker.claim.mockResolvedValue([]);
    await runner.run({ dryRun: true, allow: ['citysquares.com'] });
    expect(worker.claim).toHaveBeenCalledWith({ n: 5, type: 'signup', provider: 'deterministic_runner', mode: 'acquire', preview: true, domains: ['citysquares.com'] });
  });
  test('live run pushes the allowlist into the claim query', async () => {
    worker.claim.mockResolvedValue([]);
    await runner.run({ dryRun: false, allow: ['citysquares.com'] });
    expect(worker.claim).toHaveBeenCalledWith({ n: 5, type: 'signup', provider: 'deterministic_runner', mode: 'acquire', preview: false, domains: ['citysquares.com'] });
  });
  test('dry-run previews, never submits, and never leases/releases (no writes)', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    const r = await runner.run({ dryRun: true, allow: ['citysquares.com'] });
    expect(fillCitationForm).not.toHaveBeenCalled();
    expect(worker.releaseClaims).not.toHaveBeenCalled(); // preview rows aren't leased → nothing to release
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(r.samples[0]).toMatchObject({ domain: 'citysquares.com' });
  });
  test('non-allowlisted claimed prospects are released, not submitted', async () => {
    worker.claim.mockResolvedValue([prospect({ id: 'p2', target_domain: 'notallowed.com' })]);
    await runner.run({ allow: ['citysquares.com'] });
    expect(fillCitationForm).not.toHaveBeenCalled();
    expect(worker.releaseClaims).toHaveBeenCalledWith([{ id: 'p2', lease_token: '2026-06-22T00:00:00.000Z' }]);
  });
  test('de-dupes same directory + SAME location → submit one, PARK the durable duplicate (skip)', async () => {
    worker.claim.mockResolvedValue([
      prospect({ id: 'p1', target_page: 'https://wavespestcontrol.com/a' }),
      prospect({ id: 'p2', target_page: 'https://wavespestcontrol.com/b' }), // same citysquares.com, both → primary location
    ]);
    fillCitationForm.mockResolvedValue({ outcome: 'placed', liveUrl: null, pending: true, screenshot: Buffer.from('png') });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(fillCitationForm).toHaveBeenCalledTimes(1); // only the first (domain, location) submits
    expect(r.placed).toBe(1);
    expect(r.skipped).toBe(1); // the durable duplicate is parked (reclassified skip), never resubmitted
    // p2 is reclassified to skip (so it's never re-claimed) + a skipped attempt is logged
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ automation_policy: 'skip', claimed_at: null }));
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'skipped', provider: 'deterministic_runner', detail: expect.stringContaining('"error_code":"duplicate_placement"') }));
  });
  test('same directory, DIFFERENT locations → both submit (per-location listings are allowed)', async () => {
    worker.claim.mockResolvedValue([
      prospect({ id: 'p3', target_page: 'https://wavespestcontrol.com/pest-control-sarasota-fl' }), // → Sarasota
      prospect({ id: 'p4', target_page: 'https://wavespestcontrol.com/' }),                          // → primary (Bradenton)
    ]);
    fillCitationForm.mockResolvedValue({ outcome: 'placed', liveUrl: null, pending: true, screenshot: Buffer.from('png') });
    await runner.run({ allow: ['citysquares.com'] });
    expect(fillCitationForm).toHaveBeenCalledTimes(2); // two distinct (domain, location) placements → both submitted
  });
});

describe('run — outcomes', () => {
  test('placed reports through the provider-bound lease without inserting a second submit attempt', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    fillCitationForm.mockResolvedValue({ outcome: 'placed', liveUrl: 'https://citysquares.com/biz/waves', pending: false, screenshot: Buffer.from('png') });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.placed).toBe(1);
    await fillCitationForm.mock.calls[0][1].beforeSubmit();
    expect(require('../services/seo/link-execution-authority').beginSubmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ citation: { website: 'https://wavespestcontrol.com', location: 'bradenton' } }));
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'placed', live_url: 'https://citysquares.com/biz/waves', evidence_url: 'backlink-evidence/x.png' }));
    // v2 ledger (seo_link_attempts): CHECKed enum outcome, provider + action, verbatim engine outcome in detail
    expect(mockInsert).not.toHaveBeenCalled();
    expect(require('../services/seo/link-registry-backfill').backfillLegacyAttempts).toHaveBeenCalled();
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
  test('submit_blocked / submit_rejected → parked skip + last_classified_at refreshed, not retried', async () => {
    for (const errorCode of ['submit_blocked', 'submit_rejected']) {
      worker.claim.mockReset(); worker.claim.mockResolvedValue([prospect()]);
      worker.report.mockClear(); mockUpdate.mockClear();
      fillCitationForm.mockReset(); fillCitationForm.mockResolvedValue({ outcome: 'failed', errorCode, screenshot: Buffer.from('png') });
      const r = await runner.run({ allow: ['citysquares.com'] });
      expect(r.skipped).toBe(1);
      expect(r.failed).toBe(0);
      expect(worker.report).not.toHaveBeenCalled(); // not retried (futile)
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ automation_policy: 'skip', claimed_at: null, last_classified_at: expect.any(Date) }));
    }
  });
  test('no_submit_evidence retains its screenshot for the worker to reconcile against the mutation boundary)', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    fillCitationForm.mockResolvedValue({ outcome: 'failed', errorCode: 'no_submit_evidence', screenshot: Buffer.from('png') });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(0);
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', evidence_url: 'backlink-evidence/x.png' }));
  });
  test('a run-level config error (no_anthropic) ABORTS the batch + releases claims, NO ledger write, no attempts burned', async () => {
    worker.claim.mockResolvedValue([prospect({ id: 'p1' }), prospect({ id: 'p2' })]);
    fillCitationForm.mockResolvedValue({ outcome: 'failed', errorCode: 'no_anthropic' });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.aborted).toBe('no_anthropic');
    expect(r.failed).toBe(0);                           // no per-prospect attempts consumed
    expect(worker.report).not.toHaveBeenCalled();       // never reports failed
    expect(mockInsert).not.toHaveBeenCalled();          // NO seo_signup_attempts ledger row on a run-level outage
    expect(fillCitationForm).toHaveBeenCalledTimes(1);  // stops at the first run-level error
    expect(worker.releaseClaims).toHaveBeenCalledWith([
      { id: 'p1', lease_token: '2026-06-22T00:00:00.000Z' },
      { id: 'p2', lease_token: '2026-06-22T00:00:00.000Z' },
    ]);
  });
  test('a planning LLM outage (llm_error) is run-level → batch abort + release, no attempts burned', async () => {
    worker.claim.mockResolvedValue([prospect({ id: 'p1' }), prospect({ id: 'p2' })]);
    fillCitationForm.mockResolvedValue({ outcome: 'failed', errorCode: 'llm_error' });
    const r = await runner.run({ allow: ['citysquares.com'] });
    expect(r.aborted).toBe('llm_error');
    expect(r.failed).toBe(0);
    expect(worker.report).not.toHaveBeenCalled();
    expect(worker.releaseClaims).toHaveBeenCalledWith([
      { id: 'p1', lease_token: '2026-06-22T00:00:00.000Z' },
      { id: 'p2', lease_token: '2026-06-22T00:00:00.000Z' },
    ]);
  });
});


test.each([undefined, '-'])('unscoped signup location %s reports the actual GBP location for duplicate detection', async (location_key) => {
  worker.claim.mockResolvedValue([prospect({ location_key })]);
  fillCitationForm.mockResolvedValue({ outcome: 'placed', pending: true });
  await runner.run();
  expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'placed', location: 'bradenton' }));
});

test('citation execution submits and verifies the homepage even on a service-page board row', async () => {
  worker.claim.mockResolvedValue([prospect({ target_page: 'https://wavespestcontrol.com/pest-control/' })]);
  fillCitationForm.mockResolvedValue({ outcome: 'placed', pending: true });
  await runner.run();
  expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ cited_homepage: true, location: 'bradenton' }));
  expect(fillCitationForm.mock.calls[0][0].nap.website).toBe('https://wavespestcontrol.com');
});


test.each(['submit_rejected', 'submit_blocked'])('held %s keeps evidence and failure details on the reserved attempt', async errorCode => {
  worker.claim.mockResolvedValue([prospect()]);
  fillCitationForm.mockResolvedValue({ outcome: 'failed', errorCode, notes: 'Synthetic validation rejection', screenshot: Buffer.from('png') });
  await runner.run();
  expect(mockWhere).toHaveBeenCalledWith({ prospect_id: 'p1', lease_token: '2026-06-22T00:00:00.000Z', action: 'submit' });
  const write = mockUpdate.mock.calls.map(([patch]) => patch).find(patch => patch.evidence_url);
  expect(write.evidence_url).toBe('backlink-evidence/x.png');
  expect(write.detail.sql).toContain('COALESCE(detail');
  expect(JSON.parse(write.detail.bindings[0])).toMatchObject({ error_code: errorCode, error_message: 'Synthetic validation rejection' });
  expect(mockInsert).not.toHaveBeenCalled();
});
