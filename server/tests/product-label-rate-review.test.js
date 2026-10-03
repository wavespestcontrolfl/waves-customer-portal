// The rate review rides the weather review's flow (product-label-review.js)
// with its own column, gate, prompt and validation. Approved directions are
// stored evidence only: no catalog rate, stamp or weather review changes.
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
const { reviewedRates, rateFactsError, MAX_DIRECTIONS } = require('../services/product-label-rates');

const PRODUCT_ID = '11111111-2222-4333-8444-555555555555';
const ACTOR_ID = '22222222-2222-4333-8444-555555555555';
const direction = (over = {}) => ({
  status: 'rate', useSite: 'Outdoor perimeter of structures', targets: 'Ants, spiders', method: 'Coarse spray',
  rateText: '0.2 to 0.8 fl oz per gallon of water',
  quote: 'Synthetic label: mix 0.2 to 0.8 fl oz per gallon of water. Do not apply more than once every 21 days.', page: 2, note: '', ...over,
});
const conditional = (over = {}) => direction({ status: 'conditional', rateText: '', quote: 'Synthetic label: see the rate table by pest.', note: 'Rate table by pest.', ...over });
const extraction = (directions = [direction()]) => ({ identityMatch: true, registration: '123-456', productName: 'Synthetic test product', facts: { directions } });
const approve = (candidateId) => decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId, decision: 'approve', identityConfirmed: true }, 'rates');
let row;
let changes;
beforeEach(() => {
  process.env.GATE_LABEL_PIPELINE = 'true';
  process.env.GATE_LABEL_RATE_REVIEW = 'true';
  jest.clearAllMocks();
  row = { id: PRODUCT_ID, name: 'Synthetic test product', epa_reg_number: '123-456', formulation: 'SC', label_verified_at: null, default_rate: '9', max_wind_mph: 10, label_weather_review: { revision: 'w1' } };
  changes = [];
  db.mockImplementation(() => {
    const q = {};
    for (const method of ['where', 'select', 'forUpdate']) q[method] = () => q;
    q.first = async () => structuredClone(row);
    q.update = async (patch) => { changes.push(patch); Object.assign(row, patch); return 1; };
    return q;
  });
  db.transaction = async (fn) => fn(db);
  findEpaLabel.mockResolvedValue({ source: { registration: '123-456', productName: row.name, filename: '000123-00456-20260101.pdf', url: 'https://www3.epa.gov/pesticides/chem_search/ppls/000123-00456-20260101.pdf' }, bytes: Buffer.from('%PDF-test'), pageCount: 3, sha256: 'source-hash' });
  currentEpaSourceStatus.mockResolvedValue('current');
  dispatchWithFallback.mockResolvedValue({ ok: true, json: extraction() });
});
afterEach(() => { delete process.env.GATE_LABEL_PIPELINE; delete process.env.GATE_LABEL_RATE_REVIEW; });

test.each(['GATE_LABEL_PIPELINE', 'GATE_LABEL_RATE_REVIEW'])('%s off makes no database, source, or model call', async (gate) => {
  delete process.env[gate];
  await expect(extractLabelReview(PRODUCT_ID, ACTOR_ID, 'rates')).rejects.toMatchObject({ statusCode: 404 });
  await expect(getLabelReview(PRODUCT_ID, 'rates')).rejects.toMatchObject({ statusCode: 404 });
  expect(db).not.toHaveBeenCalled(); expect(findEpaLabel).not.toHaveBeenCalled(); expect(dispatchWithFallback).not.toHaveBeenCalled();
});

test('the rate gate being off leaves the weather review working', async () => {
  delete process.env.GATE_LABEL_RATE_REVIEW;
  await expect(getLabelReview(PRODUCT_ID)).resolves.toMatchObject({ enabled: true });
});

test('extract → source review → approved directions; only label_rate_review is written', async () => {
  const result = await extractLabelReview(PRODUCT_ID, ACTOR_ID, 'rates');
  expect(result.review.active).toBeUndefined();
  expect(reviewedRates(row, 'current')).toBeNull();
  const request = dispatchWithFallback.mock.calls[0][1];
  expect(request.promptVersion).toBe('epa_rates_v1');
  expect(request.system).toMatch(/Never compute, convert, round, reword, abbreviate or infer/);
  expect(JSON.stringify(request.jsonSchema)).not.toMatch(/maxLength|minLength|minimum|minItems|maxItems/);
  const candidateId = result.review.draft.id;
  await expect(decideLabelReview(PRODUCT_ID, ACTOR_ID, { candidateId, decision: 'approve' }, 'rates')).rejects.toMatchObject({ statusCode: 400 });
  await approve(candidateId);
  expect(reviewedRates(row, 'current')).toMatchObject({ verified: true, directions: [expect.objectContaining({ rateText: '0.2 to 0.8 fl oz per gallon of water', page: 2 })] });
  expect(row.label_verified_at).toBeNull(); expect(row.default_rate).toBe('9');
  expect(row.label_weather_review).toEqual({ revision: 'w1' });
  expect(changes.every((p) => Object.keys(p).sort().join(',') === 'label_rate_review,updated_at')).toBe(true);
  expect(recordAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ trx: db, critical: true, action: 'product_label_rate.approved' }));
  expect((await getLabelReview(PRODUCT_ID, 'rates')).activeCurrent).toBe(true);
});

test('a weather-column edit does not retire a rate review; an identity edit does', async () => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID, 'rates');
  await approve(review.draft.id);
  row.max_wind_mph = 15;
  expect(reviewedRates(row, 'current')).toMatchObject({ verified: true });
  row.formulation = 'WG';
  expect(reviewedRates(row, 'current')).toMatchObject({ verified: false, directions: [] });
});

test.each(['superseded', 'unavailable'])('approved directions are withheld when the EPA source is %s', async (status) => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID, 'rates');
  await approve(review.draft.id);
  expect(reviewedRates(row, status)).toMatchObject({ verified: false, directions: [] });
  currentEpaSourceStatus.mockResolvedValue(status);
  const result = await getLabelReview(PRODUCT_ID, 'rates');
  expect(result.activeCurrent).toBe(false);
  expect(result.activeReason).toMatch(/EPA/);
});

test('revoke withdraws the directions and keeps the decision trail', async () => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID, 'rates');
  await approve(review.draft.id);
  await revokeLabelReview(PRODUCT_ID, ACTOR_ID, review.draft.id, 'rates');
  expect(reviewedRates(row, 'current')).toMatchObject({ verified: false, directions: [] });
  expect(row.label_rate_review.active.facts.directions[0].quote).toContain('Synthetic');
});

test('the gate going off hides approved directions from readers', async () => {
  const { review } = await extractLabelReview(PRODUCT_ID, ACTOR_ID, 'rates');
  await approve(review.draft.id);
  delete process.env.GATE_LABEL_RATE_REVIEW;
  expect(reviewedRates(row, 'current')).toBeNull();
});

test('a failed extraction stores nothing', async () => {
  dispatchWithFallback.mockResolvedValue({ ok: true, json: extraction([direction({ rateText: '5 fl oz per acre' })]) });
  await expect(extractLabelReview(PRODUCT_ID, ACTOR_ID, 'rates')).rejects.toMatchObject({ statusCode: 422 });
  expect(changes).toHaveLength(0);
});

test('an unknown kind is refused', async () => {
  await expect(getLabelReview(PRODUCT_ID, 'pricing')).rejects.toMatchObject({ statusCode: 400 });
  await expect(getLabelReview(PRODUCT_ID, 'constructor')).rejects.toMatchObject({ statusCode: 400 });
});

describe('rate direction validation', () => {
  const error = (directions, pageCount = 3) => extractionError(extraction(directions), '123-456', pageCount, 'rates');
  const printed = (rateText) => direction({ rateText, quote: `Synthetic label: apply ${rateText} as a coarse spray.` });
  test('a quoted rate and a quoted conditional line pass', () => {
    expect(error([direction(), conditional()])).toBeNull();
  });
  test.each([
    '1 fl oz per 10 gallons',
    '4 to 8 fl oz per 100 linear feet',
    '2 oz per 1,000 board feet',
    '3 to 6 scoops per cubic yard',
    '1/3 fl oz per 1,000 sq ft',
    '2 2/3 oz per gallon',
    '\u2153 fl oz per gallon',
    '0.03% to 0.06%',
    'one packet per acre',
    'one-half to one pint per acre',
  ])('%s is kept exactly as the label prints it', (rateText) => {
    expect(error([printed(rateText)])).toBeNull();
  });
  test('a rate printed twice passes when one printing is whole', () => {
    expect(error([direction({ rateText: '2 fl oz per gallon', quote: 'Synthetic label: use 0.2 fl oz per gallon indoors, 2 fl oz per gallon outdoors.' })])).toBeNull();
    expect(error([direction({ rateText: '0.5 fl oz per gallon', quote: 'Synthetic label: Step 2. 0.5 fl oz per gallon (see page 4).' })])).toBeNull();
  });
  test('spacing, case and dash style do not break the verbatim check', () => {
    expect(error([direction({ rateText: '0.2\u20130.8 FL OZ  per gallon', quote: 'Synthetic label: mix 0.2-0.8 fl oz\nper gallon.' })])).toBeNull();
  });
  test.each([
    ['no directions', [], 'invalid_label_shape'],
    ['too many directions', Array.from({ length: MAX_DIRECTIONS + 1 }, () => direction()), 'invalid_label_shape'],
    ['a page past the document', [direction({ page: 4 })], 'invalid_label_page'],
    ['no quote', [direction({ quote: ' ' })], 'missing_label_evidence'],
    ['a blank use site', [direction({ useSite: '  ' })], 'missing_label_evidence'],
    ['a rate with no amount text', [direction({ rateText: ' ' })], 'missing_label_value'],
    ['a rate that is not in the quote', [direction({ rateText: '0.2 to 0.9 fl oz per gallon of water' })], 'rate_not_in_quote'],
    ['a converted fraction', [direction({ rateText: '0.33 fl oz per gallon', quote: 'Synthetic label: mix 1/3 fl oz per gallon.' })], 'rate_not_in_quote'],
    ['a reworded denominator', [direction({ rateText: '0.2 to 0.8 fl oz per gal' , quote: 'Synthetic label: mix 0.2 to 0.8 fl oz per 10 gallons.' })], 'rate_not_in_quote'],
    ['a rate starting inside a decimal', [direction({ rateText: '2 fl oz per gallon', quote: 'Synthetic label: mix 0.2 fl oz per gallon.' })], 'rate_not_in_quote'],
    ['a rate starting inside a fraction', [direction({ rateText: '3 fl oz per gallon', quote: 'Synthetic label: mix 1/3 fl oz per gallon.' })], 'rate_not_in_quote'],
    ['a rate starting inside a mixed fraction', [direction({ rateText: '2/3 oz per gallon', quote: 'Synthetic label: mix 2 2/3 oz per gallon.' })], 'rate_not_in_quote'],
    ['a rate starting inside a thousands number', [direction({ rateText: '500 lb per acre', quote: 'Synthetic label: apply 1,500 lb per acre.' })], 'rate_not_in_quote'],
    ['only the high end of a range', [direction({ rateText: '0.8 fl oz per gallon of water' })], 'rate_not_in_quote'],
    ['only the high end of a dashed range', [direction({ rateText: '0.8 fl oz per gallon', quote: 'Synthetic label: mix 0.2-0.8 fl oz per gallon.' })], 'rate_not_in_quote'],
    ['only the low end of a range', [direction({ rateText: '0.2', quote: 'Synthetic label: mix 0.2 to 0.8 fl oz per gallon.' })], 'rate_not_in_quote'],
    ['a rate without its denominator', [direction({ rateText: '0.2 to 0.8 fl oz' })], 'rate_not_in_quote'],
    ['a rate stopping inside the denominator number', [direction({ rateText: '1 fl oz per 1', quote: 'Synthetic label: mix 1 fl oz per 10 gallons.' })], 'rate_not_in_quote'],
    ['a rate stopping inside a unit', [direction({ rateText: '0.2 to 0.8 fl oz per gal' })], 'rate_not_in_quote'],
    ['a conditional line carrying an amount', [conditional({ rateText: '0.2 fl oz per gallon' })], 'unscoped_label_value'],
    ['a model-made number beside the text', [{ ...direction(), low: 0.2 }], 'invalid_label_shape'],
    ['a model-made unit code beside the text', [{ ...direction(), unit: 'fl_oz' }], 'invalid_label_shape'],
  ])('%s is rejected', (_name, directions, code) => {
    expect(error(directions)).toBe(code);
  });
  test('identity mismatch is rejected before the facts are read', () => {
    expect(extractionError({ ...extraction(), identityMatch: false }, '123-456', 3, 'rates')).toBe('label_identity_unresolved');
    expect(rateFactsError(extraction().facts, 3)).toBeNull();
  });
});
