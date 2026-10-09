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
    const guard = source.indexOf('refuseStepSprayOnRecap(trx, recordId);', ledger);
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

  test('before a replace: a Recognition row already on the record is refused with its own message (codex r53 P2)', async () => {
    await expect(refuseStepSprayOnRecap(fakeTrx({ limitRows: RATE_ROW, ledgerRow: { id: 'row' } }), 'record', { existing: true }))
      .rejects.toMatchObject({ code: 'lawn_bermuda_recap_not_allowed', statusCode: 400, message: expect.stringMatching(/full visit form/) });
    await expect(refuseStepSprayOnRecap(fakeTrx({ limitRows: RATE_ROW, ledgerRow: null }), 'record', { existing: true })).resolves.toBeUndefined();
  });

  test('the recap runs that check before its replace block deletes or retracts anything', () => {
    const source = read('pest-recap.js');
    const block = source.indexOf('if (productRows.length || confirmedEmptyReplace) {');
    const guard = source.indexOf('refuseStepSprayOnRecap(trx, recordId, { existing: true })', block);
    const firstDelete = source.indexOf('.del()', block);
    const firstRetract = source.indexOf('retracted_at: new Date()', block);
    expect(block).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(block);
    expect(guard).toBeLessThan(firstDelete);
    expect(guard).toBeLessThan(firstRetract);
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
    ['lawn-protocol-completion.js', /require\('\.\/lawn-bermuda-removal'\)\.withoutBermudaRemovalRows\(k\('lawn_protocol_products as lpp'\)/],
    ['estimate-ai-context.js', /withoutBermudaRemovalRows\(db\('lawn_protocol_products'\)/],
  ])('%s uses it', (file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  test('the completion ledger attributes to the step rows only when the visit plan carries the step, from the appointment month\'s window', () => {
    const source = read('lawn-protocol-completion.js');
    expect(source).toMatch(/bermudaStep: plan\?\.bermudaRemoval\?\.active === true/);
    expect(source).toMatch(/bermudaStepMonth: plan\?\.bermudaRemoval\?\.month \|\| null/);
    expect(source).toMatch(/const stepProducts = bermudaStep && windowRow\?\.id\s+\? await loadBermudaStepRows\(trx, protocolRow\.id, windowRow\.id, bermudaStepMonth\)/);
    expect(read('lawn-bermuda-removal.js')).toMatch(/mix: addOn\.summary, month: stepMonth/);
  });
});

// A product with an ordinary row and a step row on one visit (the surfactant): the completion
// matches it to the step row only when the visit recorded the step's own herbicide (codex #6229 r3 P2).
describe('rowsInMatchingOrder', () => {
  const { rowsInMatchingOrder } = require('../services/lawn-protocol-completion');
  const weedNis = { id: 'may-nis', product_id: 'nis', gates: {} };
  const stepNis = { id: 'jun-nis', product_id: 'nis', gates: { bermudaRemoval: true } };
  const stepRec = { id: 'jun-rec', product_id: 'rec', gates: JSON.stringify({ bermudaRemoval: true }) };
  const rows = [weedNis, stepNis, stepRec];
  const first = (applied) => rowsInMatchingOrder(rows, applied.map((id) => ({ product_id: id }))).find((row) => row.product_id === 'nis');

  test('the step was sprayed (Recognition recorded): the shared product is the step\'s', () => {
    expect(first(['rec', 'nis'])).toBe(stepNis);
  });
  test('the step was not sprayed: the shared product keeps its ordinary row', () => {
    expect(first(['nis'])).toBe(weedNis);
    expect(first([])).toBe(weedNis);
  });
  test('no step rows on the visit: the list is returned as it is', () => {
    const plain = [weedNis];
    expect(rowsInMatchingOrder(plain, [{ product_id: 'nis' }])).toBe(plain);
  });
});
