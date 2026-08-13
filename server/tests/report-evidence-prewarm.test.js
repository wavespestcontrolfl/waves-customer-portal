// Evidence pre-warm (owner lane 2026-08-13): at visit completion, run the
// cross-sell composer once with a PERSISTING property lookup so the
// customer's render — which reads cache-only — finds warm evidence and the
// card prices instead of falling back to the quote CTA. The design rule
// these tests pin: the pre-warm IS the composer (same premises resolution,
// same matrix, same suppressions — no parallel address logic to drift),
// double-gated, and never rejects into its fire-and-forget caller.

jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../services/service-report/cross-sell', () => ({ buildReportCrossSell: jest.fn() }));
jest.mock('../routes/property-lookup-v2', () => ({ performPropertyLookup: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { isEnabled } = require('../config/feature-gates');
const { buildReportCrossSell } = require('../services/service-report/cross-sell');
const { performPropertyLookup } = require('../routes/property-lookup-v2');
const logger = require('../services/logger');
const { prewarmReportCrossSellEvidence } = require('../services/service-report/evidence-prewarm');

const RECORD = { id: 'sr-1', customer_id: 'cust-1', address_line1: '123 Test Ln', city: 'Sarasota', zip: '34236' };
const DB = {};

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(() => true);
  buildReportCrossSell.mockResolvedValue({ mode: 'priced' });
  performPropertyLookup.mockResolvedValue({ enriched: {} });
});

test('double-gated: either gate dark → no composer run, no lookup, no spend', async () => {
  isEnabled.mockImplementation((key) => key !== 'reportCrossSellPrewarm');
  expect(await prewarmReportCrossSellEvidence(RECORD, DB)).toBeNull();
  isEnabled.mockImplementation((key) => key !== 'reportCrossSell');
  expect(await prewarmReportCrossSellEvidence(RECORD, DB)).toBeNull();
  expect(buildReportCrossSell).not.toHaveBeenCalled();
  expect(performPropertyLookup).not.toHaveBeenCalled();
});

test('runs the composer itself with a PERSISTING lookup — the one difference from render', async () => {
  const mode = await prewarmReportCrossSellEvidence(RECORD, DB);
  expect(mode).toBe('priced');
  expect(buildReportCrossSell).toHaveBeenCalledTimes(1);
  const [service, database, opts] = buildReportCrossSell.mock.calls[0];
  expect(service).toBe(RECORD);
  expect(database).toBe(DB);
  // The injected lookup must fetch live and persist — cacheOnly render
  // semantics would warm nothing.
  await opts.propertyLookup('123 Test Ln, Sarasota FL');
  expect(performPropertyLookup).toHaveBeenCalledWith(
    '123 Test Ln, Sarasota FL',
    { cacheOnly: false, persist: true },
  );
});

test('a suppressed card is a null composer result — accepted quietly, still no throw', async () => {
  buildReportCrossSell.mockResolvedValue(null);
  expect(await prewarmReportCrossSellEvidence(RECORD, DB)).toBeNull();
});

test('never rejects into the fire-and-forget caller, and the raw error stays out of the logs', async () => {
  const pgError = new Error('connect ECONNREFUSED — while inserting (customer_phone)=(+19415550000)');
  pgError.code = 'ECONNREFUSED';
  buildReportCrossSell.mockRejectedValue(pgError);
  await expect(prewarmReportCrossSellEvidence(RECORD, DB)).resolves.toBeNull();
  const logged = logger.warn.mock.calls.map((call) => String(call[0])).join('\n');
  expect(logged).toContain('code=ECONNREFUSED');
  expect(logged).not.toContain('9415550000');
});

test('a record missing its ids is a no-op, never a throw', async () => {
  expect(await prewarmReportCrossSellEvidence(null, DB)).toBeNull();
  expect(await prewarmReportCrossSellEvidence({ id: 'sr-1' }, DB)).toBeNull();
  expect(buildReportCrossSell).not.toHaveBeenCalled();
});

describe('dispatch wiring (source contract — the completion handler is too heavy to stand up)', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../routes/admin-dispatch.js'),
    'utf8',
  );

  test('exactly one call site: post-commit, setImmediate, guarded on v1 + complete + non-backfill', () => {
    const calls = src.match(/prewarmReportCrossSellEvidence/g) || [];
    // require + invocation
    expect(calls.length).toBe(2);
    expect(src).toMatch(/useServiceReportV1 && !isIncompleteVisit && !isBackfillCompletion && record\?\.id/);
    // Fire-and-forget: inside setImmediate, result discarded with void.
    expect(src).toMatch(/setImmediate\(\(\) => \{\s*\n\s*const \{ prewarmReportCrossSellEvidence \} = require\('\.\.\/services\/service-report\/evidence-prewarm'\);\s*\n\s*void prewarmReportCrossSellEvidence\(record, db\);/);
  });
});
