// Every writer of the application ledger that can record a Recognition spray runs the bermuda
// removal in-transaction limit check first (codex #6035 r43 P2: the pest recap wrote the ledger
// without it, so a recap could commit a 3rd yearly or <42-day spray that /complete refuses).
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');

describe('bermuda removal limits guard every in-transaction ledger write', () => {
  test.each(['pest-recap.js', 'complete-scheduled-service.js'])('%s checks the limits before createComplianceRecords, on the same transaction', (file) => {
    const source = read(file);
    const ledger = source.indexOf('createComplianceRecords(');
    const guard = source.lastIndexOf('enforceStepLimitsInTransaction(trx', ledger);
    expect(ledger).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    // Nothing writes the ledger between the guard and the writer.
    expect(source.slice(guard, ledger)).not.toMatch(/property_application_history'\)\s*\.insert/);
    expect(source.split('createComplianceRecords(').length - 1).toBe(1);
  });

  test('the pest recap turns a refusal into a 400 the route returns as is', () => {
    const source = read('pest-recap.js');
    const guard = source.indexOf('enforceStepLimitsInTransaction(trx');
    const block = source.slice(guard, guard + 700);
    expect(block).toMatch(/lawn_bermuda_limit_reached/);
    expect(block).toMatch(/statusCode = 400/);
  });
});
