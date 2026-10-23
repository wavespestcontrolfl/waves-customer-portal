// One live New Construction Termite Warranty per pre-treat job: a reissue
// supersedes the open one; a signed one refuses a second (Codex #6515 r1).
const { supersedeOpenNewConstructionWarranty, snapshotWarrantyNumber } = require('../services/new-construction-warranty');

function fakeTrx(rows) {
  const updates = [];
  const events = [];
  const trx = (table) => {
    const q = {
      _where: {},
      where(arg) { Object.assign(this._where, arg); return this; },
      whereIn() { return this; },
      forUpdate() { return this; },
      select: async () => rows,
      update: async (patch) => { updates.push({ id: q._where.id, patch }); return 1; },
      insert: async (row) => { events.push({ table, row }); return [row]; },
    };
    return q;
  };
  return { trx, updates, events };
}

const ctx = { warranty: { number: 'NCW-ABCD1234' } };
const snap = (number) => JSON.stringify({ warranty: { number } });

describe('supersedeOpenNewConstructionWarranty', () => {
  test('ignores every other template', async () => {
    const { trx, updates } = fakeTrx([{ id: 'c1', status: 'sent', document_variables_snapshot: snap('NCW-ABCD1234') }]);
    await supersedeOpenNewConstructionWarranty(trx, { templateKey: 'service_agreement.termite_bond_retreatment', customerId: 'cu', context: ctx });
    expect(updates).toEqual([]);
  });

  test('cancels the open warranty for the same job and leaves other jobs alone', async () => {
    const { trx, updates, events } = fakeTrx([
      { id: 'same', status: 'viewed', document_variables_snapshot: snap('NCW-ABCD1234') },
      { id: 'other', status: 'sent', document_variables_snapshot: snap('NCW-99999999') },
    ]);
    await supersedeOpenNewConstructionWarranty(trx, { templateKey: 'service_agreement.termite_new_construction_warranty', customerId: 'cu', context: ctx, actorId: 't1' });
    expect(updates.map((u) => u.id)).toEqual(['same']);
    expect(updates[0].patch.status).toBe('cancelled');
    expect(events).toHaveLength(1);
  });

  test('refuses a second warranty when the job already has a signed one', async () => {
    const { trx, updates } = fakeTrx([{ id: 'done', status: 'signed', document_variables_snapshot: { warranty: { number: 'NCW-ABCD1234' } } }]);
    await expect(supersedeOpenNewConstructionWarranty(trx, { templateKey: 'service_agreement.termite_new_construction_warranty', customerId: 'cu', context: ctx }))
      .rejects.toMatchObject({ status: 409 });
    expect(updates).toEqual([]);
  });

  test('reads the warranty number from a stored or string snapshot', () => {
    expect(snapshotWarrantyNumber(snap('NCW-1'))).toBe('NCW-1');
    expect(snapshotWarrantyNumber({ warranty: { number: 'NCW-2' } })).toBe('NCW-2');
    expect(snapshotWarrantyNumber('not json')).toBe('');
  });
});

describe('warrantySafeValues', () => {
  const { warrantySafeValues } = require('../services/new-construction-warranty');
  test('flattens job values to one line and drops ** for the warranty only', () => {
    const values = { treatment: { product: 'Termidor SC\n\n**WE ALSO REPAIR ALL DAMAGE.**', gallons: 180 }, list: ['a\nb'] };
    expect(warrantySafeValues('service_agreement.termite_new_construction_warranty', values)).toEqual({
      treatment: { product: 'Termidor SC WE ALSO REPAIR ALL DAMAGE.', gallons: 180 },
      list: ['a b'],
    });
    expect(warrantySafeValues('service_agreement.termite_bond_retreatment', values)).toBe(values);
  });
});
