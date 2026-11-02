// The re-date CLI's --apply helpers are the real app modules. The service tests inject fakes, so a helper the
// CLI names but the module does not export passed every test and failed only in the real run (11-01: the series
// lock was not a module export; 28 series moved their visits, then stopped at the conversion). This loads the real
// modules (database mocked) and requires every helper to resolve before --apply writes anything.
jest.mock('../models/db', () => {
  const builder = () => new Proxy(() => builder(), { get: (target, key) => (key === 'then' ? undefined : builder()) });
  const db = jest.fn(() => builder());
  db.raw = jest.fn();
  db.transaction = jest.fn();
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { buildApplyDeps, missingApplyDeps } = require('../../scripts/lawn-9x-rounds-redate');

describe('lawn 9x re-date CLI apply helpers', () => {
  test('every helper --apply calls resolves to a function in the real modules', () => {
    expect(missingApplyDeps(buildApplyDeps('2026-11-01'))).toEqual([]);
  });

  test('a helper that does not resolve is named, so --apply refuses before the first write', () => {
    const deps = buildApplyDeps('2026-11-01');
    expect(missingApplyDeps({ ...deps, lockSeries: undefined })).toEqual(['lockSeries']);
    expect(missingApplyDeps({ ...deps, prepay: {} })).toEqual(['prepay.normalizeCoverageCadence', 'prepay.inferCoverageCadence']);
  });
});
