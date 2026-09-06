jest.mock('../models/db', () => {
  const db = jest.fn(); db.raw = jest.fn(); db.schema = { hasTable: jest.fn() }; return db;
});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/epa-product-label', () => ({
  ...jest.requireActual('../services/epa-product-label'),
  findEpaLabel: jest.fn(), currentEpaSourceStatus: jest.fn(),
}));
const db = require('../models/db');
const { recordAuditEvent } = require('../services/audit-log');
const { dispatchWithFallback } = require('../services/llm/call');
const { findEpaLabel, currentEpaSourceStatus } = require('../services/epa-product-label');
const { extractionError, getLabelReview, extractLabelReview, decideLabelReview, revokeLabelReview } = require('../services/product-label-review');
const { labelProductSnapshot, reviewedWeather } = require('../services/product-label-weather');

const PRODUCT_ID = '11111111-2222-4333-8444-555555555555';
const ACTOR_ID = '22222222-2222-4333-8444-555555555555';
const absent = () => ({ status: 'not_stated', value: null, quote: '', page: null, note: '' });
const facts = () => ({ minTempF: absent(), maxTempF: absent(), maxWindMph: { status: 'limit', value: 10, quote: 'Synthetic label: do not apply above 10 mph.', page: 2, note: '' }, rainFreeHours: absent() });
const extraction = () => ({ identityMatch: true, registration: '123-456', productName: 'Synthetic test product', facts: facts() });
let row;
let changes;
beforeEach(() => {
  process.env.GATE_LABEL_PIPELINE = 'true';
  jest.clearAllMocks();
  row = { id: PRODUCT_ID, name: 'Synthetic test product', epa_reg_number: '123-456', formulation: 'SC', label_verified_at: null, default_rate_per_1000: 42 };
  changes = [];
  db.mockImplementation(() => {
    const q = {};
    for (const method of ['where', 'select', 'forUpdate']) q[method] = () => q;
    q.first = async () => structuredClone(row);
    q.update = async patch => { changes.push(patch); Object.assign(row, patch); return 1; };
    return q;
  });
  db.transaction = async fn => fn(db);
  findEpaLabel.mockResolvedValue({ source: { registration: '123-456', productName: row.name, filename: '000123-00456-20260101.pdf', url: 'https://www3.epa.gov/pesticides/chem_search/ppls/000123-00456-20260101.pdf' }, bytes: Buffer.from('%PDF-test'), pageCount: 3, sha256: 'source-hash' });
  currentEpaSourceStatus.mockResolvedValue('current');
  dispatchWithFallback.mockResolvedValue({ ok: true, json: extraction() });
});
afterEach(() => { delete process.env.GATE_LABEL_PIPELINE; });

test('gate off makes no database, source, or model call', async () => {
  delete process.env.GATE_LABEL_PIPELINE;
  await expect(extractLabelReview(PRODUCT_ID, ACTOR_ID)).rejects.toMatchObject({ statusCode: 404 });
  expect(db).not.toHaveBeenCalled(); expect(findEpaLabel).not.toHaveBeenCalled(); expect(dispatchWithFallback).not.toHaveBeenCalled();
});

test('extract → explicit source review → active weather; no general stamp or dose changes', async () => {
  const result = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  expect(result.review.active).toBeUndefined();
  expect(reviewedWeather(row, 'current')).toBeNull();
  expect(dispatchWithFallback.mock.calls[0][1].documents[0].data).toBe(Buffer.from('%PDF-test').toString('base64'));
  expect(JSON.stringify(dispatchWithFallback.mock.calls[0][1].jsonSchema)).not.toMatch(/maxLength|minLength|minimum/);
  const candidateId = result.review.draft.id;
  await expect(decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId, decision: 'approve' })).rejects.toMatchObject({ statusCode: 400 });
  await decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId, decision: 'approve', identityConfirmed: true });
  expect(reviewedWeather(row, 'current')).toMatchObject({ verified: true, limits: { maxWindMph: 10 } });
  expect(row.label_verified_at).toBeNull(); expect(row.default_rate_per_1000).toBe(42);
  expect(changes.every(p => Object.keys(p).sort().join(',') === 'label_weather_review,updated_at')).toBe(true);
  expect(recordAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ trx: db, critical: true, action: 'product_label.approved' }));
  await expect(decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId, decision: 'approve', identityConfirmed: true })).rejects.toMatchObject({ statusCode: 409 });
});

test('an existing pending candidate is returned without another model call', async () => {
  const first = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  const second = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  expect(second.review.draft.id).toBe(first.review.draft.id);
  expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
});
test('review responses distinguish stored approval from currently effective evidence', async () => {
  const candidate = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  expect((await getLabelReview(PRODUCT_ID)).activeCurrent).toBe(false);
  await decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId: candidate.review.draft.id, decision: 'approve', identityConfirmed: true });
  expect((await getLabelReview(PRODUCT_ID)).activeCurrent).toBe(true);
  row.formulation = 'WG';
  const stale = await getLabelReview(PRODUCT_ID);
  expect(stale.review.active.status).toBe('approved');
  expect(stale.activeCurrent).toBe(false);
  await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  expect((await getLabelReview(PRODUCT_ID)).activeCurrent).toBe(false);
});

test('source changes or product changes block approval', async () => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  const body = { candidateId: review.draft.id, decision: 'approve', identityConfirmed: true };
  currentEpaSourceStatus.mockResolvedValueOnce('superseded');
  await expect(decideLabelReview(PRODUCT_ID, ACTOR_ID, body)).rejects.toMatchObject({ statusCode: 409 });
  currentEpaSourceStatus.mockResolvedValue('current');
  row.epa_reg_number = '123-457';
  await expect(decideLabelReview(PRODUCT_ID, ACTOR_ID, body)).rejects.toMatchObject({ statusCode: 409 });
  expect(row.label_weather_review.active).toBeUndefined();
});

test('stale extraction never overwrites a concurrent catalog edit', async () => {
  dispatchWithFallback.mockImplementation(async () => { row.formulation = 'WG'; return { ok: true, json: extraction() }; });
  await expect(extractLabelReview(PRODUCT_ID, ACTOR_ID)).rejects.toMatchObject({ statusCode: 409 });
  expect(changes).toHaveLength(0);
});

test('a newly published EPA filename blocks approval even when the old PDF checksum still matches', async () => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  currentEpaSourceStatus.mockResolvedValueOnce('superseded');
  await expect(decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId: review.draft.id, decision: 'approve', identityConfirmed: true })).rejects.toMatchObject({ statusCode: 409 });
  expect(currentEpaSourceStatus).toHaveBeenCalledWith(review.draft.source, { refresh: true });
});

test('EPA unavailability during uncached approval returns a retryable error without activating', async () => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  currentEpaSourceStatus.mockResolvedValueOnce('unavailable');
  await expect(decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId: review.draft.id, decision: 'approve', identityConfirmed: true })).rejects.toMatchObject({ statusCode: 502, isOperational: true });
  expect(row.label_weather_review.active).toBeUndefined();
});

test.each(['superseded', 'unavailable'])('approved evidence becomes inactive when EPA source is %s without any catalog edit', async status => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  await decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId: review.draft.id, decision: 'approve', identityConfirmed: true });
  currentEpaSourceStatus.mockResolvedValue(status);
  const result = await getLabelReview(PRODUCT_ID);
  expect(result.review.active.status).toBe('approved');
  expect(result.activeCurrent).toBe(false);
  expect(result.activeReason).toMatch(/EPA/);
});

test('revoke preserves the decision trail but withdraws weather verification', async () => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  await decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId: review.draft.id, decision: 'approve', identityConfirmed: true });
  await revokeLabelReview(PRODUCT_ID, ACTOR_ID, review.draft.id);
  expect(reviewedWeather(row, 'current')).toMatchObject({ verified: false });
  expect(row.label_weather_review.active.facts.maxWindMph.quote).toContain('Synthetic');
  await expect(revokeLabelReview(PRODUCT_ID, ACTOR_ID, review.draft.id)).rejects.toMatchObject({ statusCode: 409 });
});

test('reject and expired candidates cannot activate', async () => {
  let { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID);
  row.label_weather_review.draft.createdAt = new Date(Date.now() - 8 * 86400000).toISOString();
  await expect(decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId: review.draft.id, decision: 'approve', identityConfirmed: true })).rejects.toMatchObject({ statusCode: 409 });
  row.formulation = 'WG';
  await decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId: review.draft.id, decision: 'reject' });
  expect(row.label_weather_review.draft).toBeNull();
  ({ review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID));
  await decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId: review.draft.id, decision: 'reject' });
  expect(row.label_weather_review.draft).toBeNull(); expect(row.label_weather_review.active).toBeUndefined();
});

test.each([
  [x => { x.identityMatch = false; }, 'label_identity_unresolved'],
  [x => { x.registration = '123-457'; }, 'label_identity_unresolved'],
  [x => { x.facts.maxWindMph.page = 20; }, 'invalid_label_page'],
  [x => { x.facts.maxWindMph.quote = ''; }, 'missing_label_evidence'],
  [x => { x.facts.maxWindMph.value = '10'; }, 'invalid_label_shape'],
  [x => { x.facts.maxWindMph.value = 0; }, 'invalid_label_value'],
  [x => { x.facts.maxWindMph.status = 'conditional'; }, 'unscoped_label_value'],
])('rejects unsupported extraction evidence %#', (change, reason) => {
  const x = extraction(); change(x); expect(extractionError(x, '123-456', 3)).toBe(reason);
});

test('identity or legacy weather edits invalidate an already approved snapshot', () => {
  row.label_weather_review = { active: { status: 'approved', productSnapshot: labelProductSnapshot(row), facts: facts() } };
  expect(reviewedWeather(row, 'current').verified).toBe(true);
  row.max_wind_mph = 9;
  expect(reviewedWeather(row, 'current').verified).toBe(false);
  delete process.env.GATE_LABEL_PIPELINE;
  expect(reviewedWeather(row, 'current')).toBeNull();
});
