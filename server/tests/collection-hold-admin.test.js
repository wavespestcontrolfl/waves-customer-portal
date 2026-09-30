/** B10 C: staff can see and release a collections hold; release resumes charging. */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockActive = jest.fn();
const mockRelease = jest.fn();
jest.mock('../services/collections/outbound-voice/flags', () => ({
  activeFlags: (...a) => mockActive(...a), releaseFlag: (...a) => mockRelease(...a),
}));
const mockReleaseWithheld = jest.fn();
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  releaseWithheldInvoices: (...a) => mockReleaseWithheld(...a),
}));
const mockCreateAlert = jest.fn(async () => ({}));
jest.mock('../services/dispatch-alerts', () => ({ createAlert: (...a) => mockCreateAlert(...a) }));
const { listCollectionHolds, releaseCollectionHold, sendWithheldInvoicesAfterRelease } = require('../services/collections/collection-hold-admin');
beforeEach(() => { jest.clearAllMocks(); mockReleaseWithheld.mockResolvedValue({ queued: [], cleared: 0 }); });

test('lists only collection_hold rows and says which ones stop charges', async () => {
  mockActive.mockResolvedValue([
    { flag: 'pays_by_check', reason: 'x' },
    { flag: 'collection_hold', reason: 'dispute on call: bill wrong', created_by: 'system:collections_voice', created_at: 't' },
    { flag: 'collection_hold', reason: 'wrong-party answer on billing follow-up call; review card failed to file' },
  ]);
  const holds = await listCollectionHolds('c-1');
  expect(holds).toHaveLength(2);
  expect(holds[0]).toMatchObject({ stops_charges: true, reason: 'dispute on call: bill wrong' });
  expect(holds[1].stops_charges).toBe(false);
});

test('release goes through the one writer, only for collection_hold', async () => {
  mockRelease.mockResolvedValue({ ok: true, released: 1 });
  expect(await releaseCollectionHold('c-1')).toMatchObject({ ok: true, released: 1 });
  expect(mockRelease).toHaveBeenCalledWith({ customerId: 'c-1', flag: 'collection_hold', trx: null });
});

test('a self-committed release sends the withheld invoices; a caller-owned transaction does not (the caller sends after its commit)', async () => {
  mockRelease.mockResolvedValue({ ok: true, released: 1 });
  mockReleaseWithheld.mockResolvedValue({ queued: ['inv-1'], cleared: 0 });
  expect(await releaseCollectionHold('c-1')).toMatchObject({ withheldSend: { ok: true, queued: ['inv-1'] } });
  expect(mockReleaseWithheld).toHaveBeenCalledWith({ customerId: 'c-1' });
  mockReleaseWithheld.mockClear();
  await releaseCollectionHold('c-1', { trx: { isTrx: true } });
  expect(mockReleaseWithheld).not.toHaveBeenCalled();
});

test('a failed release sends nothing', async () => {
  mockRelease.mockResolvedValue({ ok: false, reason: 'release_failed' });
  await releaseCollectionHold('c-1');
  expect(mockReleaseWithheld).not.toHaveBeenCalled();
});

test('a send failure never throws: it is logged and raised to the office as an alert', async () => {
  mockReleaseWithheld.mockRejectedValue(new Error('queue down'));
  await expect(sendWithheldInvoicesAfterRelease('c-1')).resolves.toMatchObject({ ok: false, queued: [] });
  expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
    type: 'collection_hold_release_send_failed', severity: 'warn',
    payload: expect.objectContaining({ customerId: 'c-1', error: 'queue down' }),
  }));
  // even the alert failing must not throw out of the release
  mockCreateAlert.mockRejectedValueOnce(new Error('alerts down'));
  await expect(sendWithheldInvoicesAfterRelease('c-1')).resolves.toMatchObject({ ok: false });
});

test('the routes are admin-only and audited', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-customers.js'), 'utf8');
  expect(src).toMatch(/router\.get\('\/:id\/collection-holds', requireAdmin/);
  expect(src).toMatch(/router\.post\('\/:id\/collection-holds\/release', requireAdmin/);
  expect(src).toMatch(/customer\.collection_hold_released/);
});

test('the hold routes sit above the property-address comment block, not between it and its handler', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-customers.js'), 'utf8');
  const holds = src.indexOf("router.get('/:id/collection-holds'");
  const release = src.indexOf("router.post('/:id/collection-holds/release'");
  const propsComment = src.indexOf('// GET /api/admin/customers/:id/properties');
  expect(holds).toBeGreaterThan(0);
  expect(release).toBeLessThan(propsComment);
  // the properties comment is followed by its own code, not by the hold routes
  expect(src.slice(propsComment, propsComment + 2500)).not.toMatch(/collection-holds/);
});
