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

describe('bounded wait (pre-push r1 P1: the SMS races the warm)', () => {
  const { prewarmReportCrossSellEvidenceBounded } = require('../services/service-report/evidence-prewarm');

  test('a fast warm resolves through with its result before the deadline — and clears the timer (r2 P1)', async () => {
    buildReportCrossSell.mockResolvedValue({ mode: 'priced' });
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const { outcome } = prewarmReportCrossSellEvidenceBounded(RECORD, DB, { maxWaitMs: 500 });
    await expect(outcome).resolves.toBe('priced');
    // A fast warm must not leave the deadline handle live — completions
    // otherwise accumulate timers and graceful shutdown waits on them.
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  test('a slow warm yields "timeout" at the deadline and hands back the LIVE warm promise (r6 P1)', async () => {
    let finish;
    buildReportCrossSell.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { outcome, warm } = prewarmReportCrossSellEvidenceBounded(RECORD, DB, { maxWaitMs: 30 });
    await expect(outcome).resolves.toBe('timeout');
    // The underlying warm was not cancelled and is EXPOSED — a later
    // re-warm must chain on it (no in-flight dedupe in the lookup) instead
    // of racing a second paid pipeline against it.
    finish({ mode: 'priced' });
    await expect(warm).resolves.toBe('priced');
    expect(buildReportCrossSell).toHaveBeenCalledTimes(1);
  });
});

describe('completion wiring (source contracts — both handlers are too heavy to stand up)', () => {
  const fs = require('fs');
  const path = require('path');
  const dispatchSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
  const recapSrc = fs.readFileSync(path.join(__dirname, '../services/pest-recap.js'), 'utf8');

  test('dispatch: bounded call site guarded on v1 + complete + non-backfill + customer-deliverable posture (r2 P1)', () => {
    expect(dispatchSrc).toMatch(/useServiceReportV1 && !isIncompleteVisit && !isBackfillCompletion && record\?\.id\s*\n\s*&& !\['disabled', 'internal_only'\]\.includes\(typedDeliveryMode\)/);
    expect(dispatchSrc).toMatch(/await bounded\.outcome/);
  });

  test('dispatch: the warm runs AFTER the frozen-delivery re-derivation and BEFORE token minting (r6 P1)', () => {
    const frozenAt = dispatchSrc.indexOf('typedDeliveryMode = frozenDelivery');
    const warmAt = dispatchSrc.indexOf('prewarmReportCrossSellEvidenceBounded(record, db');
    const tokenAt = dispatchSrc.indexOf('ensureReportToken(record.id)');
    expect(frozenAt).toBeGreaterThan(0);
    expect(warmAt).toBeGreaterThan(frozenAt);
    expect(tokenAt).toBeGreaterThan(warmAt);
  });

  test('dispatch: the post-maintenance re-warm CHAINS on the first warm — never races its in-flight lookup (r2 P2 + r6 P1)', () => {
    const maintenanceAt = dispatchSrc.indexOf('runPostCompletionSeriesMaintenance({ db, svc');
    const rewarmAt = dispatchSrc.indexOf('void crossSellWarm.catch(() => null).then(() => prewarmReportCrossSellEvidence(record, db))');
    expect(maintenanceAt).toBeGreaterThan(0);
    expect(rewarmAt).toBeGreaterThan(maintenanceAt);
  });

  test('pest-recap: deliberately NOT wired — the path cannot produce a warmable report (r1–r3 convergence)', () => {
    // Fresh recap records never carry service_report_v1 (no card renders),
    // and re-recaps of v1 records are never the completion winner (the
    // original /complete already warmed). The file documents the reasoning
    // and the claim-safety constraint for whoever wires it later.
    expect(recapSrc).not.toMatch(/prewarmReportCrossSellEvidence/);
    expect(recapSrc).toMatch(/DELIBERATELY NOT wired/);
    expect(recapSrc).toMatch(/nothing may sit between that claim and the send/);
  });
});
