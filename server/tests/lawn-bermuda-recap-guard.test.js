// Every in-transaction writer of the application ledger guards the bermuda removal spray
// (codex #6035 r43 P2, r46 P2): /complete checks the step's limits BEFORE the write; the pest
// recap, which cannot size or place a Recognition spray, refuses one AFTER the write, judged on
// the ledger rows themselves (so an id, a legacy name or a missing rate are all caught).
const fs = require('fs');
const path = require('path');
const { refuseStepSprayOnRecap } = require('../services/lawn-bermuda-removal');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');

describe('the ledger writers', () => {
  test('/complete checks the limits before createComplianceRecords, on the same transaction', () => {
    const source = read('complete-scheduled-service.js');
    const ledger = source.indexOf('createComplianceRecords(');
    expect(source.lastIndexOf('enforceStepLimitsInTransaction(trx', ledger)).toBeGreaterThan(-1);
    expect(source.split('createComplianceRecords(').length - 1).toBe(1);
  });

  test('the pest recap refuses a Recognition row right after its one ledger write, on the same transaction', () => {
    const source = read('pest-recap.js');
    expect(source.split('createComplianceRecords(').length - 1).toBe(1);
    const ledger = source.indexOf('createComplianceRecords(recordId, { trx })');
    const guard = source.indexOf('refuseStepSprayOnRecap(trx, recordId)', ledger);
    expect(ledger).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(ledger);
    expect(guard - ledger).toBeLessThan(700);
  });
});

describe('refuseStepSprayOnRecap', () => {
  const REC = 'rec-id';
  const fakeTrx = ({ limitRows, ledgerRow }) => jest.fn((table) => {
    const q = {};
    for (const method of ['where', 'whereNull', 'select']) q[method] = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'property_application_history' ? ledgerRow : null));
    q.then = (resolve, reject) => Promise.resolve(table === 'product_limits' ? limitRows : []).then(resolve, reject);
    return q;
  });
  const RATE_ROW = [{ product_id: REC, limit_type: 'annual_max_rate' }];
  beforeEach(() => { process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true'; });
  afterEach(() => { delete process.env.GATE_LAWN_BERMUDA_REMOVAL; });

  test('a live Recognition ledger row for the record is refused with a 400', async () => {
    await expect(refuseStepSprayOnRecap(fakeTrx({ limitRows: RATE_ROW, ledgerRow: { id: 'row' } }), 'record'))
      .rejects.toMatchObject({ code: 'lawn_bermuda_recap_not_allowed', statusCode: 400, isOperational: true });
  });

  test('no Recognition row, no tagged label-rate row, or the gate off: nothing', async () => {
    await expect(refuseStepSprayOnRecap(fakeTrx({ limitRows: RATE_ROW, ledgerRow: null }), 'record')).resolves.toBeUndefined();
    await expect(refuseStepSprayOnRecap(fakeTrx({ limitRows: [], ledgerRow: { id: 'row' } }), 'record')).resolves.toBeUndefined();
    delete process.env.GATE_LAWN_BERMUDA_REMOVAL;
    const trx = fakeTrx({ limitRows: RATE_ROW, ledgerRow: { id: 'row' } });
    await expect(refuseStepSprayOnRecap(trx, 'record')).resolves.toBeUndefined();
    expect(trx).not.toHaveBeenCalled();
  });
});

// The bermuda removal rows belong to the lawns that asked for the step (codex #6035 r51 P1): every
// reader of lawn_protocol_products that plans, attributes or describes a window leaves them out
// through ONE predicate, unless it names a bermuda removal visit.
describe('direct readers of the staged protocol rows', () => {
  const { withoutBermudaRemovalRows } = require('../services/lawn-bermuda-removal');

  test('the predicate narrows on the gates flag, on the table or alias given', () => {
    const query = { whereRaw: jest.fn(function whereRaw() { return this; }) };
    expect(withoutBermudaRemovalRows(query, 'lpp')).toBe(query);
    expect(query.whereRaw).toHaveBeenCalledWith("COALESCE(lpp.gates->>'bermudaRemoval', 'false') <> 'true'");
    withoutBermudaRemovalRows(query);
    expect(query.whereRaw).toHaveBeenLastCalledWith("COALESCE(lawn_protocol_products.gates->>'bermudaRemoval', 'false') <> 'true'");
  });

  test.each([
    ['lawn-protocol-operating-layer.js', /if \(!includeBermudaRemoval\) require\('\.\/lawn-bermuda-removal'\)\.withoutBermudaRemovalRows\(productsQuery, 'lpp'\)/],
    ['lawn-protocol-completion.js', /const rows = bermudaStep \? query : require\('\.\/lawn-bermuda-removal'\)\.withoutBermudaRemovalRows\(query, 'lpp'\)/],
    ['estimate-ai-context.js', /withoutBermudaRemovalRows\(db\('lawn_protocol_products'\)/],
  ])('%s uses it', (file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  test('the completion ledger attributes to the step rows only when the visit plan carries the step', () => {
    expect(read('lawn-protocol-completion.js')).toMatch(/bermudaStep: plan\?\.bermudaRemoval\?\.active === true/);
  });
});
